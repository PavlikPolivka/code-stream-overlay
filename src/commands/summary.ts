import { PKG_NAME } from "../constants.js";
import { latestSummary, toMarkdown, type SessionSummary } from "../summary.js";
import { CliError } from "../util/errors.js";
import { log } from "../util/log.js";
import { callServer, repoOrExit, runningServer } from "./common.js";

/** Current session from the running server, else the last saved one. */
export async function summary(json: boolean): Promise<void> {
  const repo = await repoOrExit();
  const live = (await runningServer(repo)) ? ((await callServer(repo, "GET", "/api/summary")) as SessionSummary) : undefined;
  const s = live ?? latestSummary(repo.stateDir);
  if (!s) throw new CliError(`no session yet. Start one with "${PKG_NAME}".`);
  log.info(json ? JSON.stringify(s, null, 2) : toMarkdown(s));
}
