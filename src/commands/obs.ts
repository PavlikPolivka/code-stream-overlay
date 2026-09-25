import { createInterface } from "node:readline";
import { ENV_PREFIX, PKG_NAME } from "../constants.js";
import { ObsClient, ObsError } from "../obs/client.js";
import { installSources, uninstallSources } from "../obs/install.js";
import { isLoopback } from "../server/auth.js";
import { CliError } from "../util/errors.js";
import { log } from "../util/log.js";
import { loadOrExit, readServerInfo, repoOrExit, runningServer, type GlobalFlags } from "./common.js";

export const PASSWORD_ENV = `${ENV_PREFIX}_OBS_PASSWORD`;

/** Hidden-input prompt on a TTY. */
function promptPassword(question: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let asked = false;
    out._writeToOutput = (s: string) => {
      if (!asked) {
        process.stdout.write(s);
        asked = true;
      }
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer || undefined);
    });
  });
}

/** Order: --obs-password, env, obs.password from config (non-shared preferred), interactive prompt. */
export function passwordSource(flags: GlobalFlags, configPassword: string | null, sharedHasPassword: boolean) {
  return async (): Promise<string | undefined> => {
    if (typeof flags["obs-password"] === "string") return flags["obs-password"];
    if (process.env[PASSWORD_ENV]) return process.env[PASSWORD_ENV];
    if (configPassword) {
      if (sharedHasPassword) log.warn(`obs.password is set in the shared ${PKG_NAME}.json; move it to .git/${PKG_NAME}/config.json.`);
      return configPassword;
    }
    return promptPassword("OBS WebSocket password: ");
  };
}

export async function obs(sub: string | undefined, flags: GlobalFlags): Promise<void> {
  if (sub !== "install" && sub !== "uninstall") throw new CliError(`usage: ${PKG_NAME} obs install|uninstall [--scene <name>] [--single]`);
  const repo = await repoOrExit();
  const { config, sharedHasPassword } = loadOrExit(repo, flags);

  let client: ObsClient;
  try {
    client = await ObsClient.connect({
      host: config.obs.host,
      port: config.obs.port,
      password: passwordSource(flags, config.obs.password, sharedHasPassword),
    });
  } catch (e) {
    throw new CliError(e instanceof ObsError ? e.message : String(e));
  }

  try {
    if (sub === "uninstall") {
      const removed = await uninstallSources(client, repo.stateDir);
      log.info(removed.length ? `removed ${removed.length} OBS sources: ${removed.join(", ")}` : "no OBS sources of ours to remove");
      return;
    }
    const info = (await runningServer(repo)) ?? readServerInfo(repo);
    const port = info?.port ?? config.port;
    const host = isLoopback(config.host) || config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
    const mode = flags.single ? "single" : flags.widgets ? "widgets" : config.obs.mode;
    const r = await installSources(client, {
      baseUrl: `http://${host}:${port}`,
      token: isLoopback(config.host) ? undefined : info?.token,
      widgets: config.display.widgets,
      layout: config.display.layout,
      mode,
      scene: typeof flags.scene === "string" ? flags.scene : (config.obs.scene ?? undefined),
      stateDir: repo.stateDir,
    });
    log.info(`OBS: ${r.created.length} created, ${r.updated.length} updated in scene "${r.scene}"`);
    if (!info) log.warn(`the overlay isn't running; the sources point at port ${port}. Start it with "${PKG_NAME}".`);
    log.info(
      `\nAdd the control dock by hand: View → Docks → Custom Browser Docks → http://127.0.0.1:${port}/control`,
    );
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message : String(e));
  } finally {
    client.close();
  }
}
