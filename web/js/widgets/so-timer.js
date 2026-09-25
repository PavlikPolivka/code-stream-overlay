import { SoElement, so, t, h } from "../core.js";

const MIN = 60_000;

class SoTimer extends SoElement {
  static slices = ["session"];

  render(s) {
    const x = s.session;
    this.dataset.status = x.overtime ? "overtime" : x.status;
    const phase = x.phases[x.phaseIndex];
    const label = x.overtime ? t("timer.overtime") : phase ? phase.name : t("timer.elapsed");
    this.innerHTML = `
      <div class="so-label so-phase">${h(label)}</div>
      <div class="so-value so-clock"></div>
      <div class="so-bar"><div class="so-bar-fill"></div></div>
      <div class="so-sub so-elapsed"></div>`;
    this.$clock = this.querySelector(".so-clock");
    this.$fill = this.querySelector(".so-bar-fill");
    this.$elapsed = this.querySelector(".so-elapsed");
    this.querySelector(".so-bar").hidden = !phase;
  }

  tick(now) {
    const x = so.state.session;
    const at = x.status === "running" ? now : (x.pausedAt ?? now);
    const elapsed = at - x.startedAt - x.pausedMs;
    const phase = x.phases[x.phaseIndex];
    if (!phase || x.phaseEndsAt == null) {
      this.$clock.textContent = so.fmt.clock(elapsed);
      this.$elapsed.textContent = "";
      return;
    }
    if (x.overtime) {
      this.$clock.textContent = "+" + so.fmt.clock(at - x.phaseEndsAt);
      this.$fill.style.width = "100%";
    } else {
      const remaining = Math.max(0, x.phaseEndsAt - at);
      this.$clock.textContent = so.fmt.clock(remaining);
      this.$fill.style.width = `${Math.min(100, (1 - remaining / (phase.minutes * MIN)) * 100)}%`;
    }
    this.$elapsed.textContent = t("timer.total", { time: so.fmt.clock(elapsed) });
  }

  fx(name, p) {
    if (name !== "phase") return;
    const big = document.createElement("div");
    big.className = "so-phase-announce";
    big.textContent = p.name;
    this.append(big);
    setTimeout(() => big.remove(), 3000);
  }
}

customElements.define("so-timer", SoTimer);
