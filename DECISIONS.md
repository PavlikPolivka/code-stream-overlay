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
- The file watcher always skips `.git/` and `node_modules/`, plus the directories git reported as ignored at start (`ls-files -o -i --directory`). Paths ignored later are filtered through a cached `git check-ignore --stdin`.
- Untracked files count toward `git.filesChanged` as well as `git.untracked` and `git.added`.
- The diff uses `--no-renames`, so a rename counts as a delete plus an add.
- Commit subjects pass through the same redaction as commands and are truncated to 120 characters.
- Privacy globs use a small built-in gitignore-style matcher (no new dependency). A pattern without `/` matches at any depth.
- Paths are not text-redacted (only hidden or shortened). The token rule requires 24+ chars mixing letters and digits, plus known prefixes (ghp_, sk-, xox*-, AKIA), so long identifiers survive.
- Hidden files (privacy.ignore) show as "a hidden file" in `activity.currentFile` and are never added to `activity.recent`.
- The `now` title falls back in the browser: config title → goals H1 → branch → repo name.
