import type { Config } from "./config/schema.js";

export const HIDDEN_FILE = "a hidden file";
export const SOME_FILE = "a file";
export const MASK = "•••";

/**
 * Convert a gitignore-style glob to a RegExp over repo-relative, forward-slash paths.
 * `*` and `?` stay inside a segment, `**` crosses segments. A pattern without `/`
 * matches the basename at any depth, and a match on a directory covers everything below it.
 */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/\\/g, "/");
  const anchored = g.startsWith("/") || g.replace(/\/$/, "").includes("/");
  g = g.replace(/^\//, "").replace(/\/$/, "");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slashAfter = g[i + 2] === "/";
        re += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${anchored ? "^" : "(?:^|/)"}${re}(?:/.*)?$`);
}

export function matcher(globs: string[]): (rel: string) => boolean {
  const res = globs.filter((g) => g.trim()).map(globToRegExp);
  return (rel) => {
    const p = rel.replace(/\\/g, "/").replace(/^\.\//, "");
    return res.some((r) => r.test(p));
  };
}

const SECRET_NAME = "[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?|AUTH)[A-Za-z0-9_]*";

const RULES: [RegExp, string][] = [
  // --password value, --password=value, --token value, -p value / -pvalue (mysql style)
  [/(--(?:password|passwd|token|secret|api-key|apikey|access-token|auth)[= ])\s*("[^"]*"|'[^']*'|\S+)/gi, `$1${MASK}`],
  [/(\s-p)(?:\s+("[^"]*"|'[^']*'|\S+)|(\S+))/g, `$1 ${MASK}`],
  // FOO_TOKEN=value env assignments or exports
  [new RegExp(`\\b(${SECRET_NAME})=("[^"]*"|'[^']*'|\\S+)`, "gi"), `$1=${MASK}`],
  // Authorization headers, up to the closing quote or end of line
  [/(authorization:\s*)(?:(bearer|basic|token)\s+)?[^"'\n]+/gi, (_m: string, a: string, s?: string) => `${a}${s ? `${s} ` : ""}${MASK}`] as never,
  // URLs with credentials: https://user:pass@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/gi, `$1${MASK}@`],
  // Well-known token prefixes (GitHub, OpenAI/Anthropic-style, Slack, AWS)
  [/\b(?:gh[pousr]_|github_pat_|sk-|xox[abprs]-|AKIA)[A-Za-z0-9_-]{8,}/g, MASK],
  // Long base64/hex runs (tokens, keys, hashes): 24+ chars with both letters and digits.
  [/(?<![A-Za-z0-9+_-])(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{24,}={0,2}/g, MASK],
];

/** Remove secrets from free text (commands, test messages, commit subjects). */
export function redactText(s: string): string {
  let out = s;
  for (const [re, rep] of RULES) out = out.replace(re, rep as string);
  return out;
}

export interface Privacy {
  /** True for files whose names and contents must never reach the screen. */
  isHidden(rel: string): boolean;
  /** Screen-safe form of a repo-relative path. */
  path(rel: string): string;
  text(s: string, max?: number): string;
}

/** Replace the repo root with "." and the home directory with "~" (they name the user). */
export function shortenPaths(s: string, root?: string, home?: string): string {
  let out = s;
  for (const [prefix, rep] of [
    [root, "."],
    [home, "~"],
  ] as const) {
    if (!prefix || prefix.length < 2) continue;
    for (const form of new Set([prefix, prefix.replace(/\\/g, "/")])) out = out.split(form).join(rep);
  }
  // Paths from the macOS temp dir etc. can still embed the user name (e.g. "-Users-<name>-").
  const user = home ? home.split(/[\\/]/).filter(Boolean).at(-1) : undefined;
  if (user && user.length > 2) out = out.split(user).join("~");
  return out;
}

export function createPrivacy(p: Config["privacy"], where: { root?: string; home?: string } = {}): Privacy {
  const hidden = matcher(p.ignore);
  return {
    isHidden: hidden,
    path(rel) {
      const clean = rel.replace(/\\/g, "/").replace(/^\.\//, "");
      if (hidden(clean)) return HIDDEN_FILE;
      if (p.hideFileNames) return SOME_FILE;
      return p.redactPaths ? clean.slice(clean.lastIndexOf("/") + 1) : clean;
    },
    text(s, max) {
      const r = redactText(shortenPaths(s, where.root, where.home));
      return max !== undefined && r.length > max ? `${r.slice(0, max - 1)}…` : r;
    },
  };
}
