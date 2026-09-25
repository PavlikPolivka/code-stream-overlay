import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Placement } from "../state/types.js";
import { ObsClient, ObsRequestError } from "./client.js";

export const SOURCE_PREFIX = "so · ";
const NOT_FOUND = 600;

/** Default size and slot per widget on a 1920×1080 canvas (mirrors web/js/layout.js). */
export const WIDGET_SIZES: Record<string, { w: number; h: number; slot: string }> = {
  now: { w: 900, h: 90, slot: "top-left" },
  timer: { w: 360, h: 120, slot: "top-right" },
  git: { w: 360, h: 140, slot: "right-middle" },
  tests: { w: 360, h: 140, slot: "right-middle" },
  goals: { w: 420, h: 320, slot: "left-middle" },
  agent: { w: 1000, h: 70, slot: "bottom-center" },
  commits: { w: 1920, h: 48, slot: "bottom-bar" },
  file: { w: 600, h: 200, slot: "bottom-left" },
  custom: { w: 360, h: 80, slot: "bottom-right" },
};

const M = 32;
const BAR = 48;
const GAP = 12;
const W = 1920;
const H = 1080;

interface Anchor {
  x: (w: number) => number;
  top?: number;
  bottom?: number;
}

const SLOTS: Record<string, Anchor> = {
  "top-left": { x: () => M, top: M },
  "top-right": { x: (w) => W - M - w, top: M },
  "left-middle": { x: () => M, top: 180 },
  "right-middle": { x: (w) => W - M - w, top: 200 },
  "bottom-left": { x: () => M, bottom: H - BAR - M },
  "bottom-center": { x: (w) => W / 2 - w / 2, bottom: H - BAR - M },
  "bottom-right": { x: (w) => W - M - w, bottom: H - BAR - M },
  "bottom-bar": { x: () => 0, bottom: H },
};

export interface Box {
  widget: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Positions on the 1920×1080 canvas. Widgets in one slot stack; bottom slots grow upward. */
export function computeLayout(widgets: string[], layout: Record<string, Placement>): Box[] {
  const boxes: Box[] = [];
  const bySlot = new Map<string, string[]>();
  for (const name of widgets) {
    const def = WIDGET_SIZES[name];
    if (!def) continue;
    const place = layout[name] ?? { slot: def.slot };
    if ("x" in place) {
      boxes.push({ widget: name, x: place.x, y: place.y, w: place.w, h: place.h });
      continue;
    }
    const slot = SLOTS[place.slot] ? place.slot : def.slot;
    bySlot.set(slot, [...(bySlot.get(slot) ?? []), name]);
  }
  for (const [slot, names] of bySlot) {
    const a = SLOTS[slot];
    if (a.top !== undefined) {
      let y = a.top;
      for (const n of names) {
        const { w, h } = WIDGET_SIZES[n];
        boxes.push({ widget: n, x: a.x(w), y, w, h });
        y += h + GAP;
      }
    } else {
      let y = a.bottom!;
      for (const n of [...names].reverse()) {
        const { w, h } = WIDGET_SIZES[n];
        y -= h;
        boxes.push({ widget: n, x: a.x(w), y, w, h });
        y -= GAP;
      }
    }
  }
  const order = new Map(widgets.map((w, i) => [w, i]));
  return boxes.sort((a, b) => (order.get(a.widget) ?? 0) - (order.get(b.widget) ?? 0));
}

export interface ObsRecord {
  scene: string;
  inputs: string[];
}

export const recordPath = (stateDir: string) => path.join(stateDir, "obs.json");

export function readRecord(stateDir: string): ObsRecord | undefined {
  try {
    return JSON.parse(readFileSync(recordPath(stateDir), "utf8"));
  } catch {
    return undefined;
  }
}

export interface InstallOptions {
  /** Base URL of the overlay server, e.g. http://127.0.0.1:4747 */
  baseUrl: string;
  /** Appended as ?token= when the server isn't on loopback. */
  token?: string;
  widgets: string[];
  layout: Record<string, Placement>;
  mode: "widgets" | "single";
  scene?: string;
  stateDir: string;
}

export interface InstallResult {
  scene: string;
  created: string[];
  updated: string[];
}

interface SourcePlan {
  name: string;
  url: string;
  box: Box;
}

export async function installSources(obs: ObsClient, o: InstallOptions): Promise<InstallResult> {
  const video = await obs.request<{ baseWidth: number; baseHeight: number }>("GetVideoSettings");
  const sx = video.baseWidth / W;
  const sy = video.baseHeight / H;
  const scene: string =
    o.scene ??
    (await obs
      .request<{ currentProgramSceneName?: string; sceneName?: string }>("GetCurrentProgramScene")
      .then((r) => r.sceneName ?? r.currentProgramSceneName ?? ""));
  if (!scene) throw new ObsRequestError("OBS reported no current program scene; pass --scene <name>");

  const q = o.token ? `?token=${encodeURIComponent(o.token)}` : "";
  const plans: SourcePlan[] =
    o.mode === "single"
      ? [{ name: `${SOURCE_PREFIX}layout`, url: `${o.baseUrl}/${q}`, box: { widget: "layout", x: 0, y: 0, w: W, h: H } }]
      : computeLayout(o.widgets, o.layout).map((box) => ({ name: `${SOURCE_PREFIX}${box.widget}`, url: `${o.baseUrl}/w/${box.widget}${q}`, box }));

  const { inputs } = await obs.request<{ inputs: { inputName: string }[] }>("GetInputList", { inputKind: "browser_source" });
  const existing = new Set(inputs.map((i) => i.inputName));
  const result: InstallResult = { scene, created: [], updated: [] };

  for (const p of plans) {
    const settings = { url: p.url, width: p.box.w, height: p.box.h };
    let sceneItemId: number;
    if (existing.has(p.name)) {
      await obs.request("SetInputSettings", { inputName: p.name, inputSettings: settings });
      try {
        ({ sceneItemId } = await obs.request<{ sceneItemId: number }>("GetSceneItemId", { sceneName: scene, sourceName: p.name }));
      } catch (e) {
        if (!(e instanceof ObsRequestError && e.code === NOT_FOUND)) throw e;
        ({ sceneItemId } = await obs.request<{ sceneItemId: number }>("CreateSceneItem", { sceneName: scene, sourceName: p.name, sceneItemEnabled: true }));
      }
      result.updated.push(p.name);
    } else {
      ({ sceneItemId } = await obs.request<{ sceneItemId: number }>("CreateInput", {
        sceneName: scene,
        inputName: p.name,
        inputKind: "browser_source",
        inputSettings: { ...settings, shutdown: false, restart_when_active: false },
        sceneItemEnabled: true,
      }));
      result.created.push(p.name);
    }
    await obs.request("SetSceneItemTransform", {
      sceneName: scene,
      sceneItemId,
      sceneItemTransform: { positionX: p.box.x * sx, positionY: p.box.y * sy, scaleX: sx, scaleY: sy },
    });
  }

  const prev = readRecord(o.stateDir);
  const record: ObsRecord = { scene, inputs: [...new Set([...(prev?.inputs ?? []), ...plans.map((p) => p.name)])] };
  mkdirSync(o.stateDir, { recursive: true });
  writeFileSync(recordPath(o.stateDir), JSON.stringify(record, null, 2));
  return result;
}

export async function uninstallSources(obs: ObsClient, stateDir: string): Promise<string[]> {
  const record = readRecord(stateDir);
  if (!record) return [];
  const removed: string[] = [];
  for (const name of record.inputs) {
    try {
      await obs.request("RemoveInput", { inputName: name });
      removed.push(name);
    } catch (e) {
      if (!(e instanceof ObsRequestError && e.code === NOT_FOUND)) throw e;
    }
  }
  if (existsSync(recordPath(stateDir))) rmSync(recordPath(stateDir));
  return removed;
}
