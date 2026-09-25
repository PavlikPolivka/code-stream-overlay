import { describe, expect, it } from "vitest";
import { createPrivacy, globToRegExp, matcher, redactText, HIDDEN_FILE, SOME_FILE, MASK } from "../src/privacy.js";
import { defaultConfig } from "../src/config/schema.js";

describe("glob matcher", () => {
  const m = matcher(defaultConfig().privacy.ignore);
  it.each([
    [".env", true],
    [".env.local", true],
    ["config/.env.production", true],
    ["a/secrets/db.txt", true],
    ["secrets/x", true],
    ["certs/server.pem", true],
    ["deploy.key", true],
    ["home/id_rsa", true],
    ["src/environment.ts", false],
    ["src/keyboard.ts", false],
    ["README.md", false],
  ])("%s → %s", (p, hidden) => expect(m(p)).toBe(hidden));

  it("anchors patterns containing a slash", () => {
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("lib/src/a.ts")).toBe(false);
    expect(globToRegExp("src/*.ts").test("src/x/a.ts")).toBe(false);
    expect(globToRegExp("docs/**/*.md").test("docs/a/b/c.md")).toBe(true);
    expect(globToRegExp("docs/**/*.md").test("docs/c.md")).toBe(true);
  });

  it("matches directories and everything below", () => {
    expect(matcher(["private"])("private/deep/file.txt")).toBe(true);
    expect(matcher(["build/"])("build/out.js")).toBe(true);
  });
});

describe("redactText", () => {
  it.each([
    ["mysql -u root -p hunter2 db", `mysql -u root -p ${MASK} db`],
    ["mysql -phunter2", `mysql -p ${MASK}`],
    ["login --password s3cret --user bob", `login --password ${MASK} --user bob`],
    ["login --token=abc", `login --token=${MASK}`],
    ["API_KEY=abc123 npm run x", `API_KEY=${MASK} npm run x`],
    ["export GITHUB_TOKEN='x y'", `export GITHUB_TOKEN=${MASK}`],
    ['curl -H "Authorization: Bearer abc.def" https://x', `curl -H "Authorization: Bearer ${MASK}" https://x`],
    ["git clone https://bob:pw@github.com/x", `git clone https://bob:${MASK}@github.com/x`],
    ["echo ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", `echo ${MASK}`],
    ["echo a1b2c3d4e5f6a7b8c9d0e1f2a3b4", `echo ${MASK}`],
    ["npm test", "npm test"],
    ["vitest run src/components/OrderSummaryPanel.test.ts", "vitest run src/components/OrderSummaryPanel.test.ts"],
    ["grep createPrivacyRedactionRules", "grep createPrivacyRedactionRules"],
    ["git show 4b825dc642cb6eb9a060e54bf8d69288fbee4904", `git show ${MASK}`],
    ["ls -la src", "ls -la src"],
  ])("%s", (input, out) => expect(redactText(input)).toBe(out));
});

describe("createPrivacy", () => {
  const base = defaultConfig().privacy;
  it("hides ignored files", () => {
    const p = createPrivacy(base);
    expect(p.path(".env")).toBe(HIDDEN_FILE);
    expect(p.path("src/app.ts")).toBe("src/app.ts");
    expect(p.path("src/components/VeryLongComponentName2.tsx")).toBe("src/components/VeryLongComponentName2.tsx");
  });
  it("redactPaths shows basenames", () => {
    expect(createPrivacy({ ...base, redactPaths: true }).path("src/deep/app.ts")).toBe("app.ts");
  });
  it("hideFileNames hides everything", () => {
    const p = createPrivacy({ ...base, hideFileNames: true });
    expect(p.path("src/app.ts")).toBe(SOME_FILE);
    expect(p.path(".env")).toBe(HIDDEN_FILE);
  });
  it("truncates text", () => {
    expect(createPrivacy(base).text("abcdef", 4)).toBe("abc…");
  });
});
