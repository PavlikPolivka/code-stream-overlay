export type Placement = { slot: string } | { x: number; y: number; w: number; h: number };

export type TriggerMode = "save" | "commit" | "interval" | "manual" | "passive";

export interface GoalItem {
  text: string;
  done: boolean;
  stretch: boolean;
  children: GoalItem[];
}

export interface AgentTodo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface Phase {
  name: string;
  minutes: number;
}

export interface Commit {
  sha: string;
  subject: string;
  at: number;
}

export interface TestFailure {
  name: string;
  message?: string;
  file?: string;
}

export interface State {
  meta: {
    version: string;
    /** Built-in theme name, or "/user/theme.css" when the config points at a file. */
    theme: string;
    tone: "plain" | "playful";
    labels: Record<string, string>;
    confetti: boolean;
    font?: string;
    /** "/user/extra.css" when display.css is set. */
    css?: string;
    widgets: string[];
    layout: Record<string, Placement>;
  };
  project: { name: string; title?: string; subtitle?: string; stacks: string[] };
  session: {
    id: string;
    startedAt: number;
    startSha: string;
    status: "running" | "paused" | "stopped";
    phases: Phase[];
    phaseIndex: number;
    phaseEndsAt?: number;
    pausedAt?: number;
    /** ms accumulated while paused; lets the browser compute active elapsed time. */
    pausedMs: number;
    overtime: boolean;
  };
  git: {
    branch: string;
    headSha: string;
    added: number;
    removed: number;
    filesChanged: number;
    untracked: number;
    commits: Commit[];
    error?: string;
  };
  activity: { currentFile?: string; lastEditAt?: number; recent: string[] };
  tests: {
    status: "idle" | "running" | "pass" | "fail" | "error";
    adapter?: string;
    mode: TriggerMode;
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    durationMs?: number;
    lastRunAt?: number;
    runs: number;
    firstFailure?: TestFailure;
    error?: string;
  };
  goals: {
    source: "file" | "claude-todos" | "both" | "off";
    title?: string;
    items: GoalItem[];
    done: number;
    total: number;
    currentIndex?: number;
    todos?: AgentTodo[];
  };
  agent: {
    status: "offline" | "idle" | "working" | "waiting" | "done";
    action?: string;
    tool?: string;
    at?: number;
    counts: { edits: number; commands: number; reads: number };
  };
  custom: Record<string, string | number>;
}

export type SliceKey = keyof State;

export type FxName = "tests-green" | "tests-red" | "goal-done" | "commit" | "phase" | "agent-waiting";

export interface Fx {
  name: FxName;
  payload?: Record<string, unknown>;
}
