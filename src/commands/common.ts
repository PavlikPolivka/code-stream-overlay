import { readFileSync } from "node:fs";
import path from "node:path";
import { PKG_NAME } from "../constants.js";
import type { ServerInfo } from "../app.js";
import { loadConfig, ConfigError, type Loaded } from "../config/load.js";
import { run } from "../util/exec.js";
import { CliError } from "../util/errors.js";
import { resolveRepo, type RepoPaths } from "../util/paths.js";

export interface GlobalFlags {
  port?: string;
  host?: string;
  config?: string;
  theme?: string;
  tone?: string;
  "tests-mode"?: string;
  "no-open"?: boolean;
  verbose?: boolean;
  "trust-repo-config"?: boolean;
  [k: string]: string | boolean | undefined;
}

export { CliError };

export async function requireGit(): Promise<void> {
  try {
    await run("git", ["--version"], { cwd: process.cwd() });
  } catch {
    throw new CliError(`${PKG_NAME} needs git on your PATH. Install it from https://git-scm.com and try again.`);
  }
}

export async function repoOrExit(cwd = process.cwd()): Promise<RepoPaths> {
  await requireGit();
  try {
    return await resolveRepo(cwd);
  } catch {
    throw new CliError(`not inside a git repository: ${cwd}\nRun ${PKG_NAME} from a repo (or run "git init" first).`);
  }
}

/** Global flags as a config layer. */
export function cliLayer(f: GlobalFlags): Record<string, unknown> {
  const layer: Record<string, unknown> = {};
  if (f.port !== undefined) {
    const n = Number(f.port);
    if (!Number.isInteger(n)) throw new CliError(`--port must be a number, got "${f.port}"`);
    layer.port = n;
  }
  if (f.host) layer.host = f.host;
  const display: Record<string, unknown> = {};
  if (f.theme) display.theme = f.theme;
  if (f.tone) display.tone = f.tone;
  if (Object.keys(display).length) layer.display = display;
  if (f["tests-mode"]) layer.tests = { mode: f["tests-mode"] };
  return layer;
}

export function loadOrExit(repo: RepoPaths, f: GlobalFlags): Loaded {
  try {
    return loadConfig({
      root: repo.root,
      stateDir: repo.stateDir,
      configPath: f.config,
      cli: cliLayer(f),
      trustRepoConfig: !!f["trust-repo-config"],
    });
  } catch (e) {
    if (e instanceof ConfigError) throw new CliError(e.message);
    throw e;
  }
}

export function readServerInfo(repo: RepoPaths): ServerInfo | undefined {
  try {
    return JSON.parse(readFileSync(path.join(repo.stateDir, "server.json"), "utf8")) as ServerInfo;
  } catch {
    return undefined;
  }
}

/** Is a server for this repo alive? Checks server.json and pings /api/health. */
export async function runningServer(repo: RepoPaths): Promise<ServerInfo | undefined> {
  const info = readServerInfo(repo);
  if (!info) return undefined;
  try {
    const r = await fetch(`http://127.0.0.1:${info.port}/api/health`, { signal: AbortSignal.timeout(1000) });
    const body = (await r.json()) as { ok?: boolean; pid?: number };
    if (body.ok && (body.pid === undefined || body.pid === info.pid)) return info;
  } catch {
    /* not running */
  }
  return undefined;
}

export async function callServer(repo: RepoPaths, method: "GET" | "POST", p: string, body?: unknown): Promise<unknown> {
  const info = await runningServer(repo);
  if (!info) throw new CliError(`no ${PKG_NAME} server is running for this repo. Start one with "${PKG_NAME}".`);
  const r = await fetch(`http://127.0.0.1:${info.port}${p}`, {
    method,
    headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new CliError(`server answered ${r.status}: ${(data as { error?: string }).error ?? ""}`);
  return data;
}
