// Minimal in-process obs-websocket v5 server over a hand-rolled RFC 6455 transport.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { authString } from "../src/obs/client.js";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  if (len >= 126) {
    head[0] = 0x80 | opcode;
    if (len < 65536) {
      head[1] = 126;
      head.writeUInt16BE(len, 2);
    } else {
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
  }
  return Buffer.concat([head, payload]);
}

/** Parse complete client frames from `buf`; returns [frames, rest]. */
function parse(buf: Buffer): [{ opcode: number; data: Buffer }[], Buffer] {
  const out: { opcode: number; data: Buffer }[] = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const opcode = buf[off] & 0x0f;
    const masked = (buf[off + 1] & 0x80) !== 0;
    let len = buf[off + 1] & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length < p + 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length < p + 8) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length < p + maskLen + len) break;
    const mask = buf.subarray(p, p + maskLen);
    const data = Buffer.from(buf.subarray(p + maskLen, p + maskLen + len));
    if (masked) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    out.push({ opcode, data });
    off = p + maskLen + len;
  }
  return [out, buf.subarray(off)];
}

export interface MockInput {
  inputName: string;
  inputKind: string;
  inputSettings: Record<string, unknown>;
}

export interface MockItem {
  sceneItemId: number;
  sourceName: string;
  transform: Record<string, number>;
}

export class MockObs {
  server: Server;
  port = 0;
  password?: string;
  canvas = { baseWidth: 1920, baseHeight: 1080 };
  currentScene = "Coding";
  scenes = new Map<string, MockItem[]>([
    ["Coding", []],
    ["BRB", []],
  ]);
  inputs = new Map<string, MockInput>();
  requests: string[] = [];
  private nextId = 1;
  private sockets = new Set<Duplex>();

  constructor(opts: { password?: string } = {}) {
    this.password = opts.password;
    this.server = createServer((_q, res) => res.writeHead(426).end());
    this.server.on("upgrade", (req, socket) => this.upgrade(req.headers, socket));
  }

  async start(): Promise<number> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as { port: number }).port;
    return this.port;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private upgrade(headers: Record<string, string | string[] | undefined>, socket: Duplex) {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => {});
    const key = String(headers["sec-websocket-key"]);
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    const proto = String(headers["sec-websocket-protocol"] ?? "").includes("obswebsocket.json") ? "Sec-WebSocket-Protocol: obswebsocket.json\r\n" : "";
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${proto}\r\n`);

    const challenge = "chal-" + Math.random().toString(36).slice(2);
    const salt = "salt-" + Math.random().toString(36).slice(2);
    const write = (b: Buffer) => {
      if (!socket.writableEnded && !socket.destroyed) socket.write(b);
    };
    const send = (o: unknown) => write(frame(1, Buffer.from(JSON.stringify(o))));
    const close = (code: number, reason: string) => {
      const b = Buffer.alloc(2 + Buffer.byteLength(reason));
      b.writeUInt16BE(code, 0);
      b.write(reason, 2);
      write(frame(8, b));
      socket.end();
    };
    send({ op: 0, d: { obsWebSocketVersion: "5.5.0", rpcVersion: 1, ...(this.password ? { authentication: { challenge, salt } } : {}) } });

    let buf: Buffer = Buffer.alloc(0);
    let identified = false;
    socket.on("data", (chunk: Buffer) => {
      const [frames, rest] = parse(Buffer.concat([buf, chunk]));
      buf = rest;
      for (const f of frames) {
        if (f.opcode === 8) {
          write(frame(8, f.data.subarray(0, 2)));
          socket.end();
          return;
        }
        if (f.opcode !== 1) continue;
        const msg = JSON.parse(f.data.toString("utf8"));
        if (msg.op === 1) {
          if (this.password && msg.d.authentication !== authString(this.password, salt, challenge)) return close(4009, "Authentication failed.");
          identified = true;
          send({ op: 2, d: { negotiatedRpcVersion: 1 } });
        } else if (msg.op === 6 && identified) {
          const { requestType, requestId, requestData } = msg.d;
          this.requests.push(requestType);
          let status = { result: true, code: 100 } as { result: boolean; code: number; comment?: string };
          let responseData: unknown;
          try {
            responseData = this.handle(requestType, requestData ?? {});
          } catch (e) {
            const [code, comment] = (e as Error).message.split("|");
            status = { result: false, code: Number(code), comment };
          }
          send({ op: 7, d: { requestType, requestId, requestStatus: status, ...(responseData ? { responseData } : {}) } });
        }
      }
    });
  }

  private scene(name: string): MockItem[] {
    const s = this.scenes.get(name);
    if (!s) throw new Error(`600|No source was found by the name of \`${name}\`.`);
    return s;
  }

  private handle(type: string, d: Record<string, any>): unknown {
    switch (type) {
      case "GetVideoSettings":
        return { ...this.canvas, outputWidth: this.canvas.baseWidth, outputHeight: this.canvas.baseHeight, fpsNumerator: 60, fpsDenominator: 1 };
      case "GetCurrentProgramScene":
        return { sceneName: this.currentScene, currentProgramSceneName: this.currentScene };
      case "GetInputList":
        return { inputs: [...this.inputs.values()].filter((i) => !d.inputKind || i.inputKind === d.inputKind).map((i) => ({ inputName: i.inputName, inputKind: i.inputKind })) };
      case "CreateInput": {
        if (this.inputs.has(d.inputName)) throw new Error("601|A source already exists by that input name.");
        const items = this.scene(d.sceneName);
        this.inputs.set(d.inputName, { inputName: d.inputName, inputKind: d.inputKind, inputSettings: d.inputSettings ?? {} });
        const sceneItemId = this.nextId++;
        items.push({ sceneItemId, sourceName: d.inputName, transform: {} });
        return { inputUuid: `uuid-${sceneItemId}`, sceneItemId };
      }
      case "SetInputSettings": {
        const i = this.inputs.get(d.inputName);
        if (!i) throw new Error("600|No source was found.");
        i.inputSettings = { ...i.inputSettings, ...d.inputSettings };
        return undefined;
      }
      case "GetSceneItemId": {
        const item = this.scene(d.sceneName).find((x) => x.sourceName === d.sourceName);
        if (!item) throw new Error("600|No scene items were found in the specified scene by that name or offset.");
        return { sceneItemId: item.sceneItemId };
      }
      case "CreateSceneItem": {
        if (!this.inputs.has(d.sourceName)) throw new Error("600|No source was found.");
        const sceneItemId = this.nextId++;
        this.scene(d.sceneName).push({ sceneItemId, sourceName: d.sourceName, transform: {} });
        return { sceneItemId };
      }
      case "SetSceneItemTransform": {
        const item = this.scene(d.sceneName).find((x) => x.sceneItemId === d.sceneItemId);
        if (!item) throw new Error("600|No scene item.");
        item.transform = { ...item.transform, ...d.sceneItemTransform };
        return undefined;
      }
      case "RemoveInput": {
        if (!this.inputs.delete(d.inputName)) throw new Error("600|No source was found by the name.");
        for (const items of this.scenes.values()) {
          const idx = items.findIndex((x) => x.sourceName === d.inputName);
          if (idx >= 0) items.splice(idx, 1);
        }
        return undefined;
      }
      default:
        throw new Error(`204|Your request type is not valid.`);
    }
  }
}
