import { spawn, type ChildProcess } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { glob } from "tinyglobby";
import type { Config } from "../../config/schema.js";
import type { Bus } from "../../state/bus.js";
import type { Store } from "../../state/store.js";
import type { State, TriggerMode } from "../../state/types.js";
import type { Privacy } from "../../privacy.js";
import { debounce } from "../../util/debounce.js";
import { killTree } from "../../util/exec.js";
import { compileGlob } from "../../util/glob.js";
import { log } from "../../util/log.js";
import { toRepoRel } from "../../util/paths.js";
import type { Collector } from "../types.js";
import type { AdapterContext, ParserId, StackAdapter } from "./adapters/index.js";
import { parseGoJson } from "./parsers/gojson.js";
import { parseJunit } from "./parsers/junit.js";
import { parseTrx } from "./parsers/trx.js";
import { combine, firstLine, ParseError, type ParseResult } from "./parsers/types.js";

const RING_BYTES = 64 * 1024;
const STDOUT_MAX = 32 * 1024 * 1024;
const PASSIVE_QUIET_MS = 1000;
const PASSIVE_WINDOW_MS = 60_000;
/** Filesystems with coarse mtimes (FAT: 2 s) must not make fresh reports look stale. */
const MTIME_SLACK_MS = 2000;
const MESSAGE_MAX = 200;
const NEVER_DESCEND = [".git", "node_modules"];

/** Resolved test setup: adapter defaults with config overrides applied. */
export interface TestPlan {
  adapter: string;
  command: string;
  reports: string[];
  parser: ParserId;
  mode: TriggerMode;
  debounceMs: number;
  intervalSec: number;
  timeoutSec: number;
  /** Directories the save trigger and the file watcher skip. */
  ignore: string[];
}

export function resolvePlan(adapter: StackAdapter | undefined, cfg: Config["tests"], ctx: AdapterContext): TestPlan | undefined {
  if (!adapter && !cfg.command) return undefined;
  const reports = cfg.reports ?? adapter?.reports(ctx) ?? [];
  let parser: ParserId = adapter?.parser(ctx) ?? "exit-code";
  // Reports configured for an exit-code adapter (e.g. node + jest-junit) mean JUnit.
  if (cfg.reports?.length && parser === "exit-code") parser = /\.trx$/i.test(cfg.reports[0]) ? "trx" : "junit";
  return {
    adapter: adapter?.id ?? "custom",
    command: cfg.command ?? adapter!.command(ctx),
    reports,
    parser,
    mode: cfg.mode ?? adapter?.defaultMode ?? "manual",
    debounceMs: cfg.debounceMs ?? adapter?.debounceMs ?? 1500,
    intervalSec: cfg.intervalSec,
    timeoutSec: cfg.timeoutSec,
    ignore: adapter?.ignore ?? [],
  };
}

/** Fixed-size tail buffer for command output. */
class Ring {
  private chunks: Buffer[] = [];
  private size = 0;

  push(b: Buffer) {
    this.chunks.push(b);
    this.size += b.length;
    while (this.size > RING_BYTES && this.chunks.length > 1) this.size -= this.chunks.shift()!.length;
  }

  toString() {
    const s = Buffer.concat(this.chunks).toString("utf8");
    return s.length > RING_BYTES ? s.slice(-RING_BYTES) : s;
  }
}

export interface TestsOptions {
  root: string;
  plan: TestPlan;
  privacy: Privacy;
  /** Session start: older reports are stale. */
  since: number;
}

/** Owns the `tests` slice. */
export class TestsCollector implements Collector {
  private child?: ChildProcess;
  private running = false;
  private queued = false;
  private stopped = false;
  private interval?: NodeJS.Timeout;
  private watcher?: FSWatcher;
  private offs: (() => void)[] = [];
  private globs: ReturnType<typeof compileGlob>[];
  private saveTrigger: ReturnType<typeof debounce<[]>>;
  private passiveTrigger = debounce(() => void this.collectPassive(), PASSIVE_QUIET_MS);
  /** Output tail of the last run (for debugging and error messages). */
  lastOutput = "";

  constructor(
    private store: Store,
    private bus: Bus,
    private o: TestsOptions,
  ) {
    const noDescend = [...NEVER_DESCEND, ...o.plan.ignore];
    this.globs = this.relReports().map((g) => compileGlob(g, noDescend));
    this.saveTrigger = debounce(() => this.run(), o.plan.debounceMs);
  }

  get plan(): TestPlan {
    return this.o.plan;
  }

  async start(): Promise<void> {
    const { plan } = this.o;
    switch (plan.mode) {
      case "save": {
        const skip = new Set([...NEVER_DESCEND, ...plan.ignore]);
        this.offs.push(
          this.bus.on("files:changed", ({ paths }) => {
            const relevant = paths.some((p) => !p.split("/").some((seg) => skip.has(seg)) && !this.isReport(p));
            if (relevant) this.saveTrigger();
          }),
        );
        break;
      }
      case "commit":
        this.offs.push(this.bus.on("git:commit", () => this.run()));
        break;
      case "interval":
        this.interval = setInterval(() => this.run(), Math.max(30, plan.intervalSec) * 1000);
        this.interval.unref();
        break;
      case "passive":
        this.watchReports();
        break;
      case "manual":
        break;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const off of this.offs) off();
    this.saveTrigger.cancel();
    this.passiveTrigger.cancel();
    if (this.interval) clearInterval(this.interval);
    await this.watcher?.close();
    if (this.child?.pid) killTree(this.child.pid);
  }

  /** Request a run; coalesces into at most one queued follow-up. */
  run(): void {
    if (this.stopped) return;
    if (this.running) {
      this.queued = true;
      return;
    }
    void this.execute();
  }

  get busy(): boolean {
    return this.running;
  }

  // ---------- active runs ----------

  private async execute(): Promise<void> {
    this.running = true;
    const { plan, root } = this.o;
    const startedAt = Date.now();
    this.update((t) => ({ ...t, status: "running", error: undefined }));

    const ring = new Ring();
    let stdout = "";
    let timedOut = false;
    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawn(plan.command, {
        cwd: root,
        shell: true,
        detached: process.platform !== "win32", // own process group, so the whole tree can be killed
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "0", CI: process.env.CI ?? "" },
      });
      this.child = child;
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) killTree(child.pid);
      }, plan.timeoutSec * 1000);
      child.stdout!.on("data", (b: Buffer) => {
        ring.push(b);
        if (plan.parser === "go-json" && stdout.length < STDOUT_MAX) stdout += b.toString("utf8");
      });
      child.stderr!.on("data", (b: Buffer) => ring.push(b));
      child.on("error", () => {
        clearTimeout(timer);
        resolve(127);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    this.child = undefined;
    const endedAt = Date.now();
    this.lastOutput = ring.toString();

    if (this.stopped) {
      this.running = false;
      return;
    }

    if (timedOut) {
      this.finish({ status: "error", error: `timed out after ${plan.timeoutSec}s`, durationMs: endedAt - startedAt }, endedAt);
    } else {
      let parsed: ParseResult | undefined;
      let parseError: string | undefined;
      try {
        if (plan.parser === "go-json") parsed = parseGoJson(stdout);
        else if (plan.parser !== "exit-code") parsed = await this.parseReports(startedAt - MTIME_SLACK_MS, false);
      } catch (e) {
        parseError = e instanceof ParseError ? e.message : String(e);
      }
      const code = exitCode ?? 1;
      if (parsed) {
        const failed = parsed.failed > 0 || parsed.runFailed || code !== 0;
        this.finish(
          {
            status: failed ? "fail" : "pass",
            total: parsed.total,
            passed: parsed.passed,
            failed: parsed.failed,
            skipped: parsed.skipped,
            durationMs: parsed.durationMs ?? endedAt - startedAt,
            firstFailure: parsed.firstFailure ?? (failed ? this.exitFailure(code) : undefined),
          },
          endedAt,
        );
      } else if (parseError && plan.parser !== "go-json") {
        this.finish({ status: "error", error: parseError, durationMs: endedAt - startedAt }, endedAt);
      } else {
        // No fresh reports: fall back to the exit code with unknown counts.
        this.finish(
          {
            status: code === 0 ? "pass" : "fail",
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            durationMs: endedAt - startedAt,
            firstFailure: code === 0 ? undefined : this.exitFailure(code),
          },
          endedAt,
        );
      }
    }

    this.running = false;
    if (this.queued && !this.stopped) {
      this.queued = false;
      this.run();
    }
  }

  private exitFailure(code: number) {
    const lines = this.lastOutput
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const msg = lines.reverse().find((l) => /error|fail|assert|expected/i.test(l)) ?? lines[0];
    return { name: `exit code ${code}`, ...(msg ? { message: msg } : {}) };
  }

  // ---------- reports ----------

  private relReports(): string[] {
    const root = this.o.root;
    return this.o.plan.reports
      .map((g) => (path.isAbsolute(g) ? toRepoRel(root, g) : g))
      .filter((g) => !g.startsWith("../"));
  }

  private isReport(rel: string): boolean {
    return this.globs.some((g) => g.matches(rel));
  }

  private async findReports(): Promise<{ file: string; mtime: number }[]> {
    const patterns = this.relReports();
    if (!patterns.length) return [];
    // dot: false keeps ** out of .git; literal ".git/stream-overlay/..." patterns still match.
    const files = await glob(patterns, {
      cwd: this.o.root,
      absolute: true,
      dot: false,
      ignore: ["**/node_modules/**"],
      followSymbolicLinks: false,
    });
    const out: { file: string; mtime: number }[] = [];
    for (const file of files) {
      try {
        out.push({ file, mtime: (await stat(file)).mtimeMs });
      } catch {
        /* vanished */
      }
    }
    return out;
  }

  /**
   * Parse reports newer than `since`. `batch` keeps only files written within
   * 60 s of the newest one (one file per class for Maven/Gradle).
   */
  private async parseReports(since: number, batch: boolean): Promise<ParseResult | undefined> {
    let files = (await this.findReports()).filter((f) => f.mtime >= since);
    if (!files.length) return undefined;
    if (batch) {
      const newest = Math.max(...files.map((f) => f.mtime));
      files = files.filter((f) => f.mtime >= newest - PASSIVE_WINDOW_MS);
    }
    const parse = this.o.plan.parser === "trx" ? parseTrx : parseJunit;
    const results: ParseResult[] = [];
    let lastError: unknown;
    for (const f of files.sort((a, b) => a.file.localeCompare(b.file))) {
      try {
        results.push(parse(await readFile(f.file, "utf8")));
      } catch (e) {
        lastError = e; // a report still being written; skip it
        log.debug("report parse failed", f.file, e);
      }
    }
    if (!results.length) throw lastError;
    return combine(results);
  }

  private watchReports(): void {
    const root = this.o.root;
    if (!this.globs.length) return;
    this.watcher = watch(root, {
      ignoreInitial: true,
      ignored: (p: string, stats) => {
        const rel = toRepoRel(root, p);
        if (!rel || rel === ".") return false;
        if (stats?.isFile()) return !this.isReport(rel);
        if (stats?.isDirectory()) return !this.globs.some((g) => g.mayContain(rel));
        // Unknown type: keep if it could be either.
        return !this.isReport(rel) && !this.globs.some((g) => g.mayContain(rel));
      },
    });
    this.watcher.on("add", () => this.passiveTrigger());
    this.watcher.on("change", () => this.passiveTrigger());
    this.watcher.on("error", (e) => log.debug("report watcher error", e));
  }

  private async collectPassive(): Promise<void> {
    if (this.stopped) return;
    try {
      const r = await this.parseReports(this.o.since - MTIME_SLACK_MS, true);
      if (!r) return;
      this.finish(
        {
          status: r.failed > 0 || r.runFailed ? "fail" : "pass",
          total: r.total,
          passed: r.passed,
          failed: r.failed,
          skipped: r.skipped,
          durationMs: r.durationMs,
          firstFailure: r.firstFailure,
        },
        Date.now(),
      );
    } catch (e) {
      this.finish({ status: "error", error: e instanceof Error ? e.message : String(e) }, Date.now());
    }
  }

  // ---------- state ----------

  private update(fn: (t: State["tests"]) => State["tests"]) {
    this.store.update("tests", fn);
  }

  private finish(r: Partial<State["tests"]> & { status: State["tests"]["status"] }, at: number) {
    const prev = this.store.get("tests");
    const p = this.o.privacy;
    const firstFailure = r.firstFailure
      ? {
          name: p.text(r.firstFailure.name, MESSAGE_MAX),
          ...(r.firstFailure.message ? { message: p.text(firstLine(r.firstFailure.message) ?? "", MESSAGE_MAX) } : {}),
          ...(r.firstFailure.file ? { file: p.path(r.firstFailure.file) } : {}),
        }
      : undefined;
    const next: State["tests"] = {
      status: r.status,
      adapter: prev.adapter,
      mode: prev.mode,
      total: r.total ?? 0,
      passed: r.passed ?? 0,
      failed: r.failed ?? 0,
      skipped: r.skipped ?? 0,
      runs: prev.runs + 1,
      lastRunAt: at,
      ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
      ...(firstFailure ? { firstFailure } : {}),
      ...(r.error ? { error: p.text(r.error, MESSAGE_MAX) } : {}),
    };
    this.store.set("tests", next);

    // "Previous" ignores the transient running state.
    const before = this.lastSettled;
    this.lastSettled = next.status;
    if (next.status === "pass" && (before === "fail" || before === "error")) this.store.fx("tests-green");
    if (next.status === "fail" && before === "pass") this.store.fx("tests-red");
    this.bus.emit("tests:finished", { status: next.status });
  }

  private lastSettled: State["tests"]["status"] = "idle";
}
