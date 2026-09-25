import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseJunit, testName } from "../src/collectors/tests/parsers/junit.js";
import { parseTrx } from "../src/collectors/tests/parsers/trx.js";
import { parseGoJson } from "../src/collectors/tests/parsers/gojson.js";
import { combine, ParseError } from "../src/collectors/tests/parsers/types.js";
import { compileGlob } from "../src/util/glob.js";

const FX = path.join(import.meta.dirname, "fixtures");
const read = (...p: string[]) => readFileSync(path.join(FX, ...p), "utf8");
const dir = (...p: string[]) =>
  readdirSync(path.join(FX, ...p))
    .sort()
    .map((f) => parseJunit(read(...p, f)));

describe("junit", () => {
  it("maven surefire, failing run", () => {
    const r = combine(dir("junit", "maven-fail"));
    expect(r).toMatchObject({ total: 5, passed: 3, failed: 1, skipped: 1 });
    expect(r.firstFailure).toEqual({
      name: "demo.CsvExportTest.quoting",
      message: 'expected: <a,b> but was: <a,"b">',
    });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("maven surefire, passing run", () => {
    const r = combine(dir("junit", "maven-pass"));
    expect(r).toMatchObject({ total: 5, passed: 4, failed: 0, skipped: 1 });
    expect(r.firstFailure).toBeUndefined();
  });

  it("gradle multi-module", () => {
    const files = [
      read("junit", "gradle", "core", "build", "test-results", "test", "TEST-shop.core.PriceTest.xml"),
      read("junit", "gradle", "api", "build", "test-results", "test", "TEST-shop.api.RouteTest.xml"),
    ];
    const r = combine(files.map(parseJunit));
    expect(r).toMatchObject({ total: 4, passed: 2, failed: 1, skipped: 1 });
    expect(r.firstFailure?.name).toBe("shop.core.PriceTest.addsTax()");
    expect(r.firstFailure?.message).toContain("tax should be 21%");
  });

  it("pytest with a skip", () => {
    const r = parseJunit(read("junit", "pytest.xml"));
    expect(r).toMatchObject({ total: 4, passed: 2, failed: 1, skipped: 1, durationMs: 17 });
    expect(r.firstFailure).toEqual({
      name: "test_parse.test_parses_floats",
      message: "AssertionError: rounding broke",
    });
  });

  it("vitest junit reporter", () => {
    const r = parseJunit(read("junit", "vitest.xml"));
    expect(r).toMatchObject({ total: 4, passed: 2, failed: 1, skipped: 1 });
    expect(r.firstFailure).toEqual({
      name: "cart > applies coupon",
      message: "expected { total: 90 } to deeply equal { total: 100 }",
      file: "src/cart.test.js",
    });
  });

  it("jest-junit (no message attribute)", () => {
    const r = parseJunit(read("junit", "jest.xml"));
    expect(r).toMatchObject({ total: 3, passed: 1, failed: 1, skipped: 1 });
    expect(r.firstFailure).toEqual({
      name: "cart applies coupon",
      message: "Error: expect(received).toEqual(expected) // deep equality",
    });
  });

  it("cargo-nextest", () => {
    const r = parseJunit(read("junit", "nextest.xml"));
    expect(r).toMatchObject({ total: 2, passed: 1, failed: 1, skipped: 0, durationMs: 22 });
    expect(r.firstFailure?.name).toBe("rustdemo.tests::zero_qty");
    expect(r.firstFailure?.message).toContain("panicked at src/lib.rs:9:21");
  });

  it("rejects non-junit input", () => {
    expect(() => parseJunit("<html></html>")).toThrow(ParseError);
    expect(() => parseJunit("not xml <<<")).toThrow(ParseError);
  });

  it("testName avoids duplicating the class", () => {
    expect(testName("a.B", "c")).toBe("a.B.c");
    expect(testName("x y", "x y")).toBe("x y");
    expect(testName("src/a.test.ts", "works")).toBe("works");
  });
});

describe("trx", () => {
  it("dotnet test (xUnit)", () => {
    const r = parseTrx(read("trx", "dotnet.trx"));
    expect(r).toMatchObject({ total: 5, passed: 3, failed: 1, skipped: 1 });
    expect(r.firstFailure?.name).toBe("Shop.Tests.CartTests.AppliesCoupon");
    expect(r.firstFailure?.message).toContain("Assert.Equal() Failure");
    expect(r.durationMs).toBeGreaterThan(0);
  });

  it("rejects files without counters", () => {
    expect(() => parseTrx("<TestRun/>")).toThrow(ParseError);
  });
});

describe("go-json", () => {
  it("pass: counts leaf tests only", () => {
    const r = parseGoJson(read("go", "pass.json"));
    expect(r).toMatchObject({ total: 4, passed: 3, failed: 0, skipped: 1 });
    expect(r.runFailed).toBeUndefined();
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("fail: first failing subtest with location", () => {
    const r = parseGoJson(read("go", "fail.json"));
    expect(r).toMatchObject({ total: 4, passed: 2, failed: 1, skipped: 1, runFailed: true });
    expect(r.firstFailure).toEqual({
      name: "TestTotalTable/one",
      message: "Total(1,5) = 5, want 6",
      file: "order_test.go",
    });
  });

  it("build failure marks the run failed", () => {
    const r = parseGoJson(read("go", "build-fail.json"));
    expect(r).toMatchObject({ total: 0, failed: 0, runFailed: true });
    expect(r.firstFailure?.message).toBe("syntax error: unexpected {, expected )");
    expect(r.firstFailure?.file).toBe("orders/order.go");
  });

  it("ignores junk lines and rejects empty output", () => {
    expect(() => parseGoJson("hello\nworld")).toThrow(ParseError);
  });
});

describe("compileGlob", () => {
  const maven = compileGlob("**/target/surefire-reports/TEST-*.xml", ["target", "node_modules"]);
  it("matches files", () => {
    expect(maven.matches("target/surefire-reports/TEST-a.B.xml")).toBe(true);
    expect(maven.matches("mod/target/surefire-reports/TEST-a.xml")).toBe(true);
    expect(maven.matches("target/surefire-reports/a.txt")).toBe(false);
  });
  it("only descends where a match is possible", () => {
    expect(maven.mayContain("mod")).toBe(true);
    expect(maven.mayContain("target")).toBe(true);
    expect(maven.mayContain("target/surefire-reports")).toBe(true);
    expect(maven.mayContain("target/classes")).toBe(false);
    expect(maven.mayContain("node_modules")).toBe(false);
  });
  it("handles a trailing **", () => {
    const g = compileGlob("**/build/test-results/**/*.xml", ["build"]);
    expect(g.matches("core/build/test-results/test/TEST-x.xml")).toBe(true);
    expect(g.mayContain("core/build/classes")).toBe(false);
    expect(g.mayContain("core/build/test-results/test")).toBe(true);
  });
});
