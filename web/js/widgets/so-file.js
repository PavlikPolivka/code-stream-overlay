import { SoElement, so, t, h } from "../core.js";

class SoFile extends SoElement {
  static slices = ["activity"];

  render(s) {
    const a = s.activity;
    this.setEmpty(!a.currentFile);
    this.innerHTML = `
      <div class="so-label">${h(t("file.editing"))}</div>
      <div class="so-title so-path">${h(a.currentFile ?? "")}</div>
      <div class="so-sub so-ago"></div>`;
    this.$ago = this.querySelector(".so-ago");
  }

  tick(now) {
    const at = so.state.activity.lastEditAt;
    this.$ago.textContent = at ? so.fmt.ago(at, now) : "";
  }
}

customElements.define("so-file", SoFile);
