// Smoke test: pack the package, run it with npx in a sample Maven repo, drop
// pre-generated surefire reports, and check the overlay picks them up.
// Usage: node scripts/smoke.mjs
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const win = process.platform === "win32";
const npm = win ? "npm.cmd" : "npm";
const npx = win ? "npx.cmd" : "npx";
const fail = (msg) => {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
};

const work = mkdtempSync(path.join(os.tmpdir(), "so-smoke-"));
const tgzName = execFileSync(npm, ["pack", "--silent", "--pack-destination", work], { cwd: root, encoding: "utf8", shell: win }).trim().split(/\r?\n/).pop();
const tgz = path.join(work, tgzName);

const repo = path.join(work, "orders");
mkdirSync(repo);
cpSync(path.join(root, "test", "fixtures", "maven-sample"), repo, { recursive: true });
writeFileSync(path.join(repo, ".gitignore"), "target/\n");
const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
git("init", "-q");
git("-c", "user.email=ci@example.com", "-c", "user.name=CI", "add", ".");
git("-c", "user.email=ci@example.com", "-c", "user.name=CI", "commit", "-q", "-m", "init");
mkdirSync(path.join(repo, ".git", "stream-overlay"), { recursive: true });
writeFileSync(path.join(repo, ".git", "stream-overlay", "config.json"), JSON.stringify({ port: 0 }));

// Install once so the timed start measures startup, not the download.
execFileSync(npm, ["install", "--no-save", "--prefix", path.join(work, "prefix"), tgz], { stdio: "ignore", shell: win });
const bin = path.join(work, "prefix", "node_modules", "stream-overlay", "dist", "cli.js");

const t0 = Date.now();
const child = spawn(process.execPath, [bin, "--no-open"], { cwd: repo, env: { ...process.env, CI: "1" } });
let out = "";
child.stdout.on("data", (b) => (out += b));
child.stderr.on("data", (b) => (out += b));
const until = async (cond, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill();
  fail(`${what}\n${out}`);
};

try {
  await until(() => out.includes("Control"), 10_000, "no banner");
  const startMs = Date.now() - t0;
  const port = Number(/127\.0\.0\.1:(\d+)/.exec(out)[1]);
  console.log(`banner after ${startMs} ms on port ${port}`);
  if (!out.includes("maven (passive)")) fail(`maven not detected:\n${out}`);

  const reports = path.join(repo, "target", "surefire-reports");
  mkdirSync(reports, { recursive: true });
  const fx = path.join(root, "test", "fixtures", "junit", "maven-pass");
  for (const f of readdirSync(fx)) cpSync(path.join(fx, f), path.join(reports, f));
  await until(
    async () => {
      const s = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
      return s.tests.status === "pass" && s.tests.total === 5;
    },
    10_000,
    "tests slice never showed 5 passing",
  );
  const status = git("status", "--porcelain");
  if (status) fail(`working tree not clean:\n${status}`);
  const npxOut = execFileSync(npx, ["--yes", "--package", tgz, "stream-overlay", "--version"], { cwd: repo, encoding: "utf8", shell: win });
  if (!npxOut.includes(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version)) fail(`npx --version printed: ${npxOut}`);
  console.log("SMOKE OK");
} finally {
  child.kill();
  setTimeout(() => rmSync(work, { recursive: true, force: true }), 500);
}
