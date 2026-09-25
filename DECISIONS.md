# Decisions

One line per decision where the design doc was ambiguous or deviated from.

- Node 22 is required; the repo pins it in `.nvmrc`.
- `session.pausedMs` was added to the session slice so the browser can compute active elapsed time without server ticks.
- `meta.confetti` was added to the meta slice so widgets know whether `display.confetti` is on.
- `session.autoStart: false` starts the session paused at phase 1; `resume` (or `start`) begins it.
- `POST /api/session/start` restarts the timer from phase 1 (it keeps the session id and startSha).
- `stop` ends the session (the timer freezes and the summary is written), but the server keeps running so overlays show the final state. Ctrl+C stops the server.
- Timer `next` starts the next phase at the current time instead of at the old boundary.
- The config schema is strict: unknown keys are errors, which catches typos.
- Config validation runs per layer (to name the bad file) and again on the merged result.
- The browser clock ticks at 4 Hz from one rAF loop, with a 1 s interval fallback because OBS throttles rAF in hidden sources.
- `/api/health` also returns `pid`, so the CLI can tell a stale `server.json` from a live server.
- `start` opens the layout in the default browser only when stdout is a TTY and not in CI; `--no-open` disables it.
- The Host check also accepts `[::1]:<port>`.
