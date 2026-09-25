import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "../src/state/store.js";
import { initialState } from "../src/app.js";
import { defaultConfig } from "../src/config/schema.js";
import { TimerCollector } from "../src/collectors/timer.js";
import { startServer, type RunningServer } from "../src/server/http.js";
import { webRoot } from "../src/util/paths.js";
import { raw, sse } from "./helpers.js";
import path from "node:path";

const TOKEN = "t0ken";

describe("HTTP server", () => {
  let srv: RunningServer;
  let store: Store;
  const agentBodies: unknown[] = [];

  beforeAll(async () => {
    store = new Store(initialState(defaultConfig(), "repo", TimerCollector.initial("s", "abc", [], true)));
    srv = await startServer({
      store,
      host: "127.0.0.1",
      port: 0,
      token: TOKEN,
      webDir: webRoot(),
      repoName: "repo",
      api: {
        agent: (b) => agentBodies.push(b),
        setState: (k, v) => store.update("custom", (c) => ({ ...c, [k]: v as string })),
      },
    });
  });
  afterAll(() => srv.close());

  it("health needs no auth", async () => {
    const r = await raw(srv.port, "GET", "/api/health");
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ ok: true, repo: "repo" });
  });

  it("serves pages and static files", async () => {
    expect((await raw(srv.port, "GET", "/")).status).toBe(200);
    const w = await raw(srv.port, "GET", "/w/timer");
    expect(w.status).toBe(200);
    expect(w.headers["content-type"]).toContain("text/html");
    expect((await raw(srv.port, "GET", "/w/nope")).status).toBe(404);
    const js = await raw(srv.port, "GET", "/static/js/core.js");
    expect(js.headers["content-type"]).toContain("javascript");
    expect((await raw(srv.port, "GET", "/i18n/plain.json")).status).toBe(200);
  });

  it("rejects path traversal", async () => {
    for (const p of ["/static/../package.json", "/static/%2e%2e/package.json", "/themes/..%2f..%2fpackage.json", "/static/..%5c..%5cpackage.json"]) {
      const r = await raw(srv.port, "GET", p);
      expect(r.status, p).toBe(404);
    }
  });

  it("rejects foreign Host headers", async () => {
    const r = await raw(srv.port, "GET", "/api/state", { headers: { host: "evil.example:80" } });
    expect(r.status).toBe(403);
    const ok = await raw(srv.port, "GET", "/api/state", { headers: { host: `localhost:${srv.port}` } });
    expect(ok.status).toBe(200);
  });

  it("read routes are open on loopback; write routes need the token", async () => {
    expect((await raw(srv.port, "GET", "/api/state")).status).toBe(200);
    const body = JSON.stringify({ type: "done" });
    expect((await raw(srv.port, "POST", "/api/agent", { body })).status).toBe(401);
    expect((await raw(srv.port, "POST", "/api/agent", { body, headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect((await raw(srv.port, "POST", "/api/agent", { body, headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    expect((await raw(srv.port, "POST", `/api/agent?token=${TOKEN}`, { body })).status).toBe(200);
    expect(agentBodies).toHaveLength(2);
  });

  it("limits bodies to 64 KB and validates JSON", async () => {
    const big = JSON.stringify({ x: "a".repeat(70_000) });
    const r = await raw(srv.port, "POST", "/api/agent", { body: big, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.status).toBe(413);
    const bad = await raw(srv.port, "POST", "/api/agent", { body: "{", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(bad.status).toBe(400);
  });

  it("unimplemented handlers answer 501; wrong methods 405", async () => {
    expect((await raw(srv.port, "POST", "/api/tests/run", { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(501);
    expect((await raw(srv.port, "DELETE", "/api/state")).status).toBe(405);
  });

  it("SSE sends retry, snapshot, then slices and fx", async () => {
    const p = sse(srv.port, (ev) => ev.some((e) => e.event === "fx"));
    await new Promise((r) => setTimeout(r, 100));
    await raw(srv.port, "POST", "/api/state", {
      body: JSON.stringify({ key: "coffee", value: 3 }),
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    store.fx("commit", { subject: "hello" });
    const events = await p;
    expect(events.map((e) => e.event)).toEqual(["retry", "snapshot", "slice", "fx"]);
    expect(JSON.parse(events[1].data).project.name).toBe("repo");
    expect(JSON.parse(events[2].data)).toEqual({ key: "custom", value: { coffee: 3 } });
    expect(JSON.parse(events[3].data)).toEqual({ name: "commit", payload: { subject: "hello" } });
  });
});

describe("user CSS files", () => {
  it("serves only the files named in the config", async () => {
    const store = new Store(initialState(defaultConfig(), "repo", TimerCollector.initial("s", "abc", [], true)));
    const css = path.join(webRoot(), "themes", "minimal.css");
    const srv = await startServer({ store, host: "127.0.0.1", port: 0, token: TOKEN, webDir: webRoot(), repoName: "r", api: {}, userFiles: { "theme.css": css } });
    try {
      const ok = await raw(srv.port, "GET", "/user/theme.css");
      expect(ok.status).toBe(200);
      expect(ok.headers["content-type"]).toContain("text/css");
      expect((await raw(srv.port, "GET", "/user/extra.css")).status).toBe(404);
      expect((await raw(srv.port, "GET", "/user/constructor")).status).toBe(404);
    } finally {
      await srv.close();
    }
  });
});

describe("non-loopback bind", () => {
  it("requires the token on read routes", async () => {
    const store = new Store(initialState(defaultConfig(), "repo", TimerCollector.initial("s", "abc", [], true)));
    const srv = await startServer({ store, host: "0.0.0.0", port: 0, token: TOKEN, webDir: webRoot(), repoName: "r", api: {} });
    try {
      expect((await raw(srv.port, "GET", "/api/state")).status).toBe(401);
      expect((await raw(srv.port, "GET", `/api/state?token=${TOKEN}`)).status).toBe(200);
      expect((await raw(srv.port, "GET", "/api/health")).status).toBe(200);
    } finally {
      await srv.close();
    }
  });
});
