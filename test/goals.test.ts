import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { newlyDone, parseGoals, plainText } from "../src/goals/parse.js";
import { GoalsCollector } from "../src/collectors/goals.js";
import { Store } from "../src/state/store.js";
import { Bus } from "../src/state/bus.js";
import { initialState } from "../src/app.js";
import { defaultConfig } from "../src/config/schema.js";
import { TimerCollector } from "../src/collectors/timer.js";
import type { Fx } from "../src/state/types.js";
import { rm, tmpDir, waitFor } from "./helpers.js";

const md = readFileSync(path.join(import.meta.dirname, "fixtures", "goals", "GOALS.md"), "utf8");

describe("parseGoals", () => {
  const g = parseGoals(md);

  it("takes the first H1 as title", () => {
    expect(g.title).toBe("CSV export for orders");
  });

  it("parses markers, nesting and inline markdown", () => {
    expect(g.items.map((i) => i.text)).toEqual([
      "Scope the feature",
      "Export endpoint GET /orders.csv",
      "Wire the download button",
      "Tests for edge cases",
      "README section",
      "Streaming for large exports",
      "Progress indicator",
      "Localized headers",
    ]);
    const exp = g.items[1];
    expect(exp.children.map((c) => [c.text, c.done])).toEqual([
      ["Header row", true],
      ["Quote fields with commas", false],
    ]);
    expect(exp.children[1].children[0].text).toBe("Escape embedded quotes");
    expect(g.items[2].done).toBe(true); // [X]
  });

  it("ignores plain bullets and code fences", () => {
    expect(JSON.stringify(g)).not.toContain("Excel");
    expect(JSON.stringify(g)).not.toContain("code fence");
  });

  it("marks stretch items (tab-nested children too) until the next same-level heading", () => {
    expect(g.items.filter((i) => i.stretch).map((i) => i.text)).toEqual(["Streaming for large exports", "Progress indicator"]);
    expect(g.items[5].children[0]).toMatchObject({ text: "Backpressure", stretch: true });
    expect(g.items[7].stretch).toBe(false);
  });

  it("counts top-level non-stretch items; the current goal is the first open one", () => {
    // Scope ✓, Export ✗ (children don't matter), Wire ✓, Tests ✗, README ✗, Localized ✗
    expect(g).toMatchObject({ done: 2, total: 6, currentIndex: 1 });
  });

  it("supports 4-space indentation and a custom stretch heading", () => {
    const r = parseGoals("- [ ] a\n    - [x] b\n# Nice to have\n- [ ] c\n", "Nice");
    expect(r.items[0].children[0].text).toBe("b");
    expect(r.items[1].stretch).toBe(true);
    expect(r).toMatchObject({ done: 0, total: 1 });
  });

  it("handles empty input", () => {
    expect(parseGoals("")).toEqual({ items: [], done: 0, total: 0 });
  });

  it("strips inline markdown", () => {
    expect(plainText("**bold** and _em_ and ~~old~~ [link](x) `code`")).toBe("bold and em and old link code");
    expect(plainText("snake_case_name stays")).toBe("snake_case_name stays");
  });

  it("finds newly checked items, nested too", () => {
    const a = parseGoals("- [ ] a\n  - [ ] b\n- [x] c\n").items;
    const b = parseGoals("- [x] a\n  - [x] b\n- [x] c\n- [x] d\n").items;
    expect(newlyDone(a, b)).toEqual(["a", "b"]);
  });
});

describe("GoalsCollector", () => {
  const dirs: string[] = [];
  const cols: GoalsCollector[] = [];
  afterEach(async () => {
    for (const c of cols.splice(0)) await c.stop();
    for (const d of dirs.splice(0)) rm(d);
  });

  function setup(source: "file" | "claude-todos" | "both" = "file") {
    const root = tmpDir();
    dirs.push(root);
    const cfg = defaultConfig();
    const store = new Store(initialState(cfg, "r", TimerCollector.initial("s", "x", [], true)));
    const bus = new Bus();
    const col = new GoalsCollector(store, bus, { root, goals: { ...cfg.goals, source } });
    cols.push(col);
    const fx: Fx[] = [];
    store.subscribe((e) => e.type === "fx" && fx.push(e.fx));
    return { root, store, bus, col, fx };
  }

  it("missing file means empty goals; creating it later is picked up", async () => {
    const { root, store, col } = setup();
    await col.start();
    expect(store.get("goals")).toMatchObject({ items: [], done: 0, total: 0 });
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(path.join(root, "GOALS.md"), "# T\n- [ ] one\n");
    await waitFor(() => store.get("goals").total === 1);
    expect(store.get("goals").title).toBe("T");
  });

  it("checking an item emits goal-done; stretch items don't change the percentage", async () => {
    const { root, store, col, fx } = setup();
    const file = path.join(root, "GOALS.md");
    writeFileSync(file, "- [ ] one\n- [ ] two\n## Stretch\n- [ ] bonus\n");
    await col.start();
    expect(store.get("goals")).toMatchObject({ done: 0, total: 2 });
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(file, "- [x] one\n- [ ] two\n## Stretch\n- [ ] bonus\n");
    await waitFor(() => store.get("goals").done === 1);
    expect(fx).toEqual([{ name: "goal-done", payload: { text: "one" } }]);
    writeFileSync(file, "- [x] one\n- [ ] two\n## Stretch\n- [x] bonus\n");
    await waitFor(() => fx.length === 2);
    expect(store.get("goals")).toMatchObject({ done: 1, total: 2 });
    rmSync(file);
    await waitFor(() => store.get("goals").total === 0);
  });

  it("claude-todos source counts todos", async () => {
    const { store, bus, col, fx } = setup("claude-todos");
    await col.start();
    bus.emit("agent:todos", { todos: [{ content: "a", status: "in_progress" }, { content: "b", status: "pending" }] });
    expect(store.get("goals")).toMatchObject({ done: 0, total: 2 });
    bus.emit("agent:todos", { todos: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }] });
    expect(store.get("goals")).toMatchObject({ done: 1, total: 2 });
    expect(fx).toEqual([{ name: "goal-done", payload: { text: "a" } }]);
  });
});
