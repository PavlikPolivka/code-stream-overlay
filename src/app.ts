import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EMPTY_TREE, VERSION } from "./constants.js";
import type { Config } from "./config/schema.js";
import { Bus } from "./state/bus.js";
import { Store } from "./state/store.js";
import type { State } from "./state/types.js";
import { TimerCollector, phasesFor } from "./collectors/timer.js";
import type { Collector } from "./collectors/types.js";
import { FilesCollector } from "./collectors/files.js";
import { GitCollector } from "./collectors/git.js";
import { createPrivacy, type Privacy } from "./privacy.js";
import { ADAPTERS, detectStacks, type StackAdapter } from "./collectors/tests/adapters/index.js";
import { TestsCollector, resolvePlan } from "./collectors/tests/collector.js";
import { CliError } from "./util/errors.js";
import { startServer, type RunningServer } from "./server/http.js";
import type { Api } from "./server/routes.js";
import { newToken } from "./server/auth.js";
import { git } from "./util/exec.js";
import { webRoot, type RepoPaths } from "./util/paths.js";
import { log } from "./util/log.js";

export interface ServerInfo {
  pid: number;
  port: number;
  token: string;
  startedAt: number;
}

export interface App {
  store: Store;
  bus: Bus;
  server: RunningServer;
  info: ServerInfo;
  config: Config;
  repo: RepoPaths;
  timer: TimerCollector;
  git: GitCollector;
  tests?: TestsCollector;
  privacy: Privacy;
  collectors: Collector[];
  stop(): Promise<void>;
}

export function initialState(config: Config, repoName: string, session: State["session"]): State {
  return {
    meta: {
      version: VERSION,
      theme: config.display.theme,
      tone: config.display.tone,
      labels: config.display.labels,
      confetti: config.display.confetti,
    },
    project: {
      name: repoName,
      title: config.title ?? undefined,
      subtitle: config.subtitle ?? undefined,
      stacks: [],
    },
    session,
    git: { branch: "", headSha: "", added: 0, removed: 0, filesChanged: 0, untracked: 0, commits: [] },
    activity: { recent: [] },
    tests: { status: "idle", mode: "manual", total: 0, passed: 0, failed: 0, skipped: 0, runs: 0 },
    goals: { source: config.goals.source, items: [], done: 0, total: 0 },
    agent: { status: "offline", counts: { edits: 0, commands: 0, reads: 0 } },
    custom: {},
  };
}

export async function headSha(root: string): Promise<string | undefined> {
  try {
    return (await git(root, ["rev-parse", "--verify", "-q", "HEAD"])).trim() || undefined;
  } catch {
    return undefined;
  }
}

function pickAdapter(setting: string, stacks: StackAdapter[]): StackAdapter | undefined {
  if (setting === "auto") return stacks[0];
  if (setting === "off") return undefined;
  const a = ADAPTERS.find((x) => x.id === setting);
  if (!a) throw new CliError(`tests.adapter "${setting}" is not one of: auto, off, ${ADAPTERS.map((x) => x.id).join(", ")}`);
  return a;
}

export function serverJsonPath(repo: RepoPaths): string {
  return path.join(repo.stateDir, "server.json");
}

export async function createApp(repo: RepoPaths, config: Config): Promise<App> {
  const repoName = path.basename(repo.root);
  const startSha = (await headSha(repo.root)) ?? EMPTY_TREE;
  const phases = phasesFor(config.session);
  const session = TimerCollector.initial(randomUUID().slice(0, 8), startSha, phases, config.session.autoStart);
  const store = new Store(initialState(config, repoName, session));
  const bus = new Bus();
  const timer = new TimerCollector(store, { phases, autoStart: config.session.autoStart });
  const privacy = createPrivacy(config.privacy);

  const stacks = await detectStacks(repo.root);
  const adapter = pickAdapter(config.tests.adapter, stacks);
  const plan =
    config.tests.adapter === "off"
      ? undefined
      : resolvePlan(adapter, config.tests, { root: repo.root, stateDir: repo.stateDir, platform: process.platform });
  store.update("project", (p) => ({ ...p, stacks: stacks.map((s) => s.label) }));
  if (plan) store.update("tests", (t) => ({ ...t, adapter: plan.adapter, mode: plan.mode }));

  const ignoreDirs = [...new Set(stacks.flatMap((s) => s.ignore))];
  const files = new FilesCollector(store, bus, { root: repo.root, ignoreDirs, privacy });
  const gitCollector = new GitCollector(store, bus, { root: repo.root, gitDir: repo.gitDir, privacy });
  const tests = plan
    ? new TestsCollector(store, bus, { root: repo.root, plan, privacy, since: session.startedAt })
    : undefined;
  const collectors: Collector[] = [timer, files, gitCollector, ...(tests ? [tests] : [])];

  const api: Api = {
    session: (action) => timer.action(action),
    runTests: tests ? () => tests.run() : undefined,
    setState: (key, value) => {
      if (key === "title" || key === "subtitle") {
        store.update("project", (p) => ({ ...p, [key]: value === null ? undefined : String(value) }));
      } else {
        store.update("custom", (c) => {
          const next = { ...c };
          if (value === null) delete next[key];
          else next[key] = value as string | number;
          return next;
        });
      }
    },
  };

  const token = newToken();
  const server = await startServer({
    store,
    host: config.host,
    port: config.port,
    token,
    webDir: webRoot(),
    repoName,
    api,
  });

  for (const c of collectors) {
    try {
      await c.start();
    } catch (e) {
      log.warn(`collector failed to start: ${(e as Error).message}`);
    }
  }

  const info: ServerInfo = { pid: process.pid, port: server.port, token, startedAt: session.startedAt };
  mkdirSync(repo.stateDir, { recursive: true });
  writeFileSync(serverJsonPath(repo), JSON.stringify(info, null, 2), { mode: 0o600 });

  let stopped = false;
  return {
    store,
    bus,
    server,
    info,
    config,
    repo,
    timer,
    git: gitCollector,
    tests,
    privacy,
    collectors,
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const c of collectors) {
        try {
          await c.stop();
        } catch {
          /* best effort */
        }
      }
      await server.close();
      rmSync(serverJsonPath(repo), { force: true });
    },
  };
}
