import { XMLParser } from "fast-xml-parser";
import { ParseError, firstLine, type ParseResult } from "./types.js";

type Node = Record<string, unknown>;

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => name === "UnitTestResult",
});

const num = (v: unknown) => (typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : v && typeof v === "object" && typeof (v as Node)["#text"] === "string" ? ((v as Node)["#text"] as string) : undefined;

/** Parse a Visual Studio TRX file (`dotnet test --logger trx`). */
export function parseTrx(input: string): ParseResult {
  let doc: Node;
  try {
    doc = xml.parse(input.replace(/^\uFEFF/, ""), true) as Node;
  } catch (e) {
    throw new ParseError("trx", (e as Error).message);
  }
  const run = doc.TestRun as Node | undefined;
  const counters = (run?.ResultSummary as Node | undefined)?.Counters as Node | undefined;
  if (!run || !counters) throw new ParseError("trx", "missing TestRun/ResultSummary/Counters");

  const failed = num(counters["@failed"]) + num(counters["@error"]) + num(counters["@timeout"]) + num(counters["@aborted"]);
  const r: ParseResult = {
    total: num(counters["@total"]),
    passed: num(counters["@passed"]),
    failed,
    skipped: 0,
  };
  // Some adapters (xUnit) leave notExecuted at 0 and only lower `executed`.
  const executed = counters["@executed"] === undefined ? r.total : num(counters["@executed"]);
  r.skipped = Math.max(num(counters["@notExecuted"]), r.total - executed);

  const times = run.Times as Node | undefined;
  const start = Date.parse(String(times?.["@start"] ?? ""));
  const finish = Date.parse(String(times?.["@finish"] ?? ""));
  if (Number.isFinite(start) && Number.isFinite(finish) && finish >= start) r.durationMs = finish - start;

  const results = ((run.Results as Node | undefined)?.UnitTestResult as Node[] | undefined) ?? [];
  const bad = results.find((u) => u["@outcome"] === "Failed");
  if (bad) {
    const err = ((bad.Output as Node | undefined)?.ErrorInfo as Node | undefined) ?? {};
    r.firstFailure = { name: String(bad["@testName"] ?? "?") };
    const msg = firstLine(str(err.Message));
    if (msg) r.firstFailure.message = msg;
  }
  return r;
}
