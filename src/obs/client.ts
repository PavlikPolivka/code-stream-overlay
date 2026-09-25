import { createHash, randomUUID } from "node:crypto";

/** obs-websocket v5 opcodes. */
const OP = { Hello: 0, Identify: 1, Identified: 2, Request: 6, RequestResponse: 7 } as const;
const CLOSE_AUTH_FAILED = 4009;
const CLOSE_UNSUPPORTED_RPC = 4010;
const DEFAULT_TIMEOUT_MS = 5000;

export class ObsError extends Error {
  constructor(
    message: string,
    public code?: number,
  ) {
    super(message);
    this.name = "ObsError";
  }
}

/** OBS request failed (requestStatus.result false). 600 = resource not found. */
export class ObsRequestError extends ObsError {}

export const sha256b64 = (s: string) => createHash("sha256").update(s).digest("base64");

/** auth = base64(sha256(base64(sha256(password + salt)) + challenge)) */
export function authString(password: string, salt: string, challenge: string): string {
  return sha256b64(sha256b64(password + salt) + challenge);
}

export interface ObsConnectOptions {
  host: string;
  port: number;
  /** Called only when OBS asks for authentication. */
  password?: () => Promise<string | undefined> | string | undefined;
  timeoutMs?: number;
}

interface Pending {
  resolve(v: Record<string, unknown>): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
}

export class ObsClient {
  private pending = new Map<string, Pending>();
  private closed = false;

  private constructor(
    private ws: WebSocket,
    private timeoutMs: number,
  ) {
    ws.addEventListener("message", (e) => this.onMessage(String(e.data)));
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new ObsError("connection to OBS closed"));
      }
      this.pending.clear();
    });
  }

  static async connect(o: ObsConnectOptions): Promise<ObsClient> {
    const url = `ws://${o.host}:${o.port}`;
    const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const unreachable = () =>
      new ObsError(
        `can't reach OBS at ${url}. Is OBS running, with Tools → WebSocket Server Settings → "Enable WebSocket server" on?`,
      );

    return new Promise<ObsClient>((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url, "obswebsocket.json");
      } catch {
        reject(unreachable());
        return;
      }
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(e);
      };
      const timer = setTimeout(() => fail(new ObsError(`OBS at ${url} did not answer within ${timeoutMs / 1000}s`)), timeoutMs);
      ws.addEventListener("error", () => fail(unreachable()));
      ws.addEventListener("close", (e) => {
        if (e.code === CLOSE_AUTH_FAILED) fail(new ObsError("OBS rejected the password (Tools → WebSocket Server Settings → Show Connect Info).", e.code));
        else if (e.code === CLOSE_UNSUPPORTED_RPC) fail(new ObsError("this OBS version speaks an unsupported obs-websocket RPC version; OBS 28 or newer is required.", e.code));
        else fail(new ObsError(`OBS closed the connection (${e.code}${e.reason ? `: ${e.reason}` : ""})`, e.code));
      });
      ws.addEventListener("message", async (e) => {
        if (settled) return;
        let msg: { op: number; d: Record<string, unknown> };
        try {
          msg = JSON.parse(String(e.data));
        } catch {
          return fail(new ObsError("OBS sent something that isn't obs-websocket JSON"));
        }
        if (msg.op === OP.Hello) {
          const d: Record<string, unknown> = { rpcVersion: 1, eventSubscriptions: 0 };
          const auth = msg.d.authentication as { challenge: string; salt: string } | undefined;
          if (auth) {
            const pw = await o.password?.();
            if (!pw) return fail(new ObsError("OBS asks for a password: pass --obs-password or set STREAM_OVERLAY_OBS_PASSWORD."));
            d.authentication = authString(pw, auth.salt, auth.challenge);
          }
          ws.send(JSON.stringify({ op: OP.Identify, d }));
        } else if (msg.op === OP.Identified) {
          settled = true;
          clearTimeout(timer);
          resolve(new ObsClient(ws, timeoutMs));
        }
      });
    });
  }

  request<T = Record<string, unknown>>(requestType: string, requestData?: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new ObsError("connection to OBS closed"));
    const requestId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new ObsError(`OBS did not answer ${requestType} within ${this.timeoutMs / 1000}s`));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve: resolve as (v: Record<string, unknown>) => void, reject, timer });
      this.ws.send(JSON.stringify({ op: OP.Request, d: { requestType, requestId, ...(requestData ? { requestData } : {}) } }));
    });
  }

  close(): void {
    this.closed = true;
    try {
      this.ws.close(1000);
    } catch {
      /* ignore */
    }
  }

  private onMessage(raw: string) {
    let msg: { op: number; d: Record<string, unknown> };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.op !== OP.RequestResponse) return;
    const d = msg.d as {
      requestId: string;
      requestType: string;
      requestStatus: { result: boolean; code: number; comment?: string };
      responseData?: Record<string, unknown>;
    };
    const p = this.pending.get(d.requestId);
    if (!p) return;
    this.pending.delete(d.requestId);
    clearTimeout(p.timer);
    if (d.requestStatus.result) p.resolve(d.responseData ?? {});
    else
      p.reject(
        new ObsRequestError(
          `${d.requestType} failed (${d.requestStatus.code})${d.requestStatus.comment ? `: ${d.requestStatus.comment}` : ""}`,
          d.requestStatus.code,
        ),
      );
  }
}
