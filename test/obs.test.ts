import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ObsClient, ObsError, ObsRequestError, authString } from "../src/obs/client.js";
import { computeLayout, installSources, uninstallSources } from "../src/obs/install.js";
import { MockObs } from "./mock-obs.js";
import { rm, tmpDir } from "./helpers.js";

const mocks: MockObs[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const m of mocks.splice(0)) await m.stop();
  for (const d of dirs.splice(0)) rm(d);
});

async function mock(opts: { password?: string } = {}) {
  const m = new MockObs(opts);
  mocks.push(m);
  await m.start();
  return m;
}

const DEFAULT_WIDGETS = ["now", "timer", "git", "tests", "goals", "agent", "commits"];

describe("auth", () => {
  it("matches the obs-websocket reference computation", () => {
    // Example from the obs-websocket protocol docs.
    expect(authString("supersecretpassword", "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=", "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=")).toBe(
      "1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=",
    );
  });
});

describe("ObsClient", () => {
  it("connects without auth and makes requests", async () => {
    const m = await mock();
    const c = await ObsClient.connect({ host: "127.0.0.1", port: m.port });
    expect(await c.request("GetVideoSettings")).toMatchObject({ baseWidth: 1920 });
    await expect(c.request("Nope")).rejects.toBeInstanceOf(ObsRequestError);
    c.close();
  });

  it("authenticates with the right password", async () => {
    const m = await mock({ password: "s3cret" });
    const c = await ObsClient.connect({ host: "127.0.0.1", port: m.port, password: () => "s3cret" });
    expect(await c.request("GetCurrentProgramScene")).toMatchObject({ sceneName: "Coding" });
    c.close();
  });

  it("explains a wrong or missing password", async () => {
    const m = await mock({ password: "s3cret" });
    await expect(ObsClient.connect({ host: "127.0.0.1", port: m.port, password: () => "nope" })).rejects.toThrow(/rejected the password/);
    await expect(ObsClient.connect({ host: "127.0.0.1", port: m.port })).rejects.toThrow(/asks for a password/);
  });

  it("explains when OBS is not running", async () => {
    const m = await mock();
    const port = m.port;
    await m.stop();
    mocks.length = 0;
    const e = await ObsClient.connect({ host: "127.0.0.1", port, timeoutMs: 2000 }).catch((x) => x);
    expect(e).toBeInstanceOf(ObsError);
    expect(e.message).toMatch(/can't reach OBS.*WebSocket server/);
  });
});

describe("computeLayout", () => {
  it("places widgets in their slots and stacks shared slots", () => {
    const boxes = Object.fromEntries(computeLayout(DEFAULT_WIDGETS, {}).map((b) => [b.widget, b]));
    expect(boxes.now).toEqual({ widget: "now", x: 32, y: 32, w: 900, h: 90 });
    expect(boxes.timer).toMatchObject({ x: 1920 - 32 - 360, y: 32 });
    expect(boxes.git).toMatchObject({ x: 1528, y: 200 });
    expect(boxes.tests).toMatchObject({ x: 1528, y: 200 + 140 + 12 });
    expect(boxes.commits).toEqual({ widget: "commits", x: 0, y: 1032, w: 1920, h: 48 });
    expect(boxes.agent).toMatchObject({ x: 460, y: 1080 - 48 - 32 - 70 });
  });

  it("honours explicit placement and slot overrides", () => {
    const boxes = computeLayout(["goals", "file"], { goals: { x: 10, y: 20, w: 300, h: 200 }, file: { slot: "top-left" } });
    expect(boxes).toEqual([
      { widget: "goals", x: 10, y: 20, w: 300, h: 200 },
      { widget: "file", x: 32, y: 32, w: 600, h: 200 },
    ]);
  });
});

describe("install / uninstall", () => {
  async function setup(canvas?: { baseWidth: number; baseHeight: number }) {
    const m = await mock();
    if (canvas) m.canvas = canvas;
    const c = await ObsClient.connect({ host: "127.0.0.1", port: m.port });
    const stateDir = tmpDir();
    dirs.push(stateDir);
    const opts = { baseUrl: "http://127.0.0.1:4747", widgets: DEFAULT_WIDGETS, layout: {}, mode: "widgets" as const, stateDir };
    return { m, c, opts, stateDir };
  }

  it("creates sources in the current scene at the right positions", async () => {
    const { m, c, opts, stateDir } = await setup();
    const r = await installSources(c, opts);
    expect(r).toMatchObject({ scene: "Coding", created: DEFAULT_WIDGETS.map((w) => `so · ${w}`), updated: [] });
    const tests = m.inputs.get("so · tests")!;
    expect(tests.inputKind).toBe("browser_source");
    expect(tests.inputSettings).toMatchObject({ url: "http://127.0.0.1:4747/w/tests", width: 360, height: 140, shutdown: false, restart_when_active: false });
    const item = m.scenes.get("Coding")!.find((i) => i.sourceName === "so · tests")!;
    expect(item.transform).toEqual({ positionX: 1528, positionY: 352, scaleX: 1, scaleY: 1 });
    expect(JSON.parse(readFileSync(path.join(stateDir, "obs.json"), "utf8"))).toEqual({ scene: "Coding", inputs: DEFAULT_WIDGETS.map((w) => `so · ${w}`) });
    c.close();
  });

  it("is idempotent: a second run updates instead of duplicating", async () => {
    const { m, c, opts } = await setup();
    await installSources(c, opts);
    const r = await installSources(c, { ...opts, baseUrl: "http://127.0.0.1:4748" });
    expect(r.created).toEqual([]);
    expect(r.updated).toHaveLength(DEFAULT_WIDGETS.length);
    expect(m.inputs.size).toBe(DEFAULT_WIDGETS.length);
    expect(m.scenes.get("Coding")).toHaveLength(DEFAULT_WIDGETS.length);
    expect(m.inputs.get("so · git")!.inputSettings.url).toBe("http://127.0.0.1:4748/w/git");
    c.close();
  });

  it("adds existing sources to another scene and scales to the canvas", async () => {
    const { m, c, opts } = await setup({ baseWidth: 2560, baseHeight: 1440 });
    await installSources(c, opts);
    await installSources(c, { ...opts, scene: "BRB" });
    expect(m.inputs.size).toBe(DEFAULT_WIDGETS.length);
    const item = m.scenes.get("BRB")!.find((i) => i.sourceName === "so · timer")!;
    expect(item.transform.positionX).toBeCloseTo(1528 * (2560 / 1920));
    expect(item.transform.scaleX).toBeCloseTo(2560 / 1920);
    c.close();
  });

  it("single mode creates one full-canvas source", async () => {
    const { m, c, opts } = await setup();
    await installSources(c, { ...opts, mode: "single", token: "t k" });
    expect([...m.inputs.keys()]).toEqual(["so · layout"]);
    expect(m.inputs.get("so · layout")!.inputSettings).toMatchObject({ url: "http://127.0.0.1:4747/?token=t%20k", width: 1920, height: 1080 });
    c.close();
  });

  it("uninstall removes recorded sources, ignores missing ones, deletes obs.json", async () => {
    const { m, c, opts, stateDir } = await setup();
    await installSources(c, opts);
    await c.request("RemoveInput", { inputName: "so · now" }); // user deleted one by hand
    const removed = await uninstallSources(c, stateDir);
    expect(removed).toHaveLength(DEFAULT_WIDGETS.length - 1);
    expect(m.inputs.size).toBe(0);
    expect(existsSync(path.join(stateDir, "obs.json"))).toBe(false);
    c.close();
  });
});

describe("stream-overlay obs install (CLI)", () => {
  it("installs and uninstalls through the built CLI, password from env", async () => {
    const { execFileSync, execFile } = await import("node:child_process");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpRepo } = await import("./helpers.js");
    const root = path.join(import.meta.dirname, "..");
    execFileSync("npm", ["run", "build"], { cwd: root, stdio: "ignore", shell: process.platform === "win32" });
    const m = await mock({ password: "pw" });
    const repo = tmpRepo();
    dirs.push(repo);
    mkdirSync(path.join(repo, ".git", "stream-overlay"), { recursive: true });
    writeFileSync(path.join(repo, ".git", "stream-overlay", "config.json"), JSON.stringify({ obs: { port: m.port } }));
    const run = (...args: string[]) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        execFile(process.execPath, [path.join(root, "dist", "cli.js"), ...args], { cwd: repo, env: { ...process.env, STREAM_OVERLAY_OBS_PASSWORD: "pw" } }, (err, stdout, stderr) =>
          resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
        );
      });
    const inst = await run("obs", "install");
    expect(inst.code).toBe(0);
    expect(inst.out).toContain('7 created, 0 updated in scene "Coding"');
    expect(inst.out).toContain("Custom Browser Docks");
    expect(m.inputs.size).toBe(7);
    const again = await run("obs", "install");
    expect(again.out).toContain("0 created, 7 updated");
    const un = await run("obs", "uninstall");
    expect(un.code).toBe(0);
    expect(m.inputs.size).toBe(0);
  }, 60_000);
});
