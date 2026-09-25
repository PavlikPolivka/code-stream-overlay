import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mapAny, mapHookPayload, type MapContext } from "../src/claude/event-map.js";
import { createPrivacy } from "../src/privacy.js";
import { defaultConfig } from "../src/config/schema.js";
import { AgentCollector } from "../src/collectors/agent.js";
import { Store } from "../src/state/store.js";
import { Bus } from "../src/state/bus.js";
import { initialState, createApp, type App } from "../src/app.js";
import { TimerCollector } from "../src/collectors/timer.js";
import { mergeLayers } from "../src/config/load.js";
import { resolveRepo } from "../src/util/paths.js";
import { slimPayload } from "../src/commands/hook.js";
import { addHooks, removeHooks, hookCommand, isOurs, hasOurHooks, serialize } from "../src/claude/settings.js";
import { installHooks, uninstallHooks } from "../src/commands/hooks.js";
import type { AgentTodo, Fx } from "../src/state/types.js";
import { rm, sh, tmpRepo, waitFor } from "./helpers.js";

const FX = path.join(import.meta.dirname, "fixtures");
const session = readFileSync(path.join(FX, "claude", "session.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Record<string, unknown>);

const ctx: MapContext = { root: "/work/cap", privacy: createPrivacy(defaultConfig().privacy), showPrompts: false, showCommands: true };

describe("event map (real payloads)", () => {
  const mapped = session.map((p) => ({ p, e: mapHookPayload(slimPayload(p), ctx) }));
  const find = (event: string, tool?: string) => mapped.find((m) => m.p.hook_event_name === event && (!tool || m.p.tool_name === tool))!.e;

  it("maps edits, reads and commands with repo-relative paths", () => {
    expect(find("PreToolUse", "Write")).toEqual({ type: "action", tool: "Write", count: "edits", text: "Editing notes.txt" });
    expect(find("PreToolUse", "Edit")).toMatchObject({ count: "edits", text: "Editing notes.txt" });
    expect(find("PreToolUse", "Read")).toEqual({ type: "action", tool: "Read", count: "reads", text: "Reading README.md" });
    expect(find("PreToolUse", "Bash")).toEqual({ type: "action", tool: "Bash", count: "commands", text: "Running ls -la" });
    expect(find("PreToolUse", "Grep")).toMatchObject({ text: "Searching the code" });
    expect(find("PreToolUse", "TaskCreate")).toMatchObject({ text: "Planning" });
  });

  it("maps prompts, stop and notifications", () => {
    expect(find("UserPromptSubmit")).toEqual({ type: "thinking" });
    expect(find("Stop")).toEqual({ type: "done" });
    expect(find("Notification")).toEqual({ type: "waiting" });
    expect(mapHookPayload({ hook_event_name: "Notification", notification_type: "auth_success" }, ctx)).toEqual({ type: "ignore" });
  });

  it("maps task tools and legacy TodoWrite", () => {
    const tasks = mapped.filter((m) => m.e.type === "task").map((m) => m.e);
    expect(tasks[0]).toMatchObject({ type: "task", id: "1", subject: "Write notes", status: "pending" });
    expect(tasks.at(-1)).toMatchObject({ type: "task", id: "2", status: "completed" });
    expect(find("PostToolUse", "TodoWrite")).toEqual({
      type: "todos",
      todos: [
        { content: "Write notes", status: "completed" },
        { content: "List files", status: "in_progress" },
      ],
    });
  });

  it("hides secret files, redacts and truncates commands, hides prompts", () => {
    const pre = (tool: string, tool_input: object) => mapHookPayload({ hook_event_name: "PreToolUse", cwd: "/work/cap", tool_name: tool, tool_input }, ctx);
    expect(pre("Edit", { file_path: "/work/cap/.env" })).toMatchObject({ text: "Editing a hidden file" });
    expect(pre("Read", { file_path: "/etc/hosts" })).toMatchObject({ text: "Reading a file outside the repo" });
    expect(pre("NotebookEdit", { notebook_path: "nb/a.ipynb" })).toMatchObject({ text: "Editing nb/a.ipynb" });
    const long = pre("Bash", { command: "API_TOKEN=abc123 curl -H 'Authorization: Bearer xyz' https://example.com/very/long/path/that/goes/on" }) as { text: string };
    expect(long.text).not.toContain("abc123");
    expect(long.text).not.toContain("xyz");
    expect(long.text.length).toBeLessThanOrEqual("Running ".length + 60);
    expect(pre("mcp__github__create_issue", {})).toMatchObject({ text: "Using github" });
    expect(pre("Task", {})).toMatchObject({ text: "Running a subagent" });
    expect(pre("Frobnicate", {})).toMatchObject({ text: "Using Frobnicate" });
    expect(mapHookPayload({ hook_event_name: "UserPromptSubmit", prompt: "my secret plan" }, ctx)).toEqual({ type: "thinking" });
    expect(mapHookPayload({ hook_event_name: "UserPromptSubmit", prompt: "fix the bug" }, { ...ctx, showPrompts: true })).toEqual({
      type: "thinking",
      text: "fix the bug",
    });
    expect(mapHookPayload({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }, { ...ctx, showCommands: false })).toMatchObject({
      text: "Running a command",
    });
  });

  it("maps generic events", () => {
    expect(mapAny({ type: "action", text: "Refactoring parser", tool: "aider" }, ctx)).toEqual({ type: "action", text: "Refactoring parser", tool: "aider" });
    expect(mapAny({ type: "waiting" }, ctx)).toEqual({ type: "waiting" });
    expect(mapAny({ type: "nope" }, ctx)).toEqual({ type: "ignore" });
    expect(mapAny("x", ctx)).toEqual({ type: "ignore" });
  });

  it("slimPayload drops file contents and tool output", () => {
    const write = session.find((p) => p.tool_name === "Write")!;
    const s = slimPayload({ ...write, tool_input: { file_path: "a", content: "x".repeat(100_000) }, tool_response: "y".repeat(100_000) });
    expect(JSON.stringify(s).length).toBeLessThan(1000);
    expect(s.tool_input).toEqual({ file_path: "a" });
    expect(s.tool_response).toBeUndefined();
  });
});

describe("AgentCollector", () => {
  function setup(idleAfterSec = 120) {
    const cfg = defaultConfig();
    const store = new Store(initialState(cfg, "r", TimerCollector.initial("s", "x", [], true)));
    const bus = new Bus();
    const col = new AgentCollector(store, bus, { root: "/work/cap", agent: { ...cfg.agent, idleAfterSec }, privacy: createPrivacy(cfg.privacy) });
    const fx: Fx[] = [];
    const todos: AgentTodo[][] = [];
    store.subscribe((e) => e.type === "fx" && fx.push(e.fx));
    bus.on("agent:todos", (t) => todos.push(t.todos));
    return { store, col, fx, todos };
  }

  it("replays a real session through the status machine", () => {
    const { store, col, fx, todos } = setup();
    expect(store.get("agent").status).toBe("offline");
    for (const p of session.slice(0, -2)) {
      col.receive(slimPayload(p));
      if (p.tool_name === "Bash" && p.hook_event_name === "PreToolUse") {
        expect(store.get("agent")).toMatchObject({ status: "working", action: "Running ls -la", tool: "Bash" });
      }
    }
    expect(store.get("agent")).toMatchObject({ status: "done", action: "Done", counts: { edits: 2, commands: 1, reads: 1 } });
    expect(todos.at(-1)).toEqual([
      { content: "Write notes", status: "completed" },
      { content: "List files", status: "completed" },
    ]);
    col.receive(session.at(-2)); // Notification
    expect(store.get("agent").status).toBe("waiting");
    expect(fx).toEqual([{ name: "agent-waiting" }]);
    col.stop();
  });

  it("goes idle after idleAfterSec without events", async () => {
    const { store, col } = setup(0.05);
    col.receive({ type: "action", text: "x" });
    await waitFor(() => store.get("agent").status === "idle", 1000);
    col.stop();
  });
});

describe("hook command", () => {
  const cli = path.join(import.meta.dirname, "..", "dist", "cli.js");
  let app: App | undefined;
  let dir: string;

  beforeAll(() => {
    execFileSync("npm", ["run", "build"], { cwd: path.join(import.meta.dirname, ".."), stdio: "ignore", shell: process.platform === "win32" });
    dir = tmpRepo();
  }, 60_000);
  afterAll(async () => {
    await app?.stop();
    rm(dir);
  });

  function runHook(payload: unknown, cwd = dir): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const child = spawn(process.execPath, [cli, "hook"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (b) => (stdout += b));
      child.stderr.on("data", (b) => (stderr += b));
      child.on("close", (code) => resolve({ code, stdout, stderr, ms: performance.now() - t0 }));
      child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    });
  }

  it("without a server: exits 0 silently", async () => {
    const r = await runHook({ hook_event_name: "Stop", cwd: dir });
    expect(r).toMatchObject({ code: 0, stdout: "", stderr: "" });
  });

  it("garbage input and non-repo cwd: exits 0 silently", async () => {
    expect(await runHook("{not json")).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(await runHook({ hook_event_name: "Stop", cwd: "/" }, "/")).toMatchObject({ code: 0, stdout: "" });
  });

  it("with a server: forwards the event quickly and prints nothing", async () => {
    app = await createApp(await resolveRepo(dir), mergeLayers([{ source: "t", data: { port: 0 } }]));
    const sub = path.join(dir, "src", "deep");
    mkdirSync(sub, { recursive: true });
    const r = await runHook({ hook_event_name: "PreToolUse", cwd: sub, tool_name: "Edit", tool_input: { file_path: path.join(dir, "src/a.ts") } });
    expect(r).toMatchObject({ code: 0, stdout: "", stderr: "" });
    await waitFor(() => app!.store.get("agent").action === "Editing src/a.ts");
    // Budget: node startup + request. Measure a warm run.
    const warm = await runHook({ hook_event_name: "Stop", cwd: dir });
    expect(warm.ms).toBeLessThan(process.env.CI ? 1000 : 300);
    await waitFor(() => app!.store.get("agent").status === "done");
  });

  it("with a stale server.json (dead port): still fast and silent", async () => {
    await app?.stop();
    app = undefined;
    mkdirSync(path.join(dir, ".git", "stream-overlay"), { recursive: true });
    writeFileSync(path.join(dir, ".git", "stream-overlay", "server.json"), JSON.stringify({ port: 1, token: "x" }));
    const r = await runHook({ hook_event_name: "Stop", cwd: dir });
    expect(r).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(r.ms).toBeLessThan(1500);
  });
});

describe("settings merge", () => {
  const CMD = hookCommand("/usr/bin/node", "/opt/lib/node_modules/stream-overlay/dist/cli.js", "linux");

  it("builds a quoted command; Windows paths use forward slashes", () => {
    expect(CMD).toBe('"/usr/bin/node" "/opt/lib/node_modules/stream-overlay/dist/cli.js" hook');
    expect(hookCommand("C:\\node\\node.exe", "C:\\x\\stream-overlay\\dist\\cli.js", "win32")).toBe(
      '"C:/node/node.exe" "C:/x/stream-overlay/dist/cli.js" hook',
    );
    expect(isOurs({ type: "command", command: CMD })).toBe(true);
    expect(isOurs({ type: "command", command: "other-tool hook" })).toBe(false);
  });

  it("preserves existing keys and hooks; is idempotent", () => {
    const existing = {
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }] },
    };
    const once = addHooks(existing, CMD);
    const twice = addHooks(once, CMD);
    expect(twice).toEqual(once);
    expect(once.permissions).toEqual(existing.permissions);
    const pre = (once.hooks as Record<string, unknown[]>).PreToolUse;
    expect(pre).toHaveLength(2);
    expect(pre[0]).toEqual(existing.hooks.PreToolUse[0]);
    expect(pre[1]).toEqual({ matcher: "*", hooks: [{ type: "command", command: CMD, timeout: 5 }] });
    expect((once.hooks as Record<string, unknown[]>).Stop).toEqual([{ hooks: [{ type: "command", command: CMD, timeout: 5 }] }]);
    expect(removeHooks(once)).toEqual(existing);
  });

  it("removes ours from mixed groups and cleans empties", () => {
    const s = { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo keep" }, { type: "command", command: CMD }] }] } };
    expect(removeHooks(s)).toEqual({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo keep" }] }] } });
    expect(removeHooks(addHooks({}, CMD))).toEqual({});
  });
});

describe("hooks install/uninstall on disk", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach(rm));
  const CLI = "/opt/lib/node_modules/stream-overlay/dist/cli.js";

  async function repo() {
    const d = tmpRepo();
    dirs.push(d);
    return { d, paths: await resolveRepo(d) };
  }

  it("creates the file, keeps git status clean, and uninstall restores the tree exactly", async () => {
    const { d, paths } = await repo();
    const excludeBefore = readFileSync(path.join(d, ".git", "info", "exclude"), "utf8");
    await installHooks(paths, { cliPath: CLI, quiet: true });
    const file = path.join(d, ".claude", "settings.local.json");
    expect(hasOurHooks(JSON.parse(readFileSync(file, "utf8")))).toBe(true);
    expect(sh(d, "status", "--porcelain")).toBe("");
    await installHooks(paths, { cliPath: CLI, quiet: true }); // idempotent
    await uninstallHooks(paths, { quiet: true });
    expect(existsSync(file)).toBe(false);
    expect(existsSync(path.join(d, ".claude"))).toBe(false);
    expect(readFileSync(path.join(d, ".git", "info", "exclude"), "utf8")).toBe(excludeBefore);
  });

  it("restores an existing file byte-for-byte", async () => {
    const { d, paths } = await repo();
    const file = path.join(d, ".claude", "settings.local.json");
    mkdirSync(path.dirname(file), { recursive: true });
    const original = '{\n    "permissions": {"allow": ["Bash(ls:*)"]},\n    "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "say done"}]}]}\n}\n';
    writeFileSync(file, original);
    await installHooks(paths, { cliPath: CLI, quiet: true });
    const installed = JSON.parse(readFileSync(file, "utf8"));
    expect(installed.hooks.Stop).toHaveLength(2);
    expect(installed.permissions).toEqual({ allow: ["Bash(ls:*)"] });
    await uninstallHooks(paths, { quiet: true });
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("restores semantically when the user changed the file meanwhile", async () => {
    const { d, paths } = await repo();
    const file = path.join(d, ".claude", "settings.local.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{"model": "opus"}');
    await installHooks(paths, { cliPath: CLI, quiet: true });
    const cur = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, serialize({ ...cur, env: { A: "1" } }));
    await uninstallHooks(paths, { quiet: true });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ model: "opus", env: { A: "1" } });
  });
});
