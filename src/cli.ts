#!/usr/bin/env node
import { parseArgs } from "node:util";
import { PKG_NAME, VERSION } from "./constants.js";
import { setVerbose, log } from "./util/log.js";
import { CliError } from "./util/errors.js";
import type { GlobalFlags } from "./commands/common.js";

const HELP = `${PKG_NAME} ${VERSION}: live, repo-aware overlays for OBS

Usage: ${PKG_NAME} [command] [options]

Commands:
  start (default)        Start the overlay server for this repo
  init                   Interactive setup (--yes for defaults)
  stop | pause | resume | next    Control the running session
  test                   Trigger a test run on the running server
  summary [--json]       Print the last or current session summary
  hooks install|uninstall         Claude Code hooks in .claude/settings.local.json
  obs install|uninstall           Browser sources in OBS (obs-websocket)
  uninstall [--purge]    Remove hooks and OBS sources (--purge: also local data)

Options:
  --port <n>  --host <h>  --config <path>  --theme <name>  --tone plain|playful
  --tests-mode save|commit|interval|manual|passive  --no-open  --verbose
  --trust-repo-config    Allow commands from the shared ${PKG_NAME}.json
`;

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      config: { type: "string" },
      theme: { type: "string" },
      tone: { type: "string" },
      "tests-mode": { type: "string" },
      "no-open": { type: "boolean" },
      verbose: { type: "boolean", short: "v" },
      "trust-repo-config": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      json: { type: "boolean" },
      purge: { type: "boolean" },
      scene: { type: "string" },
      widgets: { type: "boolean" },
      single: { type: "boolean" },
      "obs-password": { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
    },
  });
  const flags = values as GlobalFlags;
  setVerbose(!!values.verbose);
  if (values.help) {
    log.info(HELP);
    return 0;
  }
  if (values.version) {
    log.info(VERSION);
    return 0;
  }

  const [cmd = "start", sub] = positionals;
  switch (cmd) {
    case "start": {
      const { start } = await import("./commands/start.js");
      await start(flags);
      return 0;
    }
    default:
      throw new CliError(`unknown command "${cmd}"${sub ? ` ${sub}` : ""}\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof CliError) {
      log.error(e.message);
      process.exit(e.code);
    }
    if ((e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      log.error((e as Error).message);
      process.exit(2);
    }
    log.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
  },
);
