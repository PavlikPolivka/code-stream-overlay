import { createServer, type Server } from "node:http";
import { PORT_ATTEMPTS } from "../constants.js";
import type { Store } from "../state/store.js";
import { log } from "../util/log.js";
import { listenWithFallback } from "../util/ports.js";
import { hostAllowed, isLoopback, requestToken, tokensEqual } from "./auth.js";
import { HttpError, json, match, type Api } from "./routes.js";
import { SseHub } from "./sse.js";

export interface ServerOptions {
  store: Store;
  host: string;
  port: number;
  token: string;
  webDir: string;
  repoName: string;
  api: Api;
  /** Extra files served at /user/<name> (theme or CSS from the config). */
  userFiles?: Record<string, string>;
}

export interface RunningServer {
  server: Server;
  port: number;
  hub: SseHub;
  close(): Promise<void>;
}

export async function startServer(o: ServerOptions): Promise<RunningServer> {
  const hub = new SseHub(o.store);
  const loopback = isLoopback(o.host);
  let port = 0;
  const ctx = { store: o.store, hub, webDir: o.webDir, repoName: o.repoName, api: o.api, userFiles: o.userFiles ?? {} };

  const server = createServer(async (req, res) => {
    try {
      if (!hostAllowed(req.headers.host, o.host, port)) throw new HttpError(403, "forbidden host");
      const url = new URL(req.url ?? "/", "http://x");
      const found = match(req.method ?? "GET", url.pathname);
      if (found === "method") throw new HttpError(405, "method not allowed");
      if (!found) throw new HttpError(404, "not found");
      const { route, m } = found;
      const needsToken = route.access === "write" || (route.access === "read" && !loopback);
      if (needsToken) {
        const t = requestToken(req, url);
        if (!t || !tokensEqual(t, o.token)) throw new HttpError(401, "unauthorized");
      }
      await route.handle(ctx, req, res, m);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log.debug("request failed", e);
      if (!res.headersSent) json(res, status, { ok: false, error: e instanceof Error ? e.message : String(e) });
      else res.end();
    }
  });
  server.keepAliveTimeout = 5000;
  port = await listenWithFallback(server, o.host, o.port, PORT_ATTEMPTS);

  return {
    server,
    port,
    hub,
    close: () =>
      new Promise<void>((resolve) => {
        hub.close();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
