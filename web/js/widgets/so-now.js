import { SoElement, h } from "../core.js";

class SoNow extends SoElement {
  static slices = ["project", "goals", "git"];

  render(s) {
    const p = s.project;
    const title = p.title || s.goals.title || s.git.branch || p.name;
    const stack = p.stacks[0];
    this.innerHTML = `
      <div class="so-row">
        <span class="so-title">${h(title)}</span>
        ${stack ? `<span class="so-badge so-stack">${h(stack)}</span>` : ""}
      </div>
      ${p.subtitle ? `<div class="so-subtitle">${h(p.subtitle)}</div>` : `<div class="so-subtitle">${h(p.name)}</div>`}`;
  }
}

customElements.define("so-now", SoNow);
