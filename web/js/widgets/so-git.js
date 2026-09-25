import { SoElement, so, t, h } from "../core.js";

class SoGit extends SoElement {
  static slices = ["git"];

  render(s) {
    const g = s.git;
    this.dataset.status = g.error ? "error" : "ok";
    this.innerHTML = `
      <div class="so-row"><span class="so-label">${h(t("git.branch"))}</span><span class="so-branch">${h(g.branch || "—")}</span></div>
      <div class="so-row so-value">
        <span class="so-add">+${g.added}</span><span class="so-del">−${g.removed}</span>
      </div>
      <div class="so-sub so-files">${h(t("git.files", { n: g.filesChanged }))} · <span class="so-last"></span></div>
      ${g.error ? `<div class="so-error">${h(g.error)}</div>` : ""}`;
    this.$last = this.querySelector(".so-last");
  }

  tick(now) {
    const c = so.state.git.commits[0];
    this.$last.textContent = c ? t("git.lastCommit", { ago: so.fmt.ago(c.at, now) }) : t("git.noCommits");
  }
}

customElements.define("so-git", SoGit);
