import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { VERSION, WIDGETS } from "../constants.js";
import type { Store } from "../state/store.js";
import type { SseHub } from "./sse.js";
import { safeJoin, sendFile } from "./static.js";

export const BODY_LIMIT = 64 * 1024;

/** Handlers the running app provides; missing ones answer 501. */
export interface Api {
  agent?(body: unknown): void;
  setState?(key: string, value: unknown): void;
  session?(action: string): void;
  runTests?(): void;
  summary?(): unknown;
}

export interface RouteContext {
  store: Store;
  hub: SseHub;
  webDir: string;
  repoName: string;
  api: Api;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(s);
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const len = Number(req.headers["content-length"] ?? 0);
  if (len > BODY_LIMIT) throw new HttpError(413, "body too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > BODY_LIMIT) throw new HttpError(413, "body too large");
    chunks.push(c);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

type Access = "none" | "read" | "write";
interface Route {
  method: string;
  pattern: RegExp;
  access: Access;
  handle(ctx: RouteContext, req: IncomingMessage, res: ServerResponse, m: RegExpExecArray): Promise<void> | void;
}

const need = <T>(fn: T | undefined): T => {
  if (!fn) throw new HttpError(501, "not available");
  return fn;
};

const SESSION_ACTIONS = new Set(["start", "pause", "resume", "next", "stop"]);
const widgetRe = new RegExp(`^/w/(${WIDGETS.join("|")})/?$`);

export const routes: Route[] = [
  {
    method: "GET",
    pattern: /^\/$/,
    access: "read",
    handle: (c, _q, res) => page(res, path.join(c.webDir, "index.html")),
  },
  {
    method: "GET",
    pattern: widgetRe,
    access: "read",
    handle: (c, _q, res) => page(res, path.join(c.webDir, "widget.html")),
  },
  {
    method: "GET",
    pattern: /^\/control\/?$/,
    access: "read",
    handle: (c, _q, res) => page(res, path.join(c.webDir, "control.html")),
  },
  { method: "GET", pattern: /^\/events$/, access: "read", handle: (c, _q, res) => c.hub.add(res) },
  { method: "GET", pattern: /^\/api\/state$/, access: "read", handle: (c, _q, res) => json(res, 200, c.store.get()) },
  {
    method: "GET",
    pattern: /^\/api\/health$/,
    access: "none",
    handle: (c, _q, res) => json(res, 200, { ok: true, repo: c.repoName, version: VERSION, pid: process.pid }),
  },
  {
    method: "GET",
    pattern: /^\/api\/summary$/,
    access: "read",
    handle: (c, _q, res) => json(res, 200, need(c.api.summary)()),
  },
  {
    method: "POST",
    pattern: /^\/api\/agent$/,
    access: "write",
    handle: async (c, req, res) => {
      const body = await readJson(req);
      need(c.api.agent)(body);
      json(res, 200, { ok: true });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/state$/,
    access: "write",
    handle: async (c, req, res) => {
      const body = (await readJson(req)) as { key?: unknown; value?: unknown };
      if (typeof body?.key !== "string" || !body.key) throw new HttpError(400, "key required");
      if (typeof body.value !== "string" && typeof body.value !== "number" && body.value !== null)
        throw new HttpError(400, "value must be string, number or null");
      need(c.api.setState)(body.key, body.value);
      json(res, 200, { ok: true });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/session\/([a-z]+)$/,
    access: "write",
    handle: (c, _q, res, m) => {
      if (!SESSION_ACTIONS.has(m[1])) throw new HttpError(404, "unknown action");
      need(c.api.session)(m[1]);
      json(res, 200, { ok: true, session: c.store.get("session") });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/tests\/run$/,
    access: "write",
    handle: (c, _q, res) => {
      need(c.api.runTests)();
      json(res, 202, { ok: true });
    },
  },
  {
    method: "GET",
    pattern: /^\/(static|themes|i18n)\/(.+)$/,
    access: "none",
    handle: async (c, _q, res, m) => {
      const base = m[1] === "static" ? c.webDir : path.join(c.webDir, m[1]);
      const file = safeJoin(base, m[2]);
      if (!file || !(await sendFile(res, file))) throw new HttpError(404, "not found");
    },
  },
];

async function page(res: ServerResponse, file: string) {
  if (!(await sendFile(res, file))) throw new HttpError(404, "not found");
}

export function match(method: string, pathname: string): { route: Route; m: RegExpExecArray } | "method" | undefined {
  let methodMismatch = false;
  for (const route of routes) {
    const m = route.pattern.exec(pathname);
    if (!m) continue;
    if (route.method === method || (method === "HEAD" && route.method === "GET")) return { route, m };
    methodMismatch = true;
  }
  return methodMismatch ? "method" : undefined;
}
