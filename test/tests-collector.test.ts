import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, utimesSync, existsSync } from "node:fs";
import path from "node:path";
import { createApp, type App } from "../src/app.js";
import { mergeLayers } from "../src/config/load.js";
import { resolveRepo } from "../src/util/paths.js";
import { ADAPTERS, detectStacks, type AdapterContext } from "../src/collectors/tests/adapters/index.js";
import { resolvePlan } from "../src/collectors/tests/collector.js";
import { defaultConfig } from "../src/config/schema.js";
import type { Fx } from "../src/state/types.js";
import { rm, sh, tmpDir, tmpRepo, waitFor, write } from "./helpers.js";

const FX = path.join(import.meta.dirname, "fixtures");
const apps: App[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const d of dirs.splice(0)) rm(d);
});

function repo(files: Record<string, string> = {}) {
  const d = tmpRepo();
  dirs.push(d);
  for (const [k, v] of Object.entries(files)) write(d, k, v);
  if (Object.keys(files).length) {
    sh(d, "add", ".");
    sh(d, "commit", "-q", "-m", "setup");
  }
  return d;
}

async function boot(dir: string, data: Record<string, unknown> = {}) {
  const app = await createApp(await resolveRepo(dir), mergeLayers([{ source: "test", data: { port: 0, ...data } }]));
  apps.push(app);
  const fx: Fx[] = [];
  app.store.subscribe((e) => e.type === "fx" && fx.push(e.fx));
  await new Promise((r) => setTimeout(r, 300));
  return { app, fx };
}

function copyReports(dir: string, variant: "maven-pass" | "maven-fail", mtime?: Date) {
  const target = path.join(dir, "target", "surefire-reports");
  mkdirSync(target, { recursive: true });
  for (const f of readdirSync(path.join(FX, "junit", variant))) {
    copyFileSync(path.join(FX, "junit", variant, f), path.join(target, f));
    if (mtime) utimesSync(path.join(target, f), mtime, mtime);
  }
}

describe("adapter detection", () => {
  const ctx = (root: string): AdapterContext => ({ root, stateDir: path.join(root, ".git", "stream-overlay"), platform: "linux" });

  it.each([
    [{ "pom.xml": "<project/>" }, ["maven"]],
    [{ "settings.gradle.kts": "" }, ["gradle"]],
    [{ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) }, ["node"]],
    [{ "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }, []],
    [{ "pyproject.toml": "" }, ["python"]],
    [{ "go.mod": "module x" }, ["go"]],
    [{ "Cargo.toml": "" }, ["rust"]],
    [{ "Shop.csproj": "" }, ["dotnet"]],
    [{ Makefile: "build:\n\ttrue\ntest:\n\ttrue\n" }, ["make"]],
    [{ Makefile: "build:\n\ttrue\n" }, []],
    [{ "pom.xml": "", "package.json": JSON.stringify({ scripts: { test: "jest" } }) }, ["maven", "node"]],
  ])("%j → %j", async (files, ids) => {
    const d = tmpDir();
    dirs.push(d);
    for (const [k, v] of Object.entries(files)) write(d, k, v);
    expect((await detectStacks(d)).map((a) => a.id)).toEqual(ids);
  });

  it("prefers wrappers and lockfiles", () => {
    const d = tmpDir();
    dirs.push(d);
    const byId = (id: string) => ADAPTERS.find((a) => a.id === id)!;
    expect(byId("maven").command(ctx(d))).toBe("mvn -q test");
    write(d, "mvnw", "");
    expect(byId("maven").command(ctx(d))).toBe("./mvnw -q test");
    expect(byId("maven").command({ ...ctx(d), platform: "win32" })).toBe("mvn -q test");
    write(d, "pnpm-lock.yaml", "");
    expect(byId("node").command(ctx(d))).toBe("pnpm test");
    expect(byId("python").command(ctx(d))).toBe("pytest -q --junitxml=.git/stream-overlay/pytest.xml");
    expect(byId("dotnet").command(ctx(d))).toContain("--results-directory .git/stream-overlay/trx");
  });

  it("config overrides adapter values", () => {
    const d = tmpDir();
    dirs.push(d);
    const cfg = { ...defaultConfig().tests, command: "npx jest --ci", reports: ["junit.xml"], mode: "manual" as const };
    const plan = resolvePlan(ADAPTERS.find((a) => a.id === "node"), cfg, ctx(d))!;
    expect(plan).toMatchObject({ command: "npx jest --ci", reports: ["junit.xml"], parser: "junit", mode: "manual" });
  });
});

describe("passive mode (maven)", () => {
  it("aggregates surefire reports and flips with fx; stale reports are ignored", async () => {
    const dir = repo({ "pom.xml": "<project/>", ".gitignore": "target/\n" });
    copyReports(dir, "maven-fail", new Date(Date.now() - 3600_000)); // yesterday's run
    const { app, fx } = await boot(dir);
    expect(app.store.get("tests")).toMatchObject({ adapter: "maven", mode: "passive", status: "idle" });
    expect(app.store.get("project").stacks).toEqual(["Maven"]);

    copyReports(dir, "maven-fail");
    await waitFor(() => app.store.get("tests").status === "fail", 5000);
    expect(app.store.get("tests")).toMatchObject({ total: 5, passed: 3, failed: 1, skipped: 1, runs: 1 });
    expect(app.store.get("tests").firstFailure?.name).toBe("demo.CsvExportTest.quoting");

    await new Promise((r) => setTimeout(r, 50));
    copyReports(dir, "maven-pass");
    await waitFor(() => app.store.get("tests").status === "pass", 5000);
    expect(app.store.get("tests")).toMatchObject({ total: 5, passed: 4, failed: 0 });
    expect(fx.map((f) => f.name)).toContain("tests-green");

    copyReports(dir, "maven-fail");
    await waitFor(() => app.store.get("tests").status === "fail", 5000);
    expect(fx.map((f) => f.name)).toContain("tests-red");
    expect(sh(dir, "status", "--porcelain")).toBe("");
  }, 20_000);
});

describe("active runs", () => {
  /** A command that counts its runs in a file outside the repo and sleeps. */
  function counter(ms: number, exit = 0) {
    const out = tmpDir();
    dirs.push(out);
    const file = path.join(out, "runs.txt");
    const script = `require('fs').appendFileSync(${JSON.stringify(file)}, 'x'); setTimeout(() => process.exit(${exit}), ${ms})`;
    return { file, command: `"${process.execPath}" -e "${script.replace(/"/g, '\\"')}"` };
  }
  const runs = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").length : 0);

  it("save mode: a burst of saves triggers one run; saves during a run queue one follow-up", async () => {
    const dir = repo();
    const c = counter(2000); // long enough that both later saves land during the run
    const { app } = await boot(dir, { tests: { command: c.command, mode: "save", debounceMs: 200 } });
    for (let i = 0; i < 5; i++) {
      write(dir, `src/f${i}.ts`, String(i));
      await new Promise((r) => setTimeout(r, 30));
    }
    await waitFor(() => app.store.get("tests").status === "running", 3000);
    // two more saves while running → exactly one follow-up
    write(dir, "src/a.ts", "1");
    await new Promise((r) => setTimeout(r, 350));
    write(dir, "src/b.ts", "2");
    await waitFor(() => app.store.get("tests").runs === 2, 8000);
    await new Promise((r) => setTimeout(r, 1000));
    expect(runs(c.file)).toBe(2);
    expect(app.store.get("tests")).toMatchObject({ status: "pass", runs: 2, total: 0 });
  }, 20_000);

  it("exit-code fallback reports failure with a message", async () => {
    const dir = repo();
    const cmd = `"${process.execPath}" -e "console.error('AssertionError: boom'); process.exit(3)"`;
    const { app } = await boot(dir, { tests: { command: cmd, mode: "manual" } });
    app.tests!.run();
    await waitFor(() => app.store.get("tests").status === "fail");
    expect(app.store.get("tests").firstFailure).toEqual({ name: "exit code 3", message: "AssertionError: boom" });
  });

  it("parses fresh reports after an active run", async () => {
    const dir = repo();
    const src = path.join(FX, "junit", "pytest.xml");
    const cmd = `"${process.execPath}" -e "require('fs').mkdirSync('out',{recursive:true});require('fs').copyFileSync(${JSON.stringify(src).replace(/"/g, "'")}, 'out/report.xml'); process.exit(1)"`;
    write(dir, ".gitignore", "out/\n");
    const { app } = await boot(dir, { tests: { command: cmd, mode: "manual", reports: ["out/*.xml"] } });
    app.tests!.run();
    await waitFor(() => app.store.get("tests").status === "fail");
    expect(app.store.get("tests")).toMatchObject({ total: 4, passed: 2, failed: 1, skipped: 1 });
  });

  it("times out and kills the process tree", async () => {
    const dir = repo();
    const cmd = `"${process.execPath}" -e "setTimeout(() => {}, 60000)"`;
    const { app } = await boot(dir, { tests: { command: cmd, mode: "manual", timeoutSec: 1 } });
    const t0 = Date.now();
    app.tests!.run();
    await waitFor(() => app.store.get("tests").status === "error", 5000);
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(app.store.get("tests").error).toBe("timed out after 1s");
  });

  it("POST /api/tests/run triggers a run", async () => {
    const dir = repo();
    const c = counter(10);
    const { app } = await boot(dir, { tests: { command: c.command, mode: "manual" } });
    const r = await fetch(`http://127.0.0.1:${app.info.port}/api/tests/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${app.info.token}` },
    });
    expect(r.status).toBe(202);
    await waitFor(() => app.store.get("tests").runs === 1);
    expect(runs(c.file)).toBe(1);
  });
});

describe("state dir stays out of the tree", () => {
  it("python reports land under .git", async () => {
    const d = tmpDir();
    dirs.push(d);
    const plan = resolvePlan(ADAPTERS.find((a) => a.id === "python"), defaultConfig().tests, {
      root: d,
      stateDir: path.join(d, ".git", "stream-overlay"),
      platform: "linux",
    })!;
    expect(plan.reports[0]).toBe(path.join(d, ".git", "stream-overlay", "pytest.xml"));
  });
});
