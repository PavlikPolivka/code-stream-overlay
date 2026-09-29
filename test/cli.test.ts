import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { buildSummary, toMarkdown } from "../src/summary.js";
import { initialState } from "../src/app.js";
import { defaultConfig } from "../src/config/schema.js";
import { TimerCollector, PRESETS } from "../src/collectors/timer.js";
import { rm, sh, tmpRepo, waitFor, write } from "./helpers.js";

const ROOT = path.join(import.meta.dirname, "..");
const CLI = path.join(ROOT, "dist", "cli.js");

function run(cwd: string, ...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, CI: "1" } }, (err, stdout, stderr) =>
      resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
    );
  });
}

describe("summary", () => {
  it("builds and renders a session summary", () => {
    const s = initialState(defaultConfig(), "shop", TimerCollector.initial("abc", "x", PRESETS["90min"], true, 0));
    s.session.phaseIndex = 2;
    s.git = { ...s.git, branch: "main", added: 120, removed: 8, filesChanged: 5, commits: [{ sha: "bbbbbbbbb", subject: "Second", at: 2 }, { sha: "aaaaaaaaa", subject: "First", at: 1 }] };
    s.tests = { ...s.tests, runs: 4, status: "pass", passed: 12, total: 12 };
    s.goals = { ...s.goals, done: 1, total: 2, items: [{ text: "Export", done: true, stretch: false, children: [] }, { text: "Docs", done: false, stretch: false, children: [] }] };
    s.agent.counts = { edits: 7, commands: 3, reads: 9 };
    const x = buildSummary(s, 45 * 60_000);
    expect(x).toMatchObject({ repo: "shop", durationMs: 45 * 60_000, phases: { completed: ["Scope", "Build"], current: "README" }, lines: { added: 120, removed: 8 } });
    expect(x.commits.map((c) => c.subject)).toEqual(["First", "Second"]);
    const md = toMarkdown(x);
    expect(md).toContain("45m");
    expect(md).toContain("Scope → Build · now: README");
    expect(md).toContain("`bbbbbbb` Second");
    expect(md).toContain("- [x] Export");
    expect(md).toContain("7 edits, 3 commands, 9 reads");
  });
});

describe("CLI end to end", () => {
  let dir: string;
  let server: ChildProcess | undefined;
  let banner = "";

  beforeAll(() => {
    execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "ignore", shell: process.platform === "win32" });
    dir = tmpRepo();
    write(dir, ".git/code-stream-overlay/config.json", JSON.stringify({ port: 0, goals: { source: "off" } }));
  }, 60_000);

  afterAll(() => {
    server?.kill("SIGKILL");
    rm(dir);
  });

  it("start prints URLs within 1 s and leaves the tree clean", async () => {
    const t0 = Date.now();
    server = spawn(process.execPath, [CLI, "--no-open"], { cwd: dir, env: { ...process.env, CI: "1" } });
    server.stdout!.on("data", (b) => (banner += b));
    await waitFor(() => banner.includes("Control"), 5000);
    expect(Date.now() - t0).toBeLessThan(process.env.CI ? 3000 : 1000);
    expect(banner).toMatch(/Layout\s+http:\/\/127\.0\.0\.1:\d+\//);
    expect(banner).toContain("Claude Code hooks: not installed");
    expect(sh(dir, "status", "--porcelain")).toBe("");
  });

  it("refuses a second server for the same repo", async () => {
    const r = await run(dir, "--no-open");
    expect(r.code).toBe(1);
    expect(r.out).toContain("already running");
  });

  it("pause / resume / next / summary talk to the running server", async () => {
    expect((await run(dir, "pause")).out).toContain("session paused");
    expect((await run(dir, "resume")).out).toContain("session running");
    expect((await run(dir, "next")).code).toBe(0);
    const s = await run(dir, "summary", "--json");
    expect(JSON.parse(s.out)).toMatchObject({ repo: path.basename(dir), phases: { completed: ["Scope"] } });
  });

  it("stop ends the session and saves the summary; SIGTERM shuts down cleanly", { timeout: 15_000 }, async () => {
    expect((await run(dir, "stop")).out).toContain("session stopped");
    await waitFor(() => existsSync(path.join(dir, ".git", "code-stream-overlay", "sessions")));
    expect(banner).toContain("## Session summary");
    // Windows can't deliver SIGTERM to a handler (Node terminates the process), so no cleanup there.
    server!.kill("SIGTERM");
    await waitFor(() => server!.exitCode !== null || server!.signalCode !== null, 5000);
    if (process.platform !== "win32") expect(existsSync(path.join(dir, ".git", "code-stream-overlay", "server.json"))).toBe(false);
    expect(readdirSync(path.join(dir, ".git", "code-stream-overlay", "sessions"))).toHaveLength(1);
    const last = await run(dir, "summary");
    expect(last.out).toContain("## Session summary");
  });

  it("commands that need a server explain when none runs", async () => {
    const r = await run(dir, "pause");
    expect(r.code).toBe(1);
    expect(r.out).toContain("no code-stream-overlay server is running");
  });

  it("init --yes writes private config; uninstall --purge cleans up", async () => {
    write(dir, "package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
    const r = await run(dir, "init", "--yes");
    expect(r.code).toBe(0);
    const cfg = JSON.parse(readFileSync(path.join(dir, ".git", "code-stream-overlay", "config.json"), "utf8"));
    expect(cfg.port).toBe(0);
    expect(r.out).toContain("Test command: npm test");
    const u = await run(dir, "uninstall", "--purge");
    expect(u.code).toBe(0);
    expect(existsSync(path.join(dir, ".git", "code-stream-overlay"))).toBe(false);
    expect(existsSync(path.join(dir, ".claude"))).toBe(false);
  });

  it("outside a repo and with bad config: clear errors", async () => {
    const r = await run(path.parse(dir).root, "pause");
    expect(r.out).toContain("not inside a git repository");
    write(dir, "code-stream-overlay.json", '{ "tests": { "timeoutSec": "soon" } }');
    const bad = await run(dir, "--no-open");
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("tests.timeoutSec");
    const unknown = await run(dir, "frobnicate");
    expect(unknown.out).toContain('unknown command "frobnicate"');
  });
});
