import type { TestFailure } from "../../../state/types.js";

export interface ParseResult {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs?: number;
  firstFailure?: TestFailure;
  /** Run-level failure without failing test cases (e.g. a Go build error). */
  runFailed?: boolean;
}

export class ParseError extends Error {
  constructor(
    public format: string,
    message: string,
  ) {
    super(`${format}: ${message}`);
    this.name = "ParseError";
  }
}

export function firstLine(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const line = s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  return line || undefined;
}

/** Combine per-file results (Maven/Gradle write one file per class). */
export function combine(results: ParseResult[]): ParseResult {
  const out: ParseResult = { total: 0, passed: 0, failed: 0, skipped: 0 };
  let dur = 0;
  let hasDur = false;
  for (const r of results) {
    out.total += r.total;
    out.passed += r.passed;
    out.failed += r.failed;
    out.skipped += r.skipped;
    if (r.durationMs !== undefined) {
      dur += r.durationMs;
      hasDur = true;
    }
    if (!out.firstFailure && r.firstFailure) out.firstFailure = r.firstFailure;
    if (r.runFailed) out.runFailed = true;
  }
  if (hasDur) out.durationMs = Math.round(dur);
  return out;
}
