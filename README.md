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

## Tests

Tests are detected from your repo. The first match wins unless `tests.adapter` pins one (`"off"` disables tests).

| Stack  | Detected by                                        | Command                                      | Default mode |
|--------|----------------------------------------------------|----------------------------------------------|--------------|
| maven  | `pom.xml`                                          | `./mvnw -q test` or `mvn -q test`            | passive      |
| gradle | `build.gradle(.kts)`, `settings.gradle(.kts)`      | `./gradlew test` or `gradle test`            | passive      |
| node   | `package.json` with a `test` script                | `npm test` (pnpm / yarn / bun by lockfile)   | save         |
| python | `pyproject.toml`, `pytest.ini`, `setup.cfg`, `tox.ini` | `pytest -q --junitxml=.git/stream-overlay/pytest.xml` | save |
| go     | `go.mod`                                           | `go test -json ./...`                        | save         |
| rust   | `Cargo.toml`                                       | `cargo nextest run` if installed, else `cargo test` | save  |
| dotnet | `*.sln`, `*.csproj`, `*.fsproj`                    | `dotnet test --logger trx …`                 | commit       |
| make   | `Makefile` with a `test:` target                   | `make test`                                  | manual       |

Trigger modes (`tests.mode` or `--tests-mode`):

- **passive**: never runs anything. It watches report files and shows the results of whatever ran the tests: you, your IDE, or your agent. Recommended whenever an agent runs tests itself, because two concurrent builds fight over `target/` or `build/`.
- **save**: runs after you save a file (debounced; one follow-up run is queued at most).
- **commit**: runs after each commit.
- **interval**: runs every `tests.intervalSec` seconds (min 30).
- **manual**: runs on `stream-overlay test` or `POST /api/tests/run`.

Override anything with `tests.command`, `tests.reports` (JUnit or TRX globs) and `tests.timeoutSec`. For example, jest with jest-junit:

```json
{ "tests": { "command": "npx jest --ci --reporters=default --reporters=jest-junit", "reports": ["junit.xml"] } }
```

## Goals

Put a task list in `GOALS.md` (or set `goals.file`; `.git/stream-overlay/goals.md` keeps it private):

```md
# CSV export for orders

- [x] Scope the feature
- [ ] Export endpoint
  - [x] Header row
  - [ ] Quote fields with commas
- [ ] Tests for edge cases

## Stretch

- [ ] Streaming for large exports
```

The first `#` heading becomes the title. Top-level items count toward progress, and a parent counts only when its own box is checked. Items under a `Stretch` heading are dimmed and don't affect the percentage. Checking an item on stream strikes it through and slides it out.

`goals.source` can also be `"claude-todos"` (the coding agent's todo list), `"both"`, or `"off"`.

## License

MIT
