// stream-overlay browser runtime: SSE client, state, URL params, i18n, shared clock.
// Exposes window.so for widgets (including user-written custom widgets).

const params = new URLSearchParams(location.search);
const token = params.get("token");
const withToken = (url) => (token ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : url);

const urlLabels = {};
for (const [k, v] of params) if (k.startsWith("label.")) urlLabels[k.slice(6)] = v;

const so = {
  state: null,
  params,
  connected: false,
  tables: { plain: {}, tone: {} },
  t,
  h,
  withToken,
  onTick,
  fmt: { duration, clock: clockText, ago },
};
window.so = so;

// ---------- i18n ----------

/** Label lookup: URL label.* > config display.labels > tone table > plain table > key. */
function t(key, vars = {}) {
  const s =
    urlLabels[key] ?? so.state?.meta?.labels?.[key] ?? so.tables.tone[key] ?? so.tables.plain[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, v) => (vars[v] ?? `{${v}}`));
}

let loadedTone;
async function loadTables(tone) {
  if (tone === loadedTone) return;
  loadedTone = tone;
  const get = (n) => fetch(`/i18n/${encodeURIComponent(n)}.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  const [plain, toneTable] = await Promise.all([get("plain"), tone === "plain" ? {} : get(tone)]);
  so.tables = { plain, tone: toneTable };
  for (const key of Object.keys(so.state ?? {})) fire("so:state", { key });
}

// ---------- display params ----------

const root = document.documentElement;

function applyDisplay() {
  const meta = so.state?.meta ?? {};
  const theme = params.get("theme") ?? meta.theme ?? "terminal";
  setStylesheet("so-theme", theme.endsWith(".css") ? theme : `/themes/${encodeURIComponent(theme)}.css`);
  if (meta.css) setStylesheet("so-extra-css", meta.css);
  const font = params.get("font") ?? meta.font;
  if (font) {
    root.style.setProperty("--so-font", `"${font}", ui-monospace, monospace`);
    if (!/[/\\]/.test(font)) {
      setStylesheet(
        "so-font",
        `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font).replace(/%20/g, "+")}:wght@400;600;700&display=swap`,
      );
    }
  }
  const scale = Number(params.get("scale"));
  if (scale >= 0.5 && scale <= 3) root.style.setProperty("--so-scale", String(scale));
  const align = params.get("align");
  if (align === "left" || align === "center" || align === "right") root.dataset.align = align;
  if (params.get("bg") === "solid") root.dataset.bg = "solid";
  for (const part of (params.get("hide") ?? "").split(",").filter(Boolean)) root.classList.add(`so-hide-${part}`);
  loadTables(params.get("tone") ?? meta.tone ?? "plain");
}

function setStylesheet(id, href) {
  let el = document.getElementById(id);
  if (el?.getAttribute("href") === href) return;
  if (!el) {
    el = document.createElement("link");
    el.id = id;
    el.rel = "stylesheet";
    document.head.append(el);
  }
  el.href = href;
}

// ---------- SSE ----------

function fire(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

let lostTimer;
function connect() {
  const es = new EventSource(withToken("/events"));
  es.addEventListener("snapshot", (e) => {
    so.state = JSON.parse(e.data);
    setConnected(true);
    applyDisplay();
    for (const key of Object.keys(so.state)) fire("so:state", { key });
    fire("so:ready", {});
  });
  es.addEventListener("slice", (e) => {
    const { key, value } = JSON.parse(e.data);
    if (!so.state) return;
    so.state = { ...so.state, [key]: value };
    if (key === "meta") applyDisplay();
    fire("so:state", { key });
  });
  es.addEventListener("fx", (e) => {
    const fx = JSON.parse(e.data);
    fire("so:fx", fx);
  });
  es.onerror = () => {
    setConnected(false);
    // EventSource reconnects by itself (retry: 2000); if the server closed hard, reopen.
    if (es.readyState === EventSource.CLOSED) setTimeout(connect, 2000);
  };
}

function setConnected(ok) {
  so.connected = ok;
  clearTimeout(lostTimer);
  if (ok) root.classList.remove("so-offline");
  else lostTimer = setTimeout(() => root.classList.add("so-offline"), 5000);
}

// ---------- shared clock ----------

const tickers = new Set();
/** Subscribe to a shared ~4 Hz clock driven by one requestAnimationFrame loop. */
function onTick(fn) {
  tickers.add(fn);
  return () => tickers.delete(fn);
}
let lastQuarter = 0;
function frame(now) {
  const q = Math.floor(Date.now() / 250);
  if (q !== lastQuarter) {
    lastQuarter = q;
    for (const fn of tickers) {
      try {
        fn(Date.now());
      } catch (e) {
        console.error(e);
      }
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
// OBS may throttle rAF for hidden sources; a slow fallback keeps text fresh.
setInterval(() => {
  if (tickers.size) for (const fn of tickers) fn(Date.now());
}, 1000);

// ---------- helpers ----------

/** Escape text for innerHTML templates. */
function h(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function clockText(ms) {
  const neg = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  const hh = Math.floor(s / 3600);
  s -= hh * 3600;
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return `${neg ? "-" : ""}${hh ? `${hh}:${p(mm)}` : p(mm)}:${p(ss)}`;
}

function duration(ms) {
  if (ms == null) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function ago(ts, now = Date.now()) {
  if (!ts) return "";
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return t("time.seconds", { n: s });
  if (s < 3600) return t("time.minutes", { n: Math.floor(s / 60) });
  return t("time.hours", { n: Math.floor(s / 3600) });
}

// ---------- widget base class ----------

/**
 * Base for <so-*> elements. Subclasses set `static slices = [...]` and implement
 * render(state). Optional: tick(now) for clock-driven text, fx(name, payload).
 */
export class SoElement extends HTMLElement {
  static slices = [];

  connectedCallback() {
    this.classList.add("so-widget", `so-${this.localName.slice(3)}`);
    this._onState = (e) => {
      if (this.constructor.slices.includes(e.detail.key) || e.detail.key === "meta") this.update();
    };
    this._onFx = (e) => this.fx?.(e.detail.name, e.detail.payload ?? {});
    window.addEventListener("so:state", this._onState);
    window.addEventListener("so:fx", this._onFx);
    if (this.tick) this._untick = onTick((now) => so.state && this.tick(now));
    if (so.state) this.update();
  }

  disconnectedCallback() {
    window.removeEventListener("so:state", this._onState);
    window.removeEventListener("so:fx", this._onFx);
    this._untick?.();
  }

  update() {
    if (!so.state) return;
    this.render(so.state);
    this.tick?.(Date.now());
  }

  /** Toggle the hidden state (empty widgets hide themselves). */
  setEmpty(empty) {
    this.classList.toggle("so-empty", !!empty);
  }

  /** Restart a CSS animation class. */
  flash(cls, el = this, ms = 1500) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    clearTimeout(el[`_t_${cls}`]);
    el[`_t_${cls}`] = setTimeout(() => el.classList.remove(cls), ms);
  }
}

export { so, t, h };

connect();
