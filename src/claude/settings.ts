import { PKG_NAME } from "../constants.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Notification", "Stop"] as const;
const TOOL_EVENTS = new Set<string>(["PreToolUse", "PostToolUse"]);
export const HOOK_TIMEOUT_SEC = 5;

/** `"<node>" "<cli.js>" hook`, quoted for Windows (forward slashes work in cmd and bash). */
export function hookCommand(nodePath: string, cliPath: string, platform = process.platform): string {
  const fix = (p: string) => (platform === "win32" ? p.replace(/\\/g, "/") : p);
  return `"${fix(nodePath)}" "${fix(cliPath)}" hook`;
}

/**
 * Ours = a command hook ending in ` hook` that mentions the package name, or one of the
 * CLI paths we installed from (a dev checkout's folder may be named differently).
 */
export function isOurs(h: unknown, cliPaths: string[] = []): boolean {
  if (!isObj(h) || typeof h.command !== "string" || !/\shook\s*$/.test(h.command)) return false;
  const cmd = h.command.replace(/\\/g, "/");
  return cmd.includes(PKG_NAME) || cliPaths.some((p) => p && cmd.includes(p.replace(/\\/g, "/")));
}

/** Remove our hooks, then empty groups, empty event arrays and an empty `hooks` object. */
export function removeHooks(settings: Obj, cliPaths: string[] = []): Obj {
  if (!isObj(settings.hooks)) return settings;
  const hooks: Obj = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups;
      continue;
    }
    const kept = groups
      .map((g) => {
        if (!isObj(g) || !Array.isArray(g.hooks)) return g;
        return { ...g, hooks: g.hooks.filter((h) => !isOurs(h, cliPaths)) };
      })
      .filter((g) => !(isObj(g) && Array.isArray(g.hooks) && g.hooks.length === 0));
    if (kept.length) hooks[event] = kept;
  }
  const out: Obj = { ...settings, hooks };
  if (!Object.keys(hooks).length) delete out.hooks;
  return out;
}

/** Idempotent: removes any previous install of ours, then adds one group per event. */
export function addHooks(settings: Obj, command: string, cliPaths: string[] = []): Obj {
  const base = removeHooks(settings, cliPaths);
  const hooks: Obj = isObj(base.hooks) ? { ...base.hooks } : {};
  for (const event of HOOK_EVENTS) {
    const list = [{ type: "command", command, timeout: HOOK_TIMEOUT_SEC }];
    const group = TOOL_EVENTS.has(event) ? { matcher: "*", hooks: list } : { hooks: list };
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    hooks[event] = [...existing, group];
  }
  return { ...base, hooks };
}

export function hasOurHooks(settings: Obj, cliPaths: string[] = []): boolean {
  if (!isObj(settings.hooks)) return false;
  return Object.values(settings.hooks).some(
    (groups) => Array.isArray(groups) && groups.some((g) => isObj(g) && Array.isArray(g.hooks) && g.hooks.some((h) => isOurs(h, cliPaths))),
  );
}

export const serialize = (o: Obj) => JSON.stringify(o, null, 2) + "\n";
