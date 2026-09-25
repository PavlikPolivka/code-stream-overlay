import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { PKG_NAME, STATE_DIR } from "../constants.js";
import { git } from "./exec.js";

/** Package root (contains web/). Works from src/ (tests) and dist/. */
export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, "web"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("cannot locate package root");
}

export const webRoot = () => path.join(packageRoot(), "web");

export interface RepoPaths {
  root: string;
  gitDir: string;
  stateDir: string;
}

export async function resolveRepo(cwd: string): Promise<RepoPaths> {
  const out = await git(cwd, ["rev-parse", "--show-toplevel", "--absolute-git-dir"]);
  const [root, gitDir] = out.trim().split(/\r?\n/);
  return { root: path.resolve(root), gitDir: path.resolve(gitDir), stateDir: path.join(path.resolve(gitDir), STATE_DIR) };
}

/**
 * Find the git dir without spawning git: walk up from `start` looking for `.git`
 * (a directory, or a file containing `gitdir:` for worktrees/submodules).
 */
export function findGitDirSync(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, ".git");
    try {
      const st = statSync(candidate);
      if (st.isDirectory()) return candidate;
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(candidate, "utf8"));
        if (m) return path.resolve(dir, m[1].trim());
      }
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function globalConfigPath(): string {
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, PKG_NAME, "config.json");
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, PKG_NAME, "config.json");
}

/** Repo-relative path with forward slashes. */
export function toRepoRel(root: string, p: string): string {
  const rel = path.isAbsolute(p) ? path.relative(root, p) : p;
  return rel.split(path.sep).join("/");
}
