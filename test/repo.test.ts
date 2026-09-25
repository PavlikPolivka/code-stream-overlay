import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { createApp, type App } from "../src/app.js";
import { mergeLayers } from "../src/config/load.js";
import { resolveRepo } from "../src/util/paths.js";
import { EMPTY_TREE } from "../src/constants.js";
import { parseNumstat } from "../src/collectors/git.js";
import type { Fx } from "../src/state/types.js";
import { rm, sh, tmpRepo, waitFor, write } from "./helpers.js";

const apps: App[] = [];
const dirs: string[] = [];

async function boot(dir: string, extra: Record<string, unknown> = {}) {
  const repo = await resolveRepo(dir);
  const app = await createApp(repo, mergeLayers([{ source: "test", data: { port: 0, ...extra } }]));
  apps.push(app);
  const fx: Fx[] = [];
  app.store.subscribe((e) => e.type === "fx" && fx.push(e.fx));
  // let the watcher settle before touching files
  await new Promise((r) => setTimeout(r, 300));
  return { app, fx };
}

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const d of dirs.splice(0)) rm(d);
});

const repo = (o?: { commit?: boolean }) => {
  const d = tmpRepo(o);
  dirs.push(d);
  return d;
};

describe("parseNumstat", () => {
  it("counts binary files as changed with 0 lines", () => {
    expect(parseNumstat("3\t1\ta.txt\0-\t-\timg.png\0")).toEqual({ added: 3, removed: 1, files: 2 });
  });
});

describe("repo awareness", () => {
  it("starts without touching the working tree and writes server.json under .git", async () => {
    const dir = repo();
    const { app } = await boot(dir);
    expect(sh(dir, "status", "--porcelain")).toBe("");
    expect(existsSync(path.join(dir, ".git", "stream-overlay", "server.json"))).toBe(true);
    await waitFor(() => app.store.get("git").branch === "main");
    await app.stop();
    expect(existsSync(path.join(dir, ".git", "stream-overlay", "server.json"))).toBe(false);
  });

  it("an edit updates activity and git within 1.5 s", async () => {
    const dir = repo();
    const { app } = await boot(dir);
    const t0 = Date.now();
    write(dir, "README.md", "hello\nworld\n");
    await waitFor(() => app.store.get("git").added === 1 && app.store.get("activity").currentFile === "README.md", 1500);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(app.store.get("git")).toMatchObject({ added: 1, removed: 0, filesChanged: 1, untracked: 0 });
    expect(app.store.get("activity").recent).toEqual(["README.md"]);
  });

  it("commits show up; totals stay relative to session start", async () => {
    const dir = repo();
    const { app, fx } = await boot(dir);
    write(dir, "src/a.ts", "one\ntwo\nthree\n");
    await waitFor(() => app.store.get("git").untracked === 1);
    expect(app.store.get("git").added).toBe(3);
    sh(dir, "add", ".");
    sh(dir, "commit", "-q", "-m", "Add a.ts");
    await waitFor(() => app.store.get("git").commits.length === 1);
    const g = app.store.get("git");
    expect(g.commits[0].subject).toBe("Add a.ts");
    expect(g).toMatchObject({ added: 3, filesChanged: 1, untracked: 0 });
    await waitFor(() => fx.some((f) => f.name === "commit"));
    expect(fx.find((f) => f.name === "commit")?.payload?.subject).toBe("Add a.ts");
  });

  it("never names a .env file on screen and never counts its lines", async () => {
    const dir = repo();
    const { app } = await boot(dir);
    write(dir, ".env", "SECRET=1\nX=2\n");
    await waitFor(() => app.store.get("activity").currentFile !== undefined);
    await waitFor(() => app.store.get("git").untracked === 1);
    expect(app.store.get("activity").currentFile).toBe("a hidden file");
    expect(app.store.get("git").added).toBe(0);
    expect(JSON.stringify(app.store.get())).not.toContain(".env");
  });

  it("ignores gitignored paths", async () => {
    const dir = repo();
    write(dir, ".gitignore", "dist/\n*.log\n");
    sh(dir, "add", ".");
    sh(dir, "commit", "-q", "-m", "ignore");
    write(dir, "dist/keep.txt", "x");
    const { app } = await boot(dir);
    write(dir, "dist/out.js", "x");
    write(dir, "debug.log", "x");
    write(dir, "src/real.ts", "x\n");
    await waitFor(() => app.store.get("activity").currentFile === "src/real.ts");
    await new Promise((r) => setTimeout(r, 400));
    expect(app.store.get("activity").recent).toEqual(["src/real.ts"]);
  });

  it("handles a repo without commits", async () => {
    const dir = repo({ commit: false });
    const { app } = await boot(dir);
    expect(app.store.get("session").startSha).toBe(EMPTY_TREE);
    await waitFor(() => app.store.get("git").branch === "main");
    write(dir, "a.txt", "1\n2\n");
    sh(dir, "add", ".");
    sh(dir, "commit", "-q", "-m", "first");
    await waitFor(() => app.store.get("git").commits.length === 1);
    expect(app.store.get("git")).toMatchObject({ added: 2, filesChanged: 1 });
  });
});
