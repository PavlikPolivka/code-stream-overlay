import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { State } from "./state/types.js";

export interface SessionSummary {
  id: string;
  repo: string;
  branch: string;
  startedAt: string;
  endedAt: string;
  /** Active time (pauses excluded), ms. */
  durationMs: number;
  phases: { completed: string[]; current?: string; overtime: boolean };
  lines: { added: number; removed: number };
  filesChanged: number;
  commits: { sha: string; subject: string }[];
  tests: { runs: number; status: State["tests"]["status"]; passed: number; total: number; failed: number };
  goals: { done: number; total: number; completed: string[]; open: string[] };
  agent: State["agent"]["counts"];
}

export function buildSummary(s: State, end = Date.now()): SessionSummary {
  const x = s.session;
  const until = x.status === "running" ? end : (x.pausedAt ?? end);
  const phaseNames = x.phases.map((p) => p.name);
  const completed = x.overtime ? phaseNames : phaseNames.slice(0, x.phaseIndex);
  const top = s.goals.items.filter((i) => !i.stretch);
  return {
    id: x.id,
    repo: s.project.name,
    branch: s.git.branch,
    startedAt: new Date(x.startedAt).toISOString(),
    endedAt: new Date(end).toISOString(),
    durationMs: Math.max(0, until - x.startedAt - x.pausedMs),
    phases: { completed, ...(x.overtime || !phaseNames.length ? {} : { current: phaseNames[x.phaseIndex] }), overtime: x.overtime },
    lines: { added: s.git.added, removed: s.git.removed },
    filesChanged: s.git.filesChanged,
    commits: [...s.git.commits].reverse().map((c) => ({ sha: c.sha.slice(0, 7), subject: c.subject })),
    tests: { runs: s.tests.runs, status: s.tests.status, passed: s.tests.passed, total: s.tests.total, failed: s.tests.failed },
    goals: {
      done: s.goals.done,
      total: s.goals.total,
      completed: top.filter((i) => i.done).map((i) => i.text),
      open: top.filter((i) => !i.done).map((i) => i.text),
    },
    agent: s.agent.counts,
  };
}

const dur = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};

export function toMarkdown(x: SessionSummary): string {
  const lines = [
    `## Session summary · ${x.repo} (${x.branch || "no branch"})`,
    "",
    `- **Time:** ${dur(x.durationMs)} (${x.startedAt.slice(0, 16).replace("T", " ")} → ${x.endedAt.slice(11, 16)} UTC)`,
  ];
  if (x.phases.completed.length || x.phases.current) {
    lines.push(`- **Phases:** ${x.phases.completed.join(" → ") || "none completed"}${x.phases.overtime ? " (+ overtime)" : x.phases.current ? ` · now: ${x.phases.current}` : ""}`);
  }
  lines.push(`- **Code:** +${x.lines.added} −${x.lines.removed} in ${x.filesChanged} files`);
  lines.push(`- **Commits:** ${x.commits.length}`);
  for (const c of x.commits) lines.push(`  - \`${c.sha}\` ${c.subject}`);
  const t = x.tests;
  lines.push(`- **Tests:** ${t.runs} runs, last ${t.status}${t.total ? ` (${t.passed}/${t.total})` : ""}`);
  if (x.goals.total) {
    lines.push(`- **Goals:** ${x.goals.done}/${x.goals.total}`);
    for (const g of x.goals.completed) lines.push(`  - [x] ${g}`);
    for (const g of x.goals.open) lines.push(`  - [ ] ${g}`);
  }
  const a = x.agent;
  if (a.edits + a.commands + a.reads) lines.push(`- **Agent:** ${a.edits} edits, ${a.commands} commands, ${a.reads} reads`);
  return lines.join("\n");
}

export const sessionsDir = (stateDir: string) => path.join(stateDir, "sessions");

export function saveSummary(stateDir: string, x: SessionSummary): string {
  const dir = sessionsDir(stateDir);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${x.id}.json`);
  writeFileSync(file, JSON.stringify(x, null, 2));
  return file;
}

export function latestSummary(stateDir: string): SessionSummary | undefined {
  try {
    const dir = sessionsDir(stateDir);
    const newest = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ f, t: statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    return newest ? JSON.parse(readFileSync(path.join(dir, newest.f), "utf8")) : undefined;
  } catch {
    return undefined;
  }
}
