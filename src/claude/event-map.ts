import path from "node:path";
import type { AgentTodo } from "../state/types.js";
import type { Privacy } from "../privacy.js";

export type CountKey = "edits" | "commands" | "reads";

/** Normalized agent event, from a Claude Code hook payload or the generic API. */
export type AgentEvent =
  | { type: "action"; text: string; tool?: string; count?: CountKey }
  | { type: "thinking"; text?: string }
  | { type: "waiting"; text?: string }
  | { type: "done" }
  | { type: "todos"; todos: AgentTodo[] }
  /** Claude Code's task tools (TaskCreate / TaskUpdate), tracked per session. */
  | { type: "task"; session: string; id: string; subject?: string; status?: AgentTodo["status"] | "deleted" }
  | { type: "ignore" };

export interface MapContext {
  root: string;
  privacy: Privacy;
  showPrompts: boolean;
  showCommands: boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob", "LS"]);
const WEB_TOOLS = new Set(["WebFetch", "WebSearch"]);
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);
const PLANNING_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);
const TASK_STATUSES = new Set(["pending", "in_progress", "completed", "deleted"]);
const WAITING_NOTIFICATIONS = new Set([
  "permission_prompt",
  "idle_prompt",
  "elicitation_dialog",
  "elicitation_url_dialog",
  "agent_needs_input",
]);
const COMMAND_MAX = 60;
const TEXT_MAX = 120;

export const isHookPayload = (p: unknown): p is Obj => isObj(p) && typeof p.hook_event_name === "string";

/** Screen-safe display of a path the agent touched. */
export function displayPath(ctx: MapContext, file: string, cwd?: string): string {
  const abs = path.resolve(cwd ?? ctx.root, file);
  const rel = path.relative(ctx.root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return ctx.privacy.isHidden(path.basename(abs)) ? "a hidden file" : "a file outside the repo";
  return ctx.privacy.path(rel.split(path.sep).join("/"));
}

function filePathOf(input: Obj): string | undefined {
  const direct = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  if (direct) return direct;
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) if (isObj(e) && str(e.file_path)) return e.file_path as string;
  }
  return undefined;
}

export function sanitizeTodos(v: unknown): AgentTodo[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: AgentTodo[] = [];
  for (const t of v.slice(0, 100)) {
    if (!isObj(t) || typeof t.content !== "string") continue;
    const status = t.status === "completed" || t.status === "in_progress" ? t.status : "pending";
    out.push({ content: t.content.slice(0, 200), status });
  }
  return out;
}

/** Map a raw Claude Code hook payload. Pure: no I/O. */
export function mapHookPayload(p: Obj, ctx: MapContext): AgentEvent {
  const event = p.hook_event_name as string;
  const cwd = str(p.cwd);
  const tool = str(p.tool_name) ?? "";
  const input = isObj(p.tool_input) ? p.tool_input : {};

  switch (event) {
    case "PreToolUse": {
      if (EDIT_TOOLS.has(tool)) {
        const f = filePathOf(input);
        return { type: "action", tool, count: "edits", text: `Editing ${f ? displayPath(ctx, f, cwd) : "a file"}` };
      }
      if (tool === "Bash") {
        const cmd = str(input.command);
        if (!cmd || !ctx.showCommands) return { type: "action", tool, count: "commands", text: "Running a command" };
        const oneLine = cmd.replace(/\s+/g, " ").trim();
        return { type: "action", tool, count: "commands", text: `Running ${ctx.privacy.text(oneLine, COMMAND_MAX)}` };
      }
      if (tool === "Read") {
        const f = filePathOf(input);
        return { type: "action", tool, count: "reads", text: `Reading ${f ? displayPath(ctx, f, cwd) : "a file"}` };
      }
      if (SEARCH_TOOLS.has(tool)) return { type: "action", tool, text: "Searching the code" };
      if (WEB_TOOLS.has(tool)) return { type: "action", tool, text: "Browsing the web" };
      if (SUBAGENT_TOOLS.has(tool)) return { type: "action", tool, text: "Running a subagent" };
      const mcp = /^mcp__(.+?)__/.exec(tool);
      if (mcp) return { type: "action", tool, text: `Using ${ctx.privacy.text(mcp[1], 40)}` };
      if (PLANNING_TOOLS.has(tool)) return { type: "action", tool, text: "Planning" };
      if (tool === "ToolSearch") return { type: "action", tool, text: "Loading tools" };
      return { type: "action", tool, text: `Using ${ctx.privacy.text(tool || "a tool", 40)}` };
    }
    case "PostToolUse": {
      if (tool === "TodoWrite") {
        const todos = sanitizeTodos(input.todos);
        if (todos) return { type: "todos", todos: todos.map((t) => ({ ...t, content: ctx.privacy.text(t.content, TEXT_MAX) })) };
      }
      const session = str(p.session_id) ?? "";
      const resp = isObj(p.tool_response) ? p.tool_response : {};
      if (tool === "TaskCreate") {
        const task = isObj(resp.task) ? resp.task : {};
        const id = str(task.id) ?? (typeof task.id === "number" ? String(task.id) : undefined);
        const subject = str(task.subject) ?? str(input.subject);
        if (id && subject) return { type: "task", session, id, subject: ctx.privacy.text(subject, TEXT_MAX), status: "pending" };
      }
      if (tool === "TaskUpdate") {
        const id = str(input.taskId) ?? (typeof input.taskId === "number" ? String(input.taskId) : undefined);
        const status = str(input.status);
        const subject = str(input.subject);
        if (id && (status || subject)) {
          return {
            type: "task",
            session,
            id,
            ...(subject ? { subject: ctx.privacy.text(subject, TEXT_MAX) } : {}),
            ...(status && TASK_STATUSES.has(status) ? { status: status as AgentTodo["status"] | "deleted" } : {}),
          };
        }
      }
      return { type: "ignore" };
    }
    case "UserPromptSubmit": {
      const prompt = str(p.prompt);
      if (ctx.showPrompts && prompt) return { type: "thinking", text: ctx.privacy.text(prompt.replace(/\s+/g, " ").trim(), TEXT_MAX) };
      return { type: "thinking" };
    }
    case "Notification": {
      const kind = str(p.notification_type);
      if (kind && !WAITING_NOTIFICATIONS.has(kind)) return { type: "ignore" };
      return { type: "waiting" };
    }
    case "Stop":
      return { type: "done" };
    default:
      return { type: "ignore" };
  }
}

/** Map a generic `POST /api/agent` body from any agent. */
export function mapGenericEvent(p: unknown, ctx: MapContext): AgentEvent {
  if (!isObj(p)) return { type: "ignore" };
  switch (p.type) {
    case "action": {
      const text = str(p.text);
      if (!text) return { type: "ignore" };
      const tool = str(p.tool);
      return { type: "action", text: ctx.privacy.text(text, TEXT_MAX), ...(tool ? { tool: ctx.privacy.text(tool, 40) } : {}) };
    }
    case "thinking":
      return { type: "thinking" };
    case "waiting":
      return { type: "waiting" };
    case "done":
      return { type: "done" };
    case "todos": {
      const todos = sanitizeTodos(p.todos);
      return todos ? { type: "todos", todos: todos.map((t) => ({ ...t, content: ctx.privacy.text(t.content, TEXT_MAX) })) } : { type: "ignore" };
    }
    default:
      return { type: "ignore" };
  }
}

export function mapAny(p: unknown, ctx: MapContext): AgentEvent {
  return isHookPayload(p) ? mapHookPayload(p, ctx) : mapGenericEvent(p, ctx);
}
