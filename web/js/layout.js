// Composed layout: a 1920×1080 stage with named slots, scaled to the viewport.
import { so } from "./core.js";

/** Default size (px on the 1920×1080 canvas) and slot for each widget. */
export const WIDGETS = {
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

const M = 32; // stage margin
const BAR = 48; // bottom bar height
/** Slot anchors; bottom slots grow upward, middle slots start below the top row. */
const SLOTS = {
  "top-left": { left: M, top: M },
  "top-right": { right: M, top: M },
  "left-middle": { left: M, top: 180 },
  "right-middle": { right: M, top: 200 },
  "bottom-left": { left: M, bottom: BAR + M },
  "bottom-center": { left: 960, bottom: BAR + M, center: true },
  "bottom-right": { right: M, bottom: BAR + M },
  "bottom-bar": { left: 0, bottom: 0 },
};

const stage = document.getElementById("so-stage");
let built = "";

function build() {
  const meta = so.state.meta;
  const key = JSON.stringify([meta.widgets, meta.layout]);
  if (key === built) return;
  built = key;
  stage.replaceChildren();
  const slots = new Map();
  for (const name of meta.widgets) {
    const def = WIDGETS[name];
    if (!def) continue;
    const place = meta.layout[name] ?? { slot: def.slot };
    const el = document.createElement(`so-${name}`);
    import(`./widgets/so-${name}.js`).catch((e) => console.error(`widget ${name}`, e));
    if ("x" in place) {
      Object.assign(el.style, { position: "absolute", left: `${place.x}px`, top: `${place.y}px`, width: `${place.w}px`, height: `${place.h}px` });
      stage.append(el);
      continue;
    }
    const slotName = SLOTS[place.slot] ? place.slot : def.slot;
    let box = slots.get(slotName);
    if (!box) {
      box = document.createElement("div");
      box.className = `so-slot so-slot-${slotName}`;
      const a = SLOTS[slotName];
      for (const side of ["left", "right", "top", "bottom"]) if (a[side] !== undefined) box.style[side] = `${a[side]}px`;
      if (a.center) box.style.transform = "translateX(-50%)";
      slots.set(slotName, box);
      stage.append(box);
    }
    el.style.width = `${def.w}px`;
    if (name === "commits") el.style.height = `${def.h}px`;
    box.append(el);
  }
}

function fit() {
  const s = Math.min(innerWidth / 1920, innerHeight / 1080);
  stage.style.transform = `scale(${s})`;
}

addEventListener("resize", fit);
fit();
addEventListener("so:state", (e) => e.detail.key === "meta" && build());
if (so.state) build();
