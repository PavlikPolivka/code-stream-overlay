import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { PKG_NAME, SHARED_CONFIG_FILE } from "../constants.js";
import { mergeDeep } from "../config/load.js";
import { detectStacks, onPath } from "../collectors/tests/adapters/index.js";
import { resolvePlan } from "../collectors/tests/collector.js";
import type { TriggerMode } from "../state/types.js";
import { log } from "../util/log.js";
import { installHooks } from "./hooks.js";
import { loadOrExit, repoOrExit, type GlobalFlags } from "./common.js";

const MODES: TriggerMode[] = ["passive", "save", "commit", "interval", "manual"];
const SOURCES = ["file", "claude-todos", "both", "off"] as const;

const STARTER_GOALS = `# What we're building today

- [ ] First goal
- [ ] Second goal

## Stretch

- [ ] Something extra
`;

async function ask(rl: Interface | undefined, q: string, def: string): Promise<string> {
  if (!rl) return def;
  const a = (await rl.question(`${q} [${def}] `)).trim();
  return a || def;
}

async function choose<T extends string>(rl: Interface | undefined, q: string, options: readonly T[], def: T): Promise<T> {
  for (;;) {
    const a = await ask(rl, `${q} (${options.join(" / ")})`, def);
    const hit = options.find((o) => o === a || o.startsWith(a));
    if (hit) return hit;
    log.info(`  please pick one of: ${options.join(", ")}`);
  }
}

const yes = async (rl: Interface | undefined, q: string, def: boolean) => /^y/i.test(await ask(rl, `${q} (y/n)`, def ? "y" : "n"));

export async function init(flags: GlobalFlags): Promise<void> {
  const repo = await repoOrExit();
  const { config } = loadOrExit(repo, flags);
  const stacks = await detectStacks(repo.root);
  const adapter = stacks[0];
  const plan = resolvePlan(adapter, config.tests, { root: repo.root, stateDir: repo.stateDir, platform: process.platform });
  const interactive = !flags.yes && process.stdin.isTTY;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;

  try {
    log.info(`${PKG_NAME} setup for ${path.basename(repo.root)}\n`);
    log.info(stacks.length ? `  Detected: ${stacks.map((s) => s.label).join(", ")}` : "  No test stack detected.");
    if (plan) log.info(`  Test command: ${plan.command}`);
    log.info("");

    const out: Record<string, unknown> = {};

    if (plan) {
      const mode = await choose(rl, "When should tests update?", MODES, plan.mode);
      if (mode !== adapter?.defaultMode) out.tests = { mode };
    }

    const source = await choose(rl, "Goals come from", SOURCES, config.goals.source);
    const goals: Record<string, unknown> = {};
    if (source !== "file") goals.source = source;
    if (source === "file" || source === "both") {
      const current = path.join(repo.root, config.goals.file);
      if (!existsSync(current)) {
        const where = await choose(rl, "No goals file yet. Create a starter one", ["private", "GOALS.md", "no"] as const, "private");
        if (where !== "no") {
          const rel = where === "private" ? path.relative(repo.root, path.join(repo.stateDir, "goals.md")).split(path.sep).join("/") : "GOALS.md";
          const file = path.join(repo.root, rel);
          mkdirSync(path.dirname(file), { recursive: true });
          if (!existsSync(file)) writeFileSync(file, STARTER_GOALS);
          if (rel !== "GOALS.md") goals.file = rel;
          log.info(`  wrote ${rel}`);
        }
      }
    }
    if (Object.keys(goals).length) out.goals = goals;

    const target = await choose(rl, "Save settings where? private = only on this machine", ["private", "shared"] as const, "private");
    const file = target === "private" ? path.join(repo.stateDir, "config.json") : path.join(repo.root, SHARED_CONFIG_FILE);
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      /* new file */
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(mergeDeep(existing, out), null, 2) + "\n");
    log.info(`  saved ${path.relative(repo.root, file)}`);

    if (await yes(rl, "Install Claude Code hooks (shows what the agent is doing)?", onPath("claude"))) {
      await installHooks(repo);
    }

    if (await yes(rl, "Add browser sources to OBS now (OBS must be running)?", false)) {
      const { obs } = await import("./obs.js");
      try {
        await obs("install", flags);
      } catch (e) {
        log.warn(`${(e as Error).message}\n  You can run "${PKG_NAME} obs install" later.`);
      }
    }

    log.info(`\nDone. Start the overlay with: ${PKG_NAME}`);
  } finally {
    rl?.close();
  }
}
