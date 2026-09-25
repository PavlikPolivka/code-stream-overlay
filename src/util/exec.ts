import { execFile, spawn } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Run a program without a shell. Rejects on non-zero exit or timeout. */
export function run(
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number; input?: string; maxBuffer?: number },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 5000, maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          (err as Error & { stderr?: string }).stderr = String(stderr);
          reject(err);
        } else resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}

export function git(cwd: string, args: string[], input?: string): Promise<string> {
  return run("git", args, { cwd, input }).then((r) => r.stdout);
}

/** Kill a process and its children. */
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
    return;
  }
  try {
    process.kill(-pid, "SIGKILL"); // negative pid = process group (spawned detached)
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}
