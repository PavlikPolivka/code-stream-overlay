import { SoElement, h } from "../core.js";

class SoCustom extends SoElement {
  static slices = ["custom"];

  render(s) {
    const entries = Object.entries(s.custom);
    this.setEmpty(!entries.length);
    this.innerHTML = entries
      .map(([k, v]) => `<div class="so-row"><span class="so-label">${h(k)}</span><span class="so-value so-custom-value">${h(v)}</span></div>`)
      .join("");
  }
}

customElements.define("so-custom", SoCustom);
