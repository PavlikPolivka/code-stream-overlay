/**
 * Segment-wise glob matching for report watching. `**` matches any number of
 * segments but never descends into a directory named in `noDescend` (e.g. target,
 * node_modules); a literal segment may still name one. That lets a watcher enter
 * `target/surefire-reports` without walking the rest of `target/`.
 */
export interface CompiledGlob {
  /** Does the repo-relative file path match? */
  matches(rel: string): boolean;
  /** Could some file below this repo-relative directory match? */
  mayContain(relDir: string): boolean;
}

const segRe = (seg: string) =>
  new RegExp(
    "^" +
      seg
        .split("")
        .map((c) => (c === "*" ? "[^/]*" : c === "?" ? "[^/]" : c.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
        .join("") +
      "$",
  );

export function compileGlob(glob: string, noDescend: Iterable<string> = []): CompiledGlob {
  const skip = new Set(noDescend);
  const segs = glob.replace(/\\/g, "/").replace(/^\.\//, "").split("/").filter(Boolean);
  const res = segs.map((s) => (s === "**" ? null : segRe(s)));

  const run = (parts: string[], prefix: boolean): boolean => {
    const memo = new Map<number, boolean>();
    const go = (gi: number, pi: number): boolean => {
      const k = gi * 10_000 + pi;
      const hit = memo.get(k);
      if (hit !== undefined) return hit;
      let r: boolean;
      if (pi === parts.length) r = prefix || res.slice(gi).every((x) => x === null);
      else if (gi === segs.length) r = false;
      else if (res[gi] === null) r = go(gi + 1, pi) || (!skip.has(parts[pi]) && go(gi, pi + 1));
      else r = res[gi]!.test(parts[pi]) && go(gi + 1, pi + 1);
      memo.set(k, r);
      return r;
    };
    return go(0, 0);
  };

  const split = (p: string) => p.replace(/\\/g, "/").split("/").filter(Boolean);
  return {
    matches: (rel) => run(split(rel), false),
    mayContain: (relDir) => run(split(relDir), true),
  };
}
