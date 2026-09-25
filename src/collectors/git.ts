import { stat, open } from "node:fs/promises";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { EMPTY_TREE } from "../constants.js";
import type { Bus } from "../state/bus.js";
import type { Store } from "../state/store.js";
import type { Commit, State } from "../state/types.js";
import type { Privacy } from "../privacy.js";
import { git } from "../util/exec.js";
import { throttle } from "../util/debounce.js";
import { log } from "../util/log.js";
import type { Collector } from "./types.js";

const COMMITS_MAX = 50;
const UNTRACKED_MAX_BYTES = 1024 * 1024;
const SEP = "\x1f";

export interface NumstatTotals {
  added: number;
  removed: number;
  files: number;
}

/** Parse `git diff --numstat -z`. Binary files (`-\t-`) count as changed with 0 lines. */
export function parseNumstat(out: string): NumstatTotals {
  const t = { added: 0, removed: 0, files: 0 };
  for (const rec of out.split("\0")) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(rec);
    if (!m) continue;
    t.files++;
    if (m[1] !== "-") t.added += Number(m[1]);
    if (m[2] !== "-") t.removed += Number(m[2]);
  }
  return t;
}

export function parseLog(out: string): Commit[] {
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, subject, ct] = line.split(SEP);
      return { sha, subject, at: Number(ct) * 1000 };
    });
}

/** Count newlines in a file; undefined for binary files. */
async function countLines(file: string): Promise<number | undefined> {
  const fh = await open(file, "r");
  try {
    const buf = await fh.readFile();
    if (buf.subarray(0, 8000).includes(0)) return undefined;
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
    if (buf.length && buf[buf.length - 1] !== 10) n++;
    return n;
  } finally {
    await fh.close();
  }
}

export interface GitOptions {
  root: string;
  gitDir: string;
  privacy: Privacy;
}

/** Owns the `git` slice. Diff is against the session's start commit, not HEAD. */
export class GitCollector implements Collector {
  private watcher?: FSWatcher;
  private known = new Set<string>();
  private first = true;
  private lineCache = new Map<string, { key: string; lines: number }>();
  private offFiles?: () => void;
  readonly refresh = throttle(() => this.compute(), 1000);

  constructor(
    private store: Store,
    private bus: Bus,
    private o: GitOptions,
  ) {}

  async start(): Promise<void> {
    this.offFiles = this.bus.on("files:changed", () => this.refresh());
    const common = await git(this.o.root, ["rev-parse", "--git-common-dir"])
      .then((s) => path.resolve(this.o.root, s.trim()))
      .catch(() => this.o.gitDir);
    const targets = [
      path.join(this.o.gitDir, "HEAD"),
      path.join(this.o.gitDir, "logs", "HEAD"),
      path.join(common, "refs", "heads"),
      path.join(common, "packed-refs"),
    ];
    this.watcher = watch(targets, { ignoreInitial: true, depth: 10 });
    this.watcher.on("all", () => this.refresh());
    this.watcher.on("error", (e) => log.debug("git watcher error", e));
    this.refresh();
  }

  async stop(): Promise<void> {
    this.offFiles?.();
    this.refresh.cancel();
    await this.watcher?.close();
  }

  async compute(): Promise<void> {
    const { root } = this.o;
    const session = this.store.get("session");
    const prev = this.store.get("git");
    try {
      const head = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "")).trim();
      const branch = head
        ? (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()
        : (await git(root, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "")).trim();

      const diff = parseNumstat(await git(root, ["diff", "--numstat", "-z", "--no-renames", session.startSha, "--"]));
      const untracked = await this.untracked();
      const commits = head ? await this.commits(session) : [];

      const next: State["git"] = {
        branch: branch === "HEAD" ? head.slice(0, 7) : branch,
        headSha: head,
        added: diff.added + untracked.lines,
        removed: diff.removed,
        filesChanged: diff.files + untracked.count,
        untracked: untracked.count,
        commits,
      };
      this.store.set("git", next);

      const fresh = commits.filter((c) => !this.known.has(c.sha));
      for (const c of commits) this.known.add(c.sha);
      if (!this.first) {
        for (const c of fresh.reverse()) {
          this.store.fx("commit", { subject: c.subject, sha: c.sha });
          this.bus.emit("git:commit", { sha: c.sha, subject: c.subject });
        }
      }
      this.first = false;
    } catch (e) {
      const msg = (e as { stderr?: string }).stderr?.trim() || (e as Error).message;
      this.store.set("git", { ...prev, error: msg.split("\n")[0].slice(0, 200) });
    }
  }

  private async commits(session: State["session"]): Promise<Commit[]> {
    const fmt = `--format=%H${SEP}%s${SEP}%ct`;
    const args =
      session.startSha === EMPTY_TREE
        ? ["log", fmt, `-n${COMMITS_MAX}`, `--since=${Math.floor(session.startedAt / 1000) - 1}`, "HEAD"]
        : ["log", fmt, `-n${COMMITS_MAX}`, `${session.startSha}..HEAD`];
    const list = parseLog(await git(this.o.root, args));
    return list.map((c) => ({ ...c, subject: this.o.privacy.text(c.subject, 120) }));
  }

  private async untracked(): Promise<{ count: number; lines: number }> {
    const out = await git(this.o.root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const files = out.split("\0").filter(Boolean);
    let lines = 0;
    const seen = new Set<string>();
    for (const rel of files) {
      seen.add(rel);
      if (this.o.privacy.isHidden(rel)) continue; // never read secret files
      const abs = path.join(this.o.root, rel);
      try {
        const st = await stat(abs);
        if (!st.isFile() || st.size > UNTRACKED_MAX_BYTES) continue;
        const key = `${st.size}:${st.mtimeMs}`;
        const cached = this.lineCache.get(rel);
        if (cached?.key === key) {
          lines += cached.lines;
          continue;
        }
        const n = (await countLines(abs)) ?? 0;
        this.lineCache.set(rel, { key, lines: n });
        lines += n;
      } catch {
        /* vanished */
      }
    }
    for (const k of this.lineCache.keys()) if (!seen.has(k)) this.lineCache.delete(k);
    return { count: files.length, lines };
  }
}
