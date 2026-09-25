import type { GoalItem } from "../state/types.js";

export interface ParsedGoals {
  title?: string;
  items: GoalItem[];
  done: number;
  total: number;
  /** Index into items of the first open, non-stretch top-level goal. */
  currentIndex?: number;
}

const TASK = /^([ \t]*)[-*+][ \t]+\[([ xX])\][ \t]+(.*)$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t#]*$/;
const FENCE = /^[ \t]*(```|~~~)/;

/** Indentation width with tabs as 4 columns. */
function indentWidth(s: string): number {
  let w = 0;
  for (const c of s) w += c === "\t" ? 4 : 1;
  return w;
}

/** Strip the inline Markdown that reads badly on screen. */
export function plainText(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links and images
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_]+)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

/**
 * Parse a Markdown task list. First `#` heading = title. Items under a heading whose
 * text starts with `stretchHeading` (any level, until the next heading of the same or
 * higher level) are stretch. done/total count top-level non-stretch items; a parent
 * counts as done only when its own box is checked.
 */
export function parseGoals(md: string, stretchHeading = "Stretch"): ParsedGoals {
  const items: GoalItem[] = [];
  let title: string | undefined;
  let stretchLevel: number | undefined;
  let inFence = false;
  const stack: { indent: number; item: GoalItem }[] = [];
  const stretchKey = stretchHeading.trim().toLowerCase();

  for (const raw of md.split(/\r?\n/)) {
    if (FENCE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const h = HEADING.exec(raw);
    if (h) {
      const level = h[1].length;
      const text = plainText(h[2]);
      if (level === 1 && title === undefined) title = text;
      if (stretchLevel !== undefined && level <= stretchLevel) stretchLevel = undefined;
      if (stretchKey && text.toLowerCase().startsWith(stretchKey)) stretchLevel = level;
      stack.length = 0;
      continue;
    }

    const m = TASK.exec(raw);
    if (!m) continue;
    const indent = indentWidth(m[1]);
    const text = plainText(m[3]);
    if (!text) continue;
    const item: GoalItem = { text, done: m[2] !== " ", stretch: stretchLevel !== undefined, children: [] };
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) {
      item.stretch ||= parent.item.stretch;
      parent.item.children.push(item);
    } else items.push(item);
    stack.push({ indent, item });
  }

  const counted = items.filter((i) => !i.stretch);
  const done = counted.filter((i) => i.done).length;
  const idx = items.findIndex((i) => !i.stretch && !i.done);
  return {
    ...(title !== undefined ? { title } : {}),
    items,
    done,
    total: counted.length,
    ...(idx >= 0 ? { currentIndex: idx } : {}),
  };
}

function flatten(items: GoalItem[], out = new Map<string, boolean>()): Map<string, boolean> {
  for (const i of items) {
    if (!out.has(i.text) || i.done) out.set(i.text, i.done);
    flatten(i.children, out);
  }
  return out;
}

/** Texts that were open in `prev` and are checked in `next`. */
export function newlyDone(prev: GoalItem[], next: GoalItem[]): string[] {
  const before = flatten(prev);
  const out: string[] = [];
  for (const [text, done] of flatten(next)) if (done && before.get(text) === false) out.push(text);
  return out;
}
