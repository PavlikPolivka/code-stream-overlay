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

/** Ours = a command hook ending in ` hook` that mentions the package name. */
export function isOurs(h: unknown): boolean {
  return isObj(h) && typeof h.command === "string" && /\shook\s*$/.test(h.command) && h.command.includes(PKG_NAME);
}

/** Remove our hooks, then empty groups, empty event arrays and an empty `hooks` object. */
export function removeHooks(settings: Obj): Obj {
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
        return { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) };
      })
      .filter((g) => !(isObj(g) && Array.isArray(g.hooks) && g.hooks.length === 0));
    if (kept.length) hooks[event] = kept;
  }
  const out: Obj = { ...settings, hooks };
  if (!Object.keys(hooks).length) delete out.hooks;
  return out;
}

/** Idempotent: removes any previous install of ours, then adds one group per event. */
export function addHooks(settings: Obj, command: string): Obj {
  const base = removeHooks(settings);
  const hooks: Obj = isObj(base.hooks) ? { ...base.hooks } : {};
  for (const event of HOOK_EVENTS) {
    const list = [{ type: "command", command, timeout: HOOK_TIMEOUT_SEC }];
    const group = TOOL_EVENTS.has(event) ? { matcher: "*", hooks: list } : { hooks: list };
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    hooks[event] = [...existing, group];
  }
  return { ...base, hooks };
}

export function hasOurHooks(settings: Obj): boolean {
  if (!isObj(settings.hooks)) return false;
  return Object.values(settings.hooks).some(
    (groups) => Array.isArray(groups) && groups.some((g) => isObj(g) && Array.isArray(g.hooks) && g.hooks.some(isOurs)),
  );
}

export const serialize = (o: Obj) => JSON.stringify(o, null, 2) + "\n";
