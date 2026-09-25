import { SoElement, so, t, h } from "../core.js";

class SoAgent extends SoElement {
  static slices = ["agent"];

  render(s) {
    const a = s.agent;
    this.dataset.status = a.status;
    this.setEmpty(a.status === "offline");
    const text =
      a.status === "waiting" ? t("agent.waiting") : a.status === "done" ? t("agent.done") : a.status === "idle" ? t("agent.idle") : a.action ?? t("agent.working");
    const c = a.counts;
    this.innerHTML = `
      <div class="so-row">
        <span class="so-dot"></span>
        <span class="so-label so-agent-name">${h(t("agent.name"))}</span>
        <span class="so-action">${h(text)}</span>
        <span class="so-sub so-counts">${h(t("agent.counts", { edits: c.edits, commands: c.commands, reads: c.reads }))}</span>
      </div>`;
  }

  fx(name) {
    if (name === "agent-waiting") this.flash("so-fx-attention", this, 1200);
  }
}

customElements.define("so-agent", SoAgent);
