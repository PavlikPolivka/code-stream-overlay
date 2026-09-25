import { SoElement, t, h } from "../core.js";

const MAX = 12;

class SoCommits extends SoElement {
  static slices = ["git"];
  fresh = "";

  render(s) {
    const commits = s.git.commits.slice(0, MAX);
    this.setEmpty(!commits.length);
    this.innerHTML = `
      <span class="so-label">${h(t("commits.label", { n: s.git.commits.length }))}</span>
      <div class="so-ticker">${commits
        .map((c) => `<span class="so-commit ${c.sha === this.fresh ? "so-fresh" : ""}"><span class="so-sha">${h(c.sha.slice(0, 7))}</span> ${h(c.subject)}</span>`)
        .join("")}</div>`;
  }

  fx(name, p) {
    if (name !== "commit") return;
    this.fresh = p.sha ?? "";
    this.update();
  }
}

customElements.define("so-commits", SoCommits);
