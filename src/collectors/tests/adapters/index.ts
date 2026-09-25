import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { TriggerMode } from "../../../state/types.js";

export type ParserId = "junit" | "trx" | "go-json" | "exit-code";

export interface AdapterContext {
  root: string;
  /** Absolute .git/stream-overlay dir, for tools that need an output path. */
  stateDir: string;
  platform: NodeJS.Platform;
}

export interface StackAdapter {
  id: string;
  label: string;
  detect(root: string): Promise<boolean>;
  /** Shell command; prefers wrappers when present. */
  command(ctx: AdapterContext): string;
  /** Report globs, repo-relative (or absolute, for files under stateDir). */
  reports(ctx: AdapterContext): string[];
  parser(ctx: AdapterContext): ParserId;
  /** Directory names the file watcher must skip. */
  ignore: string[];
  defaultMode: TriggerMode;
  debounceMs: number;
}

const has = (root: string, ...names: string[]) => names.some((n) => existsSync(path.join(root, n)));

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Is `name` an executable on PATH? (no spawn) */
export function onPath(name: string, env = process.env, platform = process.platform): boolean {
  const exts = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").concat([""]) : [""];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) if (existsSync(path.join(dir, name + ext))) return true;
  }
  return false;
}

/** Repo-relative when inside the repo, so commands and messages stay short. */
function rel(ctx: AdapterContext, p: string): string {
  const r = path.relative(ctx.root, p);
  return r && !r.startsWith("..") && !path.isAbsolute(r) ? r.split(path.sep).join("/") : p;
}

const quote = (p: string) => (/[\s"]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p);

const JVM_DEBOUNCE = 5000;
const DEFAULT_DEBOUNCE = 1500;
const NPM_DEFAULT_TEST = /no test specified/;

export const maven: StackAdapter = {
  id: "maven",
  label: "Maven",
  detect: async (root) => has(root, "pom.xml"),
  command: ({ root, platform }) => {
    if (platform === "win32" && has(root, "mvnw.cmd")) return "mvnw.cmd -q test";
    if (platform !== "win32" && has(root, "mvnw")) return "./mvnw -q test";
    return "mvn -q test";
  },
  reports: () => ["**/target/surefire-reports/TEST-*.xml"],
  parser: () => "junit",
  ignore: ["target"],
  defaultMode: "passive",
  debounceMs: JVM_DEBOUNCE,
};

export const gradle: StackAdapter = {
  id: "gradle",
  label: "Gradle",
  detect: async (root) => has(root, "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"),
  command: ({ root, platform }) => {
    if (platform === "win32" && has(root, "gradlew.bat")) return "gradlew.bat test";
    if (platform !== "win32" && has(root, "gradlew")) return "./gradlew test";
    return "gradle test";
  },
  reports: () => ["**/build/test-results/**/*.xml"],
  parser: () => "junit",
  ignore: ["build", ".gradle"],
  defaultMode: "passive",
  debounceMs: JVM_DEBOUNCE,
};

export const node: StackAdapter = {
  id: "node",
  label: "Node",
  detect: async (root) => {
    const pkg = readJson(path.join(root, "package.json"));
    const test = (pkg?.scripts as Record<string, unknown> | undefined)?.test;
    return typeof test === "string" && !NPM_DEFAULT_TEST.test(test);
  },
  command: ({ root }) => {
    if (has(root, "pnpm-lock.yaml")) return "pnpm test";
    if (has(root, "yarn.lock")) return "yarn test";
    if (has(root, "bun.lockb", "bun.lock")) return "bun run test";
    return "npm test";
  },
  reports: () => [],
  parser: () => "exit-code",
  ignore: ["node_modules", "dist", "coverage"],
  defaultMode: "save",
  debounceMs: DEFAULT_DEBOUNCE,
};

export const python: StackAdapter = {
  id: "python",
  label: "Python",
  detect: async (root) => has(root, "pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini"),
  command: (ctx) => `pytest -q --junitxml=${quote(rel(ctx, path.join(ctx.stateDir, "pytest.xml")))}`,
  reports: (ctx) => [path.join(ctx.stateDir, "pytest.xml")],
  parser: () => "junit",
  ignore: ["__pycache__", ".venv", "venv", ".pytest_cache", ".tox", ".mypy_cache"],
  defaultMode: "save",
  debounceMs: DEFAULT_DEBOUNCE,
};

export const go: StackAdapter = {
  id: "go",
  label: "Go",
  detect: async (root) => has(root, "go.mod"),
  command: () => "go test -json ./...",
  reports: () => [],
  parser: () => "go-json",
  ignore: [],
  defaultMode: "save",
  debounceMs: DEFAULT_DEBOUNCE,
};

/** nextest writes JUnit only when a profile configures it. */
function nextestJunit(root: string): boolean {
  try {
    return /^\s*\[profile\.[\w-]+\.junit\]/m.test(readFileSync(path.join(root, ".config", "nextest.toml"), "utf8"));
  } catch {
    return false;
  }
}

export const rust: StackAdapter = {
  id: "rust",
  label: "Rust",
  detect: async (root) => has(root, "Cargo.toml"),
  command: () => (onPath("cargo-nextest") ? "cargo nextest run" : "cargo test"),
  reports: ({ root }) => (onPath("cargo-nextest") && nextestJunit(root) ? ["target/nextest/**/*.xml"] : []),
  parser: ({ root }) => (onPath("cargo-nextest") && nextestJunit(root) ? "junit" : "exit-code"),
  ignore: ["target"],
  defaultMode: "save",
  debounceMs: DEFAULT_DEBOUNCE,
};

export const dotnet: StackAdapter = {
  id: "dotnet",
  label: ".NET",
  detect: async (root) => {
    try {
      return readdirSync(root).some((f) => /\.(sln|slnx|csproj|fsproj)$/i.test(f));
    } catch {
      return false;
    }
  },
  command: (ctx) =>
    `dotnet test --logger "trx;LogFileName=so.trx" --results-directory ${quote(rel(ctx, path.join(ctx.stateDir, "trx")))}`,
  reports: (ctx) => [path.join(ctx.stateDir, "trx", "*.trx")],
  parser: () => "trx",
  ignore: ["bin", "obj"],
  defaultMode: "commit",
  debounceMs: DEFAULT_DEBOUNCE,
};

export const make: StackAdapter = {
  id: "make",
  label: "Make",
  detect: async (root) => {
    for (const f of ["Makefile", "makefile", "GNUmakefile"]) {
      try {
        if (/^test\s*:/m.test(readFileSync(path.join(root, f), "utf8"))) return true;
      } catch {
        /* next */
      }
    }
    return false;
  },
  command: () => "make test",
  reports: () => [],
  parser: () => "exit-code",
  ignore: [],
  defaultMode: "manual",
  debounceMs: DEFAULT_DEBOUNCE,
};

/** Detection order: the first match is used unless tests.adapter pins one. */
export const ADAPTERS: StackAdapter[] = [maven, gradle, node, python, go, rust, dotnet, make];

export async function detectStacks(root: string): Promise<StackAdapter[]> {
  const hits = await Promise.all(ADAPTERS.map((a) => a.detect(root).catch(() => false)));
  return ADAPTERS.filter((_, i) => hits[i]);
}
