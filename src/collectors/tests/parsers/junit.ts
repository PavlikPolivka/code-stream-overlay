import { XMLParser } from "fast-xml-parser";
import type { TestFailure } from "../../../state/types.js";
import { ParseError, firstLine, type ParseResult } from "./types.js";

type Node = Record<string, unknown>;

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  htmlEntities: true,
  trimValues: false,
  isArray: (name) => ["testsuite", "testcase", "failure", "error", "skipped"].includes(name),
});

const arr = (v: unknown): Node[] => (Array.isArray(v) ? (v as Node[]) : v && typeof v === "object" ? [v as Node] : []);
const seconds = (v: unknown): number | undefined => {
  if (typeof v !== "string" || v.trim() === "") return undefined;
  const n = Number(v.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
};
const text = (n: unknown): string | undefined => {
  if (typeof n === "string") return n;
  if (n && typeof n === "object") {
    const t = (n as Node)["#text"];
    return typeof t === "string" ? t : undefined;
  }
  return undefined;
};

const looksLikeFile = (s: string) => /[/\\]/.test(s) || /\.(m?[jt]sx?|py|rb|go|rs|cs)$/.test(s);

/** Readable test name from classname + name across JUnit dialects. */
export function testName(classname: string | undefined, name: string): string {
  if (!classname || classname === name || /^[ .:>]/.test(name.slice(classname.length)) && name.startsWith(classname)) return name;
  if (looksLikeFile(classname)) return name;
  return `${classname}.${name}`;
}

/** Parse JUnit XML (`<testsuites>` or bare `<testsuite>` root, nesting allowed). */
export function parseJunit(input: string): ParseResult {
  let doc: Node;
  try {
    doc = xml.parse(input.replace(/^\uFEFF/, ""), true) as Node;
  } catch (e) {
    throw new ParseError("junit", (e as Error).message);
  }
  const root = (doc.testsuites as Node | undefined) ?? undefined;
  const topSuites = root ? arr(root.testsuite) : arr(doc.testsuite);
  if (!root && !topSuites.length) throw new ParseError("junit", "no <testsuites> or <testsuite> root");

  const r: ParseResult = { total: 0, passed: 0, failed: 0, skipped: 0 };
  let caseTime = 0;
  let first: TestFailure | undefined;

  const walk = (suite: Node) => {
    for (const tc of arr(suite.testcase)) {
      r.total++;
      caseTime += seconds(tc["@time"]) ?? 0;
      const bad = [...arr(tc.failure), ...arr(tc.error)];
      if (bad.length) {
        r.failed++;
        if (!first) {
          const f = bad[0];
          const classname = tc["@classname"] as string | undefined;
          first = {
            name: testName(classname, String(tc["@name"] ?? "?")),
            message: firstLine((f["@message"] as string | undefined) ?? text(f)),
          };
          const file = (tc["@file"] as string | undefined) ?? (classname && looksLikeFile(classname) ? classname : undefined);
          if (file) first.file = file;
          if (!first.message) delete first.message;
        }
      } else if (tc.skipped !== undefined) r.skipped++;
      else r.passed++;
    }
    for (const child of arr(suite.testsuite)) walk(child);
  };
  for (const s of topSuites) walk(s);

  const rootTime = root ? seconds(root["@time"]) : undefined;
  const suiteTime = topSuites.reduce<number | undefined>((acc, s) => {
    const t = seconds(s["@time"]);
    return t === undefined ? acc : (acc ?? 0) + t;
  }, undefined);
  const secs = rootTime ?? suiteTime ?? (r.total ? caseTime : undefined);
  if (secs !== undefined) r.durationMs = Math.round(secs * 1000);
  if (first) r.firstFailure = first;
  return r;
}
