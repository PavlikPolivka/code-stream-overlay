import type { Config } from "../config/schema.js";
import type { Bus } from "../state/bus.js";
import type { Store } from "../state/store.js";
import type { AgentTodo, State } from "../state/types.js";
import type { Privacy } from "../privacy.js";
import { mapAny, type AgentEvent, type MapContext } from "../claude/event-map.js";
import type { Collector } from "./types.js";

/** Owns the `agent` slice. Fed by POST /api/agent (hook or generic events). */
export class AgentCollector implements Collector {
  private idleTimer?: NodeJS.Timeout;
  /** Claude Code task lists, per session id (insertion order = creation order). */
  private tasks = new Map<string, Map<string, AgentTodo>>();
  private ctx: MapContext;

  constructor(
    private store: Store,
    private bus: Bus,
    private o: { root: string; agent: Config["agent"]; privacy: Privacy },
  ) {
    this.ctx = { root: o.root, privacy: o.privacy, showPrompts: o.agent.showPrompts, showCommands: o.agent.showCommands };
  }

  start(): void {}

  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
  }

  /** Entry point for POST /api/agent. */
  receive(body: unknown): void {
    if (!this.o.agent.enabled) return;
    this.apply(mapAny(body, this.ctx));
  }

  apply(e: AgentEvent, now = Date.now()): void {
    if (e.type === "ignore") return;
    if (e.type === "task") {
      let list = this.tasks.get(e.session);
      if (!list) {
        list = new Map();
        this.tasks.set(e.session, list);
      }
      const prev = list.get(e.id);
      if (e.status === "deleted") list.delete(e.id);
      else if (prev || e.subject) {
        list.set(e.id, { content: e.subject ?? prev!.content, status: e.status ?? prev?.status ?? "pending" });
      }
      this.bus.emit("agent:todos", { todos: [...list.values()] });
      this.touch(now, (a) => a);
      return;
    }
    if (e.type === "todos") {
      this.bus.emit("agent:todos", { todos: e.todos });
      this.touch(now, (a) => a);
      return;
    }
    let waiting = false;
    this.touch(now, (a) => {
      switch (e.type) {
        case "action":
          return {
            ...a,
            status: "working",
            action: e.text,
            tool: e.tool,
            counts: e.count ? { ...a.counts, [e.count]: a.counts[e.count] + 1 } : a.counts,
          };
        case "thinking":
          return { ...a, status: "working", action: e.text ? `Thinking about: ${e.text}` : "Thinking…", tool: undefined };
        case "waiting":
          waiting = a.status !== "waiting";
          return { ...a, status: "waiting", action: "Waiting for you", tool: undefined };
        case "done":
          return { ...a, status: "done", action: "Done", tool: undefined };
      }
    });
    if (waiting) this.store.fx("agent-waiting");
  }

  private touch(now: number, fn: (a: State["agent"]) => State["agent"]) {
    const prev = this.store.get("agent");
    const next = fn(prev);
    // A todo update from an offline agent still means the agent is alive.
    const status = next.status === "offline" || next.status === "idle" ? "working" : next.status;
    const clean: State["agent"] = { status, counts: next.counts, at: now };
    if (next.action !== undefined) clean.action = next.action;
    if (next.tool !== undefined) clean.tool = next.tool;
    if (status === "working" && clean.action === undefined) clean.action = "Working…";
    this.store.set("agent", clean);
    this.armIdle();
  }

  private armIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      const a = this.store.get("agent");
      if (a.status === "offline" || a.status === "idle") return;
      this.store.set("agent", { status: "idle", counts: a.counts, ...(a.at !== undefined ? { at: a.at } : {}) });
    }, this.o.agent.idleAfterSec * 1000);
    this.idleTimer.unref();
  }
}
