import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store, type StoreEvent } from "../src/state/store.js";
import { initialState } from "../src/app.js";
import { defaultConfig } from "../src/config/schema.js";
import { TimerCollector, PRESETS } from "../src/collectors/timer.js";
import { throttle } from "../src/util/debounce.js";

const mkStore = (phases = PRESETS["90min"], autoStart = true) =>
  new Store(initialState(defaultConfig(), "repo", TimerCollector.initial("s1", "abc", phases, autoStart)));

describe("Store", () => {
  it("suppresses no-op sets and broadcasts changes", () => {
    const store = mkStore();
    const events: StoreEvent[] = [];
    store.subscribe((e) => events.push(e));
    expect(store.set("custom", {})).toBe(false);
    expect(store.set("custom", { a: 1 })).toBe(true);
    expect(store.set("custom", { a: 1 })).toBe(false);
    store.fx("commit", { subject: "x" });
    expect(events).toEqual([
      { type: "slice", key: "custom", value: { a: 1 } },
      { type: "fx", fx: { name: "commit", payload: { subject: "x" } } },
    ]);
  });
});

describe("TimerCollector", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  it("advances phases at boundaries and emits fx", () => {
    const store = mkStore();
    const fx: string[] = [];
    store.subscribe((e) => e.type === "fx" && fx.push(String(e.fx.payload?.name)));
    const t = new TimerCollector(store, { phases: PRESETS["90min"], autoStart: true });
    t.start();
    expect(store.get("session").phaseEndsAt).toBe(1_000_000 + 10 * 60_000);
    vi.advanceTimersByTime(10 * 60_000);
    expect(store.get("session").phaseIndex).toBe(1);
    expect(fx).toEqual(["Build"]);
    vi.advanceTimersByTime(80 * 60_000);
    expect(store.get("session").overtime).toBe(true);
    expect(fx).toEqual(["Build", "README", "Ship"]);
    t.stop();
  });

  it("pause and resume shift the phase end", () => {
    const store = mkStore();
    const t = new TimerCollector(store, { phases: PRESETS["90min"], autoStart: true });
    t.start();
    const end = store.get("session").phaseEndsAt!;
    vi.advanceTimersByTime(60_000);
    t.action("pause");
    expect(store.get("session").status).toBe("paused");
    vi.advanceTimersByTime(20 * 60_000); // would have crossed the boundary
    expect(store.get("session").phaseIndex).toBe(0);
    t.action("resume");
    const s = store.get("session");
    expect(s.phaseEndsAt).toBe(end + 20 * 60_000);
    expect(s.pausedMs).toBe(20 * 60_000);
    t.stop();
  });

  it("next skips to the next phase now", () => {
    const store = mkStore();
    const t = new TimerCollector(store, { phases: PRESETS["90min"], autoStart: true });
    t.start();
    vi.advanceTimersByTime(60_000);
    t.action("next");
    expect(store.get("session").phaseIndex).toBe(1);
    expect(store.get("session").phaseEndsAt).toBe(Date.now() + 60 * 60_000);
    t.stop();
  });

  it("freeform has no phases and no timers", () => {
    const store = mkStore([], true);
    const t = new TimerCollector(store, { phases: [], autoStart: true });
    t.start();
    expect(store.get("session").phaseEndsAt).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("autoStart false begins paused", () => {
    const store = mkStore(PRESETS.pomodoro, false);
    expect(store.get("session").status).toBe("paused");
    expect(store.get("session").phases).toHaveLength(8);
  });
});

describe("throttle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs at most once per window with a trailing call", async () => {
    const fn = vi.fn();
    const th = throttle(fn, 1000);
    th();
    th();
    th();
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
    th();
    await vi.advanceTimersByTimeAsync(500);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
