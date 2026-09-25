import { ParseError, type ParseResult } from "./types.js";

interface GoEvent {
  Action?: string;
  Package?: string;
  Test?: string;
  Elapsed?: number;
  Output?: string;
}

const FILE_LINE = /^\s*([\w./-]+\.go):(\d+)(?::\d+)?:\s*(.*)$/;
const MAX_LINES = 200;

/**
 * Parse `go test -json` output (one JSON object per line; other lines ignored).
 * Only leaf tests count: a parent whose subtests ran is represented by them.
 */
export function parseGoJson(input: string): ParseResult {
  const results = new Map<string, { pkg: string; test: string; action: string }>();
  const output = new Map<string, string[]>();
  const buildOutput: string[] = [];
  let events = 0;
  let pkgSeconds = 0;
  let pkgTimed = false;
  let failedPkg: string | undefined;

  const push = (list: string[], line: string) => list.length < MAX_LINES && list.push(line);

  for (const line of input.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let e: GoEvent;
    try {
      e = JSON.parse(s);
    } catch {
      continue;
    }
    if (typeof e.Action !== "string") continue;
    events++;
    const pkg = e.Package ?? "";
    const key = `${pkg}\0${e.Test ?? ""}`;
    switch (e.Action) {
      case "output":
        if (e.Output) {
          const list = output.get(key) ?? [];
          push(list, e.Output);
          output.set(key, list);
        }
        break;
      case "build-output":
        if (e.Output) push(buildOutput, e.Output);
        break;
      case "pass":
      case "fail":
      case "skip":
        if (e.Test) results.set(key, { pkg, test: e.Test, action: e.Action });
        else {
          if (typeof e.Elapsed === "number") {
            pkgSeconds += e.Elapsed;
            pkgTimed = true;
          }
          if (e.Action === "fail") failedPkg ??= pkg;
        }
        break;
    }
  }
  if (!events) throw new ParseError("go-json", "no test events in output");

  const all = [...results.values()];
  const leaves = all.filter((r) => !all.some((o) => o.pkg === r.pkg && o.test.startsWith(`${r.test}/`)));
  const r: ParseResult = { total: leaves.length, passed: 0, failed: 0, skipped: 0 };
  for (const l of leaves) {
    if (l.action === "pass") r.passed++;
    else if (l.action === "skip") r.skipped++;
    else r.failed++;
  }
  if (pkgTimed) r.durationMs = Math.round(pkgSeconds * 1000);
  if (failedPkg !== undefined) r.runFailed = true;

  const firstFailed = leaves.find((l) => l.action === "fail");
  if (firstFailed) {
    r.firstFailure = { name: firstFailed.test, ...describe(output.get(`${firstFailed.pkg}\0${firstFailed.test}`) ?? []) };
  } else if (failedPkg !== undefined) {
    const lines = [...buildOutput, ...(output.get(`${failedPkg}\0`) ?? [])];
    r.firstFailure = { name: failedPkg || "build", ...describe(lines) };
  }
  return r;
}

function describe(lines: string[]): { message?: string; file?: string } {
  const located = lines.map((l) => FILE_LINE.exec(l.trimEnd())).find(Boolean);
  if (located) return { message: located[3].trim() || undefined, file: located[1] };
  const msg = lines.map((l) => l.trim()).find((l) => l && !/^(=== |--- |FAIL|ok\s|PASS|#)/.test(l));
  return msg ? { message: msg } : {};
}
