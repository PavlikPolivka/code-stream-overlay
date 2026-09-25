import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function tmpDir(prefix = "so-test-"): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function rm(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A temp git repo with a deterministic identity. */
export function tmpRepo(opts: { commit?: boolean } = {}): string {
  const dir = tmpDir("so-repo-");
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "commit.gpgsign", "false");
  if (opts.commit !== false) {
    write(dir, "README.md", "hello\n");
    sh(dir, "add", ".");
    sh(dir, "commit", "-q", "-m", "init");
  }
  return dir;
}

export function write(dir: string, rel: string, content: string): void {
  const p = path.join(dir, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** HTTP request with full control over headers (fetch refuses to set Host). */
export function raw(
  port: number,
  method: string,
  p: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...opts.headers } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

export interface SseEvent {
  event: string;
  data: string;
}

/** Collect SSE events until `until` returns true. */
export function sse(
  port: number,
  until: (events: SseEvent[]) => boolean,
  timeoutMs = 3000,
  p = "/events",
): Promise<SseEvent[]> {
  return new Promise((resolve, reject) => {
    const events: SseEvent[] = [];
    let buf = "";
    const req = request({ host: "127.0.0.1", port, path: p, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        buf += c;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev: SseEvent = { event: "message", data: "" };
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) ev.event = line.slice(7);
            else if (line.startsWith("data: ")) ev.data += line.slice(6);
            else if (line.startsWith("retry: ")) ev.event = "retry";
          }
          events.push(ev);
          if (until(events)) {
            clearTimeout(t);
            req.destroy();
            resolve(events);
            return;
          }
        }
      });
    });
    const t = setTimeout(() => {
      req.destroy();
      reject(new Error(`SSE timeout; got ${JSON.stringify(events.map((e) => e.event))}`));
    }, timeoutMs);
    req.on("error", (e) => {
      if (!events.length) reject(e);
    });
    req.end();
  });
}

/** Poll until `fn` returns truthy. */
export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 3000, stepMs = 25): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`waitFor timed out${last ? `: ${(last as Error).message}` : ""}`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
