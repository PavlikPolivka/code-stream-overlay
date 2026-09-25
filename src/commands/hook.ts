// Claude Code hook entry point. Hot path: builtins only, no stdout, always exit 0.
import { readFileSync } from "node:fs";
import path from "node:path";
import { STATE_DIR } from "../constants.js";
import { findGitDirSync } from "../util/paths.js";

const STDIN_MAX = 1024 * 1024;
const FETCH_TIMEOUT_MS = 300;
const HARD_EXIT_MS = 1500;
const STR_MAX = 2000;
/** tool_input keys the server may use; everything else (file contents, diffs) stays local. */
const INPUT_KEYS = [
  "file_path",
  "notebook_path",
  "path",
  "command",
  "description",
  "pattern",
  "url",
  "query",
  "subagent_type",
  "subject",
  "taskId",
  "status",
];
const TOP_KEYS = ["hook_event_name", "session_id", "cwd", "tool_name", "prompt", "message", "notification_type"];

type Obj = Record<string, unknown>;
const cut = (v: unknown) => (typeof v === "string" && v.length > STR_MAX ? v.slice(0, STR_MAX) : v);

/** Keep the fields event-map.ts reads; drop contents and tool output. */
export function slimPayload(p: Obj): Obj {
  const out: Obj = {};
  for (const k of TOP_KEYS) if (p[k] !== undefined) out[k] = cut(p[k]);
  const input = p.tool_input;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const src = input as Obj;
    const slim: Obj = {};
    for (const k of INPUT_KEYS) if (src[k] !== undefined) slim[k] = cut(src[k]);
    if (Array.isArray(src.edits)) {
      slim.edits = src.edits.slice(0, 1).map((e) => ({ file_path: cut((e as Obj)?.file_path) }));
    }
    if (Array.isArray(src.todos)) {
      slim.todos = src.todos.slice(0, 100).map((t) => ({ content: cut((t as Obj)?.content), status: (t as Obj)?.status }));
    }
    out.tool_input = slim;
  }
  // Tool output stays local, except the id of a newly created task.
  const resp = p.tool_response as Obj | undefined;
  const task = resp && typeof resp === "object" ? (resp.task as Obj | undefined) : undefined;
  if (task && typeof task === "object") out.tool_response = { task: { id: task.id, subject: cut(task.subject) } };
  return out;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of process.stdin as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > STDIN_MAX) break;
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function hook(): Promise<void> {
  const hard = setTimeout(() => process.exit(0), HARD_EXIT_MS);
  try {
    const payload = JSON.parse(await readStdin()) as Obj;
    if (!payload || typeof payload !== "object") return;
    const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
    const gitDir = findGitDirSync(cwd);
    if (!gitDir) return;
    let info: { port?: number; token?: string };
    try {
      info = JSON.parse(readFileSync(path.join(gitDir, STATE_DIR, "server.json"), "utf8"));
    } catch {
      return; // no server running for this repo
    }
    if (!info.port || !info.token) return;
    await fetch(`http://127.0.0.1:${info.port}/api/agent`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(slimPayload(payload)),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }).catch(() => {});
  } catch {
    /* never fail the agent */
  } finally {
    clearTimeout(hard);
  }
}
