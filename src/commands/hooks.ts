import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { PKG_NAME } from "../constants.js";
import { addHooks, hasOurHooks, hookCommand, removeHooks, serialize } from "../claude/settings.js";
import { git } from "../util/exec.js";
import { CliError } from "../util/errors.js";
import { log } from "../util/log.js";
import type { RepoPaths } from "../util/paths.js";

const SETTINGS_REL = path.join(".claude", "settings.local.json");
const EXCLUDE_LINE = "/.claude/settings.local.json";

interface InstallRecord {
  /** We created settings.local.json (uninstall may delete it). */
  createdFile: boolean;
  /** We created .claude/ (uninstall may remove it if empty). */
  createdDir: boolean;
  /** We added a line to .git/info/exclude. */
  addedExclude: boolean;
}

const recordPath = (repo: RepoPaths) => path.join(repo.stateDir, "hooks.json");

function readRecord(repo: RepoPaths): InstallRecord | undefined {
  try {
    return JSON.parse(readFileSync(recordPath(repo), "utf8"));
  } catch {
    return undefined;
  }
}

function readSettings(file: string): { data: Record<string, unknown>; existed: boolean } {
  if (!existsSync(file)) return { data: {}, existed: false };
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return { data: {}, existed: true };
  try {
    const data = JSON.parse(text);
    if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("not an object");
    return { data, existed: true };
  } catch (e) {
    throw new CliError(`cannot parse ${file}: ${(e as Error).message}. Fix it and try again.`);
  }
}

export function currentCliPath(): string {
  // dist/commands/hooks.js → dist/cli.js
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
}

async function isIgnored(root: string, rel: string): Promise<boolean> {
  try {
    await git(root, ["check-ignore", "-q", rel]);
    return true;
  } catch {
    return false;
  }
}

async function commonGitDir(repo: RepoPaths): Promise<string> {
  try {
    return path.resolve(repo.root, (await git(repo.root, ["rev-parse", "--git-common-dir"])).trim());
  } catch {
    return repo.gitDir;
  }
}

export async function installHooks(repo: RepoPaths, opts: { cliPath?: string; nodePath?: string; quiet?: boolean } = {}): Promise<string> {
  const cliPath = opts.cliPath ?? currentCliPath();
  const file = path.join(repo.root, SETTINGS_REL);
  const { data, existed } = readSettings(file);
  const prevRecord = readRecord(repo);
  const dirExisted = existsSync(path.dirname(file));

  mkdirSync(repo.stateDir, { recursive: true });
  const bak = path.join(repo.stateDir, "settings.local.json.bak");
  if (existed && !existsSync(bak) && !hasOurHooks(data)) copyFileSync(file, bak);

  const command = hookCommand(opts.nodePath ?? process.execPath, cliPath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, serialize(addHooks(data, command)));

  // Keep `git status` clean: ignore the local settings file via .git/info/exclude if nothing else does.
  let addedExclude = prevRecord?.addedExclude ?? false;
  if (!(await isIgnored(repo.root, SETTINGS_REL.split(path.sep).join("/")))) {
    const exclude = path.join(await commonGitDir(repo), "info", "exclude");
    mkdirSync(path.dirname(exclude), { recursive: true });
    const cur = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    writeFileSync(exclude, `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}${EXCLUDE_LINE}\n`);
    addedExclude = true;
  }

  const record: InstallRecord = {
    createdFile: prevRecord ? prevRecord.createdFile : !existed,
    createdDir: prevRecord ? prevRecord.createdDir : !dirExisted,
    addedExclude,
  };
  writeFileSync(recordPath(repo), JSON.stringify(record, null, 2));

  if (!opts.quiet) {
    log.info(`Claude Code hooks installed in ${SETTINGS_REL}`);
    if (cliPath.includes("_npx")) {
      log.warn(`the hook points into the npx cache (${cliPath}), which can be cleaned at any time.\n  Run "npm i -g ${PKG_NAME}" and then "${PKG_NAME} hooks install" again for a stable path.`);
    }
  }
  return command;
}

export async function uninstallHooks(repo: RepoPaths, opts: { quiet?: boolean } = {}): Promise<boolean> {
  const file = path.join(repo.root, SETTINGS_REL);
  const record = readRecord(repo);
  const { data, existed } = readSettings(file);
  let changed = false;
  if (existed && hasOurHooks(data)) {
    const next = removeHooks(data);
    const bak = path.join(repo.stateDir, "settings.local.json.bak");
    if (!Object.keys(next).length && record?.createdFile !== false) rmSync(file);
    else if (existsSync(bak) && isDeepStrictEqual(next, readSettings(bak).data)) copyFileSync(bak, file); // byte-for-byte
    else writeFileSync(file, serialize(next));
    changed = true;
  }
  if (record?.createdDir) {
    const dir = path.dirname(file);
    try {
      if (existsSync(dir) && !readdirSync(dir).length) rmdirSync(dir);
    } catch {
      /* not empty or gone */
    }
  }
  if (record?.addedExclude) {
    const exclude = path.join(await commonGitDir(repo), "info", "exclude");
    if (existsSync(exclude)) {
      const lines = readFileSync(exclude, "utf8").split("\n");
      const idx = lines.lastIndexOf(EXCLUDE_LINE);
      if (idx >= 0) {
        lines.splice(idx, 1);
        writeFileSync(exclude, lines.join("\n"));
      }
    }
  }
  rmSync(recordPath(repo), { force: true });
  if (!opts.quiet) log.info(changed ? `Claude Code hooks removed from ${SETTINGS_REL}` : "no hooks of ours were installed");
  return changed;
}

export function hooksInstalled(repo: RepoPaths): boolean {
  try {
    return hasOurHooks(readSettings(path.join(repo.root, SETTINGS_REL)).data);
  } catch {
    return false;
  }
}
