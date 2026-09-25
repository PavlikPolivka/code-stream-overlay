import { readFileSync } from "node:fs";
import path from "node:path";
import { SHARED_CONFIG_FILE } from "../constants.js";
import { globalConfigPath } from "../util/paths.js";
import { configSchema, type Config } from "./schema.js";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep merge for objects; arrays and scalars from `b` replace `a`. `undefined` in `b` is skipped. */
export function mergeDeep(a: Obj, b: Obj): Obj {
  const out: Obj = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    out[k] = isObj(v) && isObj(out[k]) ? mergeDeep(out[k] as Obj, v) : v;
  }
  return out;
}

export class ConfigError extends Error {}

export interface ConfigLayer {
  source: string;
  data: Obj;
  /** Shared (committed) files can't run commands unless trusted. */
  shared?: boolean;
}

/** Validate every layer on its own (for precise errors), then merge and validate the result. */
export function mergeLayers(layers: ConfigLayer[], opts: { trustRepoConfig?: boolean } = {}): Config {
  let merged: Obj = {};
  const partial = configSchema.deepPartial();
  for (const layer of layers) {
    const r = partial.safeParse(layer.data);
    if (!r.success) throw new ConfigError(formatIssues(layer.source, r.error.issues));
    let data = layer.data;
    if (layer.shared && !opts.trustRepoConfig && Array.isArray(data.custom) && data.custom.length) {
      data = { ...data };
      delete data.custom;
      console.warn(`warn: ignoring "custom" commands in ${layer.source} (start with --trust-repo-config to allow)`);
    }
    merged = mergeDeep(merged, data);
  }
  const r = configSchema.safeParse(merged);
  if (!r.success) throw new ConfigError(formatIssues("merged config", r.error.issues));
  return r.data;
}

function formatIssues(source: string, issues: { path: (string | number)[]; message: string }[]): string {
  return [`invalid config in ${source}:`, ...issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)].join("\n");
}

function readJson(file: string): Obj | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const v = JSON.parse(text);
    if (!isObj(v)) throw new Error("top level must be an object");
    return v;
  } catch (e) {
    throw new ConfigError(`invalid JSON in ${file}: ${(e as Error).message}`);
  }
}

export interface LoadOptions {
  root: string;
  stateDir: string;
  /** --config <path>: replaces the private repo file. */
  configPath?: string;
  cli?: Obj;
  trustRepoConfig?: boolean;
}

export interface Loaded {
  config: Config;
  sources: string[];
  /** Set when the shared file contains obs.password. */
  sharedHasPassword: boolean;
}

export function loadConfig(o: LoadOptions): Loaded {
  const layers: ConfigLayer[] = [];
  const g = globalConfigPath();
  const shared = path.join(o.root, SHARED_CONFIG_FILE);
  const priv = o.configPath ? path.resolve(o.configPath) : path.join(o.stateDir, "config.json");
  const gData = readJson(g);
  if (gData) layers.push({ source: g, data: gData });
  const sData = readJson(shared);
  if (sData) layers.push({ source: shared, data: sData, shared: true });
  const pData = readJson(priv);
  if (pData) layers.push({ source: priv, data: pData });
  if (o.cli && Object.keys(o.cli).length) layers.push({ source: "command line", data: o.cli });
  return {
    config: mergeLayers(layers, { trustRepoConfig: o.trustRepoConfig }),
    sources: layers.map((l) => l.source),
    sharedHasPassword: !!(sData && isObj(sData.obs) && sData.obs.password),
  };
}
