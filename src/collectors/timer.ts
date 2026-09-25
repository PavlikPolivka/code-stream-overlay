import type { Config } from "../config/schema.js";
import type { Store } from "../state/store.js";
import type { Phase, State } from "../state/types.js";
import type { Collector } from "./types.js";

export const PRESETS: Record<Config["session"]["preset"], Phase[]> = {
  "90min": [
    { name: "Scope", minutes: 10 },
    { name: "Build", minutes: 60 },
    { name: "README", minutes: 15 },
    { name: "Ship", minutes: 5 },
  ],
  pomodoro: Array.from({ length: 4 }, () => [
    { name: "Focus", minutes: 25 },
    { name: "Break", minutes: 5 },
  ]).flat(),
  freeform: [],
};

export function phasesFor(session: Config["session"]): Phase[] {
  return session.phases ?? PRESETS[session.preset];
}

const MIN = 60_000;

/** Owns the `session` slice. Stores absolute times; the browser renders countdowns. */
export class TimerCollector implements Collector {
  private timer?: NodeJS.Timeout;

  constructor(
    private store: Store,
    private opts: { phases: Phase[]; autoStart: boolean },
  ) {}

  /** Initial slice value; the store is created with it. */
  static initial(id: string, startSha: string, phases: Phase[], autoStart: boolean, now = Date.now()): State["session"] {
    return {
      id,
      startedAt: now,
      startSha,
      status: autoStart ? "running" : "paused",
      phases,
      phaseIndex: 0,
      phaseEndsAt: phases.length ? now + phases[0].minutes * MIN : undefined,
      pausedAt: autoStart ? undefined : now,
      pausedMs: 0,
      overtime: false,
    };
  }

  start(): void {
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  get session(): State["session"] {
    return this.store.get("session");
  }

  action(name: string): void {
    const now = Date.now();
    const s = this.session;
    switch (name) {
      case "start":
        this.set(TimerCollector.initial(s.id, s.startSha, this.opts.phases, true, now));
        break;
      case "pause":
        if (s.status !== "running") return;
        this.set({ ...s, status: "paused", pausedAt: now });
        break;
      case "resume": {
        if (s.status !== "paused") return;
        const d = now - (s.pausedAt ?? now);
        this.set({
          ...s,
          status: "running",
          pausedAt: undefined,
          pausedMs: s.pausedMs + d,
          phaseEndsAt: s.phaseEndsAt !== undefined ? s.phaseEndsAt + d : undefined,
        });
        break;
      }
      case "next":
        if (s.status === "stopped" || !s.phases.length) return;
        this.advance(now, true);
        return;
      case "stop":
        if (s.status === "stopped") return;
        this.set({ ...s, status: "stopped", pausedAt: now });
        break;
    }
    this.schedule();
  }

  private set(s: State["session"]) {
    this.store.set("session", s);
  }

  private schedule() {
    this.stop();
    const s = this.session;
    if (s.status !== "running" || s.overtime || s.phaseEndsAt === undefined) return;
    // setTimeout max is ~24.8 days; phases are far shorter.
    this.timer = setTimeout(() => this.advance(Date.now(), false), Math.max(0, s.phaseEndsAt - Date.now()));
    this.timer.unref?.();
  }

  /** Move to the next phase. `manual` starts it now instead of at the old boundary. */
  private advance(now: number, manual: boolean) {
    const s = this.session;
    if (s.overtime) return;
    const boundary = manual ? now : (s.phaseEndsAt ?? now);
    const next = s.phaseIndex + 1;
    if (next >= s.phases.length) {
      this.set({ ...s, overtime: true, phaseEndsAt: boundary });
    } else {
      const p = s.phases[next];
      this.set({ ...s, phaseIndex: next, phaseEndsAt: boundary + p.minutes * MIN });
      this.store.fx("phase", { name: p.name });
    }
    this.schedule();
  }
}
