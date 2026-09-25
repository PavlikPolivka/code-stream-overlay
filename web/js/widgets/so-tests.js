import { SoElement, so, t, h } from "../core.js";

const BADGE = { idle: "tests.idle", running: "tests.running", pass: "tests.passBadge", fail: "tests.failBadge", error: "tests.errorBadge" };

class SoTests extends SoElement {
  static slices = ["tests"];

  render(s) {
    const x = s.tests;
    this.dataset.status = x.status;
    const counts = x.total
      ? t("tests.counts", { passed: x.passed, total: x.total })
      : x.status === "pass" || x.status === "fail"
        ? t("tests.noCounts")
        : "";
    const summary =
      x.status === "pass" ? t("tests.pass") : x.status === "fail" ? t("tests.fail", { failed: x.failed || 1 }) : x.status === "running" ? t("tests.runningText") : x.status === "error" ? t("tests.error") : t("tests.waiting");
    const f = x.firstFailure;
    this.innerHTML = `
      <div class="so-row">
        <span class="so-badge so-status">${x.status === "running" ? '<span class="so-spinner"></span>' : ""}${h(t(BADGE[x.status]))}</span>
        <span class="so-summary">${h(summary)}</span>
      </div>
      <div class="so-row so-counts">
        <span class="so-value">${h(counts)}</span>
        ${x.skipped ? `<span class="so-sub">${h(t("tests.skipped", { n: x.skipped }))}</span>` : ""}
        ${x.durationMs != null && x.status !== "running" ? `<span class="so-sub so-duration">${h(so.fmt.duration(x.durationMs))}</span>` : ""}
      </div>
      ${f && x.status === "fail" ? `<div class="so-failure"><div class="so-fail-name">${h(f.name)}</div>${f.message ? `<div class="so-message">${h(f.message)}</div>` : ""}</div>` : ""}
      ${x.error ? `<div class="so-error so-message">${h(x.error)}</div>` : ""}`;
  }

  fx(name) {
    if (name === "tests-green") this.flash("so-fx-green", this, 1600);
    if (name === "tests-red") this.flash("so-fx-shake", this, 700);
  }
}

customElements.define("so-tests", SoTests);
