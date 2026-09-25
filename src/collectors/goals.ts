import { readFile } from "node:fs/promises";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import type { Config } from "../config/schema.js";
import type { Bus } from "../state/bus.js";
import type { Store } from "../state/store.js";
import type { AgentTodo, State } from "../state/types.js";
import { newlyDone, parseGoals } from "../goals/parse.js";
import { debounce } from "../util/debounce.js";
import { log } from "../util/log.js";
import type { Collector } from "./types.js";

const MAX_BYTES = 256 * 1024;

export interface GoalsOptions {
  root: string;
  goals: Config["goals"];
}

/** Owns the `goals` slice: a Markdown file, Claude's todos, or both. */
export class GoalsCollector implements Collector {
  private watcher?: FSWatcher;
  private off?: () => void;
  private reload = debounce(() => void this.load(), 100);
  readonly file: string;

  constructor(
    private store: Store,
    private bus: Bus,
    private o: GoalsOptions,
  ) {
    this.file = path.resolve(o.root, o.goals.file);
  }

  private get usesFile() {
    return this.o.goals.source === "file" || this.o.goals.source === "both";
  }

  private get usesTodos() {
    return this.o.goals.source === "claude-todos" || this.o.goals.source === "both";
  }

  async start(): Promise<void> {
    if (this.usesTodos) this.off = this.bus.on("agent:todos", ({ todos }) => this.setTodos(todos));
    if (!this.usesFile) return;
    await this.load(true);
    // Watch the directory so the file may be created or replaced later.
    const dir = path.dirname(this.file);
    const base = path.basename(this.file);
    this.watcher = watch(dir, {
      ignoreInitial: true,
      depth: 0,
      ignored: (p: string) => p !== dir && path.basename(p) !== base,
    });
    this.watcher.on("all", (_e, p) => {
      if (path.resolve(p) === this.file) this.reload();
    });
    this.watcher.on("error", (e) => log.debug("goals watcher error", e));
  }

  async stop(): Promise<void> {
    this.off?.();
    this.reload.cancel();
    await this.watcher?.close();
  }

  async load(initial = false): Promise<void> {
    let md = "";
    try {
      const buf = await readFile(this.file);
      md = buf.subarray(0, MAX_BYTES).toString("utf8");
    } catch {
      /* missing file: empty goals, no error */
    }
    const parsed = parseGoals(md, this.o.goals.stretchHeading);
    const prev = this.store.get("goals");
    const next: State["goals"] = {
      source: this.o.goals.source,
      ...(parsed.title !== undefined ? { title: parsed.title } : {}),
      items: parsed.items,
      done: parsed.done,
      total: parsed.total,
      ...(parsed.currentIndex !== undefined ? { currentIndex: parsed.currentIndex } : {}),
      ...(prev.todos ? { todos: prev.todos } : {}),
    };
    this.store.set("goals", next);
    if (!initial) for (const text of newlyDone(prev.items, parsed.items)) this.store.fx("goal-done", { text });
  }

  private setTodos(todos: AgentTodo[]): void {
    const prev = this.store.get("goals");
    const next: State["goals"] = { ...prev, todos };
    if (this.o.goals.source === "claude-todos") {
      next.done = todos.filter((t) => t.status === "completed").length;
      next.total = todos.length;
    }
    this.store.set("goals", next);
    const before = new Map((prev.todos ?? []).map((t) => [t.content, t.status]));
    for (const t of todos) {
      const was = before.get(t.content);
      if (t.status === "completed" && was !== undefined && was !== "completed") this.store.fx("goal-done", { text: t.content });
    }
  }
}
