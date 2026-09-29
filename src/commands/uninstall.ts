import { existsSync, rmSync } from "node:fs";
import { PKG_NAME } from "../constants.js";
import { recordPath } from "../obs/install.js";
import { CliError } from "../util/errors.js";
import { log } from "../util/log.js";
import { repoOrExit, runningServer, type GlobalFlags } from "./common.js";
import { uninstallHooks } from "./hooks.js";

/** Remove hooks and OBS sources; --purge also deletes .git/stream-overlay/. */
export async function uninstall(flags: GlobalFlags): Promise<void> {
  const repo = await repoOrExit();
  if (flags.purge && (await runningServer(repo))) {
    throw new CliError(`stop the running ${PKG_NAME} server first (Ctrl+C in its terminal).`);
  }
  await uninstallHooks(repo);
  if (existsSync(recordPath(repo.stateDir))) {
    const { obs } = await import("./obs.js");
    try {
      await obs("uninstall", flags);
    } catch (e) {
      log.warn(`OBS sources were not removed: ${(e as Error).message}`);
      if (flags.purge) throw new CliError(`not purging, so the record of OBS sources is kept. Retry with OBS running.`);
    }
  }
  if (flags.purge) {
    rmSync(repo.stateDir, { recursive: true, force: true });
    log.info(`removed ${repo.stateDir}`);
  }
}
