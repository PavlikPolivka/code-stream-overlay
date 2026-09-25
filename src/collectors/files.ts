import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import type { Bus } from "../state/bus.js";
import type { Store } from "../state/store.js";
import type { Privacy } from "../privacy.js";
import { git } from "../util/exec.js";
import { debounce } from "../util/debounce.js";
import { toRepoRel } from "../util/paths.js";
import { log } from "../util/log.js";
import type { Collector } from "./types.js";

const BATCH_MS = 300;
const RECENT_MAX = 10;
/** Always skipped, whatever the stack: VCS internals and dependency trees. */
const BASE_IGNORE = [".git", "node_modules"];

/** Cached `git check-ignore --stdin`, asked in batches. */
export class IgnoreCache {
  private cache = new Map<string, boolean>();

  constructor(private root: string) {}

  async filter(rels: string[]): Promise<string[]> {
    const unknown = rels.filter((r) => !this.cache.has(r));
    if (unknown.length) {
      let ignored = new Set<string>();
      try {
        const out = await git(this.root, ["check-ignore", "--stdin", "-z"], unknown.join("\0") + "\0");
        ignored = new Set(out.split("\0").filter(Boolean));
      } catch (e) {
        // exit 1 means "none ignored"
        if ((e as { code?: number }).code !== 1) log.debug("check-ignore failed", e);
      }
      for (const r of unknown) this.cache.set(r, ignored.has(r));
      if (this.cache.size > 20_000) this.cache.clear();
    }
    return rels.filter((r) => !this.cache.get(r));
  }
}

/** Directories git ignores right now (collapsed: `dist/`, not every file inside). */
export async function ignoredDirs(root: string): Promise<string[]> {
  try {
    const out = await git(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
    return out
      .split("\0")
      .filter((p) => p.endsWith("/"))
      .map((p) => p.slice(0, -1));
  } catch {
    return [];
  }
}

export interface FilesOptions {
  root: string;
  /** Extra directory names to skip (adapter ignores, e.g. "target"). */
  ignoreDirs: string[];
  privacy: Privacy;
}

/** Owns the `activity` slice; emits `files:changed` in 300 ms batches. */
export class FilesCollector implements Collector {
  private watcher?: FSWatcher;
  private pending = new Set<string>();
  private ignore: IgnoreCache;
  private flush = debounce(() => void this.emitBatch(), BATCH_MS);

  constructor(
    private store: Store,
    private bus: Bus,
    private o: FilesOptions,
  ) {
    this.ignore = new IgnoreCache(o.root);
  }

  async start(): Promise<void> {
    const names = new Set([...BASE_IGNORE, ...this.o.ignoreDirs.map((d) => d.replace(/\/+$/, ""))]);
    const paths = new Set<string>();
    for (const d of await ignoredDirs(this.o.root)) paths.add(path.join(this.o.root, d));
    const root = this.o.root;
    this.watcher = watch(root, {
      ignoreInitial: true,
      ignored: (p: string) => {
        if (p === root) return false;
        if (paths.has(p)) return true;
        const rel = path.relative(root, p);
        for (const seg of rel.split(path.sep)) if (names.has(seg)) return true;
        return false;
      },
    });
    this.watcher.on("all", (event, p) => {
      if (event === "addDir" || event === "unlinkDir") return;
      this.pending.add(toRepoRel(root, p));
      this.flush();
    });
    this.watcher.on("error", (e) => log.debug("watcher error", e));
  }

  async stop(): Promise<void> {
    this.flush.cancel();
    await this.watcher?.close();
  }

  private async emitBatch() {
    const batch = [...this.pending];
    this.pending.clear();
    const paths = await this.ignore.filter(batch);
    if (!paths.length) return;
    const now = Date.now();
    this.store.update("activity", (a) => {
      let recent = a.recent;
      let current = a.currentFile;
      for (const rel of paths) {
        const shown = this.o.privacy.path(rel);
        current = shown;
        if (!this.o.privacy.isHidden(rel)) recent = [shown, ...recent.filter((r) => r !== shown)].slice(0, RECENT_MAX);
      }
      return { currentFile: current, lastEditAt: now, recent };
    });
    this.bus.emit("files:changed", { paths });
  }
}
