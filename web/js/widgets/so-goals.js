import { SoElement, so, t, h } from "../core.js";

const LEAVE_MS = 2600; // 2 s struck through, then slide out
const MAX_ITEMS = 7;

class SoGoals extends SoElement {
  static slices = ["goals"];
  leaving = new Map(); // text → until

  render(s) {
    const g = s.goals;
    const now = Date.now();
    for (const [k, until] of this.leaving) if (until < now) this.leaving.delete(k);
    const fromTodos = g.source === "claude-todos";
    const items = fromTodos ? (g.todos ?? []).map(todoItem) : g.items;
    this.setEmpty(!items.length && !(g.todos ?? []).length);
    const pct = g.total ? Math.round((g.done / g.total) * 100) : 0;
    const current = fromTodos ? items.findIndex((i) => i.active) : g.currentIndex;
    const visible = items
      .map((item, i) => ({ item, i }))
      .filter(({ item }) => !item.done || this.leaving.has(item.text))
      .slice(0, MAX_ITEMS);
    const allDone = g.total > 0 && g.done === g.total;

    this.innerHTML = `
      <div class="so-row so-head">
        <span class="so-title">${h(g.title ?? t("goals.title"))}</span>
        <span class="so-sub so-progress-text">${h(t("goals.done", { done: g.done, total: g.total }))}</span>
      </div>
      <div class="so-bar"><div class="so-bar-fill" style="width:${this.lastPct ?? pct}%"></div></div>
      <ul class="so-list">
        ${visible.map(({ item, i }) => row(item, i === current, this.leaving.has(item.text))).join("")}
        ${allDone && !visible.length ? `<li class="so-goal so-all-done">${h(t("goals.allDone"))}</li>` : ""}
      </ul>
      ${g.source === "both" && g.todos?.length ? `<div class="so-label">${h(t("goals.agentTodos"))}</div><ul class="so-list so-todos">${g.todos.map((td) => row(todoItem(td), td.status === "in_progress", false)).join("")}</ul>` : ""}`;
    // Tween the bar from its previous width.
    const fill = this.querySelector(".so-bar-fill");
    requestAnimationFrame(() => (fill.style.width = `${pct}%`));
    this.lastPct = pct;
  }

  fx(name, p) {
    if (name !== "goal-done") return;
    this.leaving.set(p.text, Date.now() + LEAVE_MS);
    this.update();
    setTimeout(() => this.update(), LEAVE_MS + 50);
  }
}

function todoItem(td) {
  return { text: td.content, done: td.status === "completed", stretch: false, children: [], active: td.status === "in_progress" };
}

function row(item, current, leaving) {
  const cls = ["so-goal", item.done && "so-done", item.stretch && "so-stretch", current && "so-current", leaving && "so-leaving"]
    .filter(Boolean)
    .join(" ");
  const kids = item.children?.length
    ? `<ul class="so-children">${item.children.map((c) => `<li class="so-goal ${c.done ? "so-done" : ""}"><span class="so-check"></span>${h(c.text)}</li>`).join("")}</ul>`
    : "";
  return `<li class="${cls}"><span class="so-check"></span><span class="so-text">${h(item.text)}</span>${item.stretch ? `<span class="so-tag">${h(t("goals.stretch"))}</span>` : ""}${kids}</li>`;
}

customElements.define("so-goals", SoGoals);
