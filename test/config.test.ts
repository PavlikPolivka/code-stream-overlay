import { describe, expect, it, vi } from "vitest";
import { mergeDeep, mergeLayers, ConfigError } from "../src/config/load.js";
import { defaultConfig } from "../src/config/schema.js";

describe("mergeDeep", () => {
  it("merges objects deeply and replaces arrays", () => {
    const a = { x: { y: 1, z: [1, 2] }, k: "a" };
    const b = { x: { z: [3] }, k: undefined };
    expect(mergeDeep(a, b)).toEqual({ x: { y: 1, z: [3] }, k: "a" });
  });
});

describe("mergeLayers", () => {
  it("applies defaults", () => {
    const c = mergeLayers([]);
    expect(c).toEqual(defaultConfig());
    expect(c.port).toBe(4747);
    expect(c.display.widgets).toContain("timer");
    expect(c.privacy.ignore).toContain(".env*");
  });

  it("later layers win, arrays replace", () => {
    const c = mergeLayers([
      { source: "global", data: { display: { theme: "minimal", widgets: ["timer", "git"] } } },
      { source: "repo", data: { display: { widgets: ["tests"] }, port: 5000 } },
    ]);
    expect(c.display.theme).toBe("minimal");
    expect(c.display.widgets).toEqual(["tests"]);
    expect(c.port).toBe(5000);
  });

  it("reports file and path for invalid values", () => {
    try {
      mergeLayers([{ source: "/x/stream-overlay.json", data: { tests: { timeoutSec: "soon" } } }]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain("/x/stream-overlay.json");
      expect((e as Error).message).toContain("tests.timeoutSec");
    }
  });

  it("rejects unknown keys", () => {
    expect(() => mergeLayers([{ source: "f", data: { display: { colour: "red" } } }])).toThrow(ConfigError);
  });

  it("drops custom commands from shared config unless trusted", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const layer = { source: "shared", shared: true, data: { custom: [{ key: "k", command: "echo hi" }] } };
    expect(mergeLayers([layer]).custom).toEqual([]);
    expect(mergeLayers([layer], { trustRepoConfig: true }).custom).toHaveLength(1);
    warn.mockRestore();
  });
});
