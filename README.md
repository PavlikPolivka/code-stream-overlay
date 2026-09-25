# stream-overlay

Live, repo-aware overlays for OBS and other streaming software. Run it inside any git repository and add the printed URLs as browser sources. Viewers see what you're building, how far along it is, whether tests pass, and what your coding agent is doing.

- One command, zero config: `npx stream-overlay`
- Adds no files to your tracked tree; everything lives in `.git/stream-overlay/`
- Every widget works as its own OBS browser source, plus one composed layout

> Requires Node.js 22+ and git on your PATH.

## Quick start

```sh
cd your-repo
npx stream-overlay
```

```
stream-overlay · my-repo · maven (passive)
  Layout   http://127.0.0.1:4747/
  Widgets  http://127.0.0.1:4747/w/<now|timer|git|tests|goals|commits|file|agent|custom>
  Control  http://127.0.0.1:4747/control
```

## Session timer

The `timer` widget counts down the current phase. Presets (`session.preset`):

| Preset     | Phases                                   |
|------------|------------------------------------------|
| `90min`    | Scope 10 · Build 60 · README 15 · Ship 5 |
| `pomodoro` | 4 × (Focus 25 · Break 5)                 |
| `freeform` | no phases, stopwatch                     |

Past the last phase the timer counts up in overtime. Custom phases:
`{ "session": { "phases": [{ "name": "Build", "minutes": 45 }] } }`.

## Repo awareness

- **now**: title (config `title`, else the GOALS.md heading, else the branch, else the repo name), subtitle and detected stack.
- **git**: branch, lines added and removed, and files changed since the session started. Commits, staged, unstaged and untracked changes all count, so committing never resets the numbers.
- **file**: the file you're editing and how long ago.

### Privacy

Everything shown on stream passes through one filter. Files that match `privacy.ignore` (default `.env*`, `**/secrets/**`, `*.pem`, `*.key`, `id_*`) show as "a hidden file", and their contents are never read. `privacy.redactPaths: true` shows basenames only, and `privacy.hideFileNames: true` hides every name. Commands and messages are scrubbed of passwords, tokens, `SECRET=`-style assignments, `Authorization:` headers and long key-like strings.

## License

MIT
