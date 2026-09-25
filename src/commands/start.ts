import { spawn } from "node:child_process";
import { PKG_NAME } from "../constants.js";
import { createApp, type App } from "../app.js";
import { isLoopback } from "../server/auth.js";
import { log } from "../util/log.js";
import { CliError, loadOrExit, repoOrExit, runningServer, type GlobalFlags } from "./common.js";

export function banner(app: App): string {
  const s = app.store.get();
  const host = app.config.host === "0.0.0.0" || app.config.host === "::" ? "127.0.0.1" : app.config.host;
  const base = `http://${host.includes(":") ? `[${host}]` : host}:${app.info.port}`;
  const q = isLoopback(app.config.host) ? "" : `?token=${app.info.token}`;
  const stack = s.tests.adapter ? `${s.tests.adapter} (${s.tests.mode})` : s.project.stacks[0] ?? "no test stack";
  return [
    `${PKG_NAME} · ${s.project.name} · ${stack}`,
    `  Layout   ${base}/${q}`,
    `  Widgets  ${base}/w/<now|timer|git|tests|goals|commits|file|agent|custom>${q}`,
    `  Control  ${base}/control${q}`,
  ].join("\n");
}

export async function start(flags: GlobalFlags): Promise<void> {
  const repo = await repoOrExit();
  const { config, sharedHasPassword } = loadOrExit(repo, flags);
  const existing = await runningServer(repo);
  if (existing) {
    throw new CliError(`${PKG_NAME} is already running for this repo on port ${existing.port} (pid ${existing.pid}).`);
  }
  if (!isLoopback(config.host)) {
    log.warn(`binding to ${config.host}: the overlay is reachable from other machines; every URL needs the token.`);
  }
  if (sharedHasPassword) log.warn(`obs.password is set in the shared config file; move it to .git/${PKG_NAME}/config.json.`);

  const app = await createApp(repo, config);
  log.info(banner(app));
  if (!flags["no-open"] && process.stdout.isTTY && !process.env.CI) openBrowser(`http://127.0.0.1:${app.info.port}/`);

  await new Promise<void>((resolve) => {
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      await app.stop();
      resolve();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args as string[], { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref();
  } catch {
    /* no browser, fine */
  }
}
