/**
 * stats-dashboard.ts — the 时间统计 (time-allocation) view.
 *
 * Zero-dependency vanilla DOM, same house style as expense-dashboard. Reads the
 * parsed day files (override-first), then leans on src/core/stats.ts for all the
 * number-crunching. Renders, for a chosen period:
 *   - a KPI hero (total tracked time, daily average, vs. previous period)
 *   - a conic-gradient donut of category shares (+ an "未追踪" wedge in 全天 mode)
 *   - a ranked table (时长 / 占比 / 日均) where a row expands to its label breakdown
 *   - a per-day stacked bar trend
 *
 * Percentages toggle between "已记录" (share of tracked time) and "全天" (share of
 * calendar days × 24h). Background blocks are excluded — see core/stats.ts.
 */
import type { App } from "obsidian";
import {
  aggregate,
  dailySeries,
  subBreakdown,
  type DayBlocks,
  type ShareBase,
  type StatsBlock,
} from "../core/stats";

export interface StatsConfig {
  dataRoot: string;
  /** category → hex; shared with the calendar (settings.calendar.colors). */
  colors: Record<string, string>;
  fallbackColor: string;
}
export interface MountOpts {
  app: App;
  config: Partial<StatsConfig>;
}

// ---------- dom helper ----------
function el(tag: string, props?: any, ...kids: any[]): HTMLElement {
  const e = document.createElement(tag);
  props = props || {};
  for (const k in props) {
    const v = props[k];
    if (v == null) continue;
    if (k === "style") Object.assign(e.style, v);
    else if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of kids) {
    if (c == null) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
}
const clear = (n: any) => (n.empty ? n.empty() : (n.innerHTML = ""));

// ---------- date utils ----------
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toDate = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const getMonday = (d: Date) => addDays(d, -((d.getDay() + 6) % 7));
const dateOf = (p: string) => (p.match(/(\d{4}-\d{2}-\d{2})\.json$/) || [])[1];
const spanDays = (from: string, to: string) =>
  Math.max(0, Math.round((toDate(to).getTime() - toDate(from).getTime()) / 86400000) + 1);

/** minutes → "Xh Ym" / "Ym" / "Xh"; compact for axis caps. */
function fmtDur(min: number): string {
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}m`;
  if (r === 0) return `${h}h`;
  return `${h}h${r}m`;
}
const fmtH = (min: number) => (min / 60).toFixed(min >= 600 ? 0 : 1) + "h";
const pct = (s: number) => (s * 100).toFixed(s >= 0.1 ? 0 : 1) + "%";

// ---------- color utils ----------
function hexRgb(hex: string): [number, number, number] {
  let h = String(hex || "#888").replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const textOn = (hex: string) => {
  const [r, g, b] = hexRgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "rgba(0,0,0,.72)" : "#fff";
};

// ---------- recursive file walk ----------
async function walk(A: any, dir: string, skip: string | null): Promise<string[]> {
  const out: string[] = [];
  let listing: any;
  try {
    listing = await A.list(dir);
  } catch (e) {
    return out;
  }
  for (const f of listing.files) if (f.endsWith(".json")) out.push(f);
  for (const sub of listing.folders) {
    const clean = sub.replace(/\/$/, "");
    if (skip && clean === skip) continue;
    out.push(...(await walk(A, sub, skip)));
  }
  return out;
}

const UNTRACKED = "#9aa0a8";

// ===================================================================
export async function mount(container: HTMLElement, opts: MountOpts): Promise<void> {
  const app = opts.app;
  const cfg = opts.config || {};
  const A: any = app.vault.adapter;

  const DATA_ROOT = cfg.dataRoot || ".lifelog/daily";
  const OVERRIDE_ROOT = `${DATA_ROOT}/overrides`;
  const COLORS: Record<string, string> = cfg.colors || {};
  const FALLBACK = cfg.fallbackColor || "#c0c4ca";
  const colorOf = (c: string) => COLORS[c] || FALLBACK;

  // ---------- load (override-first) ----------
  let days: DayBlocks[] = [];
  let byDate = new Map<string, DayBlocks>();
  let minDate = "";
  let maxDate = "";
  async function load() {
    const rawFiles = await walk(A, DATA_ROOT, OVERRIDE_ROOT);
    const ovFiles = await walk(A, OVERRIDE_ROOT, null);
    const fileByDate = new Map<string, string>();
    for (const f of rawFiles) {
      const d = dateOf(f);
      if (d) fileByDate.set(d, f);
    }
    for (const f of ovFiles) {
      const d = dateOf(f);
      if (d) fileByDate.set(d, f); // override wins
    }
    byDate = new Map();
    for (const [date, f] of [...fileByDate.entries()].sort()) {
      let j: any;
      try {
        j = JSON.parse(await A.read(f));
      } catch (e) {
        console.warn("[lifelog stats] 坏文件", f, e);
        continue;
      }
      const blocks: StatsBlock[] = (j.blocks || []).map((b: any) => ({
        start: b.start,
        end: b.end ?? null,
        category: b.category || "其他",
        label: b.label || "",
        background: !!b.background,
      }));
      byDate.set(date, { date, blocks });
    }
    days = [...byDate.values()];
    const allDates = [...byDate.keys()].sort();
    minDate = allDates[0] || ymd(new Date());
    maxDate = allDates[allDates.length - 1] || ymd(new Date());
  }
  await load();

  // ---------- state ----------
  const today = ymd(new Date());
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const ctx = { nowMin, todayDate: today };
  const state: {
    from: string;
    to: string;
    base: ShareBase;
    drill: string | null;
  } = {
    from: ymd(getMonday(new Date())),
    to: today,
    base: "tracked",
    drill: null,
  };
  // If the default (this week) has no data, fall back to the full span.
  if (![...byDate.keys()].some((d) => d >= state.from && d <= state.to)) {
    state.from = minDate;
    state.to = maxDate;
  }

  const inRange = (from = state.from, to = state.to): DayBlocks[] =>
    days.filter((d) => d.date >= from && d.date <= to);

  injectStyle();
  clear(container);
  const root = el("div", { class: "lf-stats" });
  container.append(root);

  // =================== sub-renderers ===================
  function periodBar(): HTMLElement {
    const bar = el("div", { class: "lf-period" });
    const quick = (label: string, from: string, to: string) => {
      const on = state.from === from && state.to === to;
      return el("button", { class: on ? "on" : "", onclick: () => { state.from = from; state.to = to; state.drill = null; render(); } }, label);
    };
    const d0 = new Date();
    bar.append(
      el(
        "div",
        { class: "seg" },
        quick("今天", today, today),
        quick("本周", ymd(getMonday(d0)), today),
        quick("本月", `${today.slice(0, 7)}-01`, today),
        quick("近7天", ymd(addDays(d0, -6)), today),
        quick("近30天", ymd(addDays(d0, -29)), today),
        quick("全部", minDate, maxDate),
      ),
    );
    bar.append(
      el(
        "div",
        { class: "dates" },
        el("input", { type: "date", value: state.from, min: minDate, max: maxDate, onchange: (e: any) => { state.from = e.target.value; state.drill = null; render(); } }),
        el("span", { class: "tilde" }, "→"),
        el("input", { type: "date", value: state.to, min: minDate, max: maxDate, onchange: (e: any) => { state.to = e.target.value; state.drill = null; render(); } }),
        // base toggle: 已记录 vs 全天
        el(
          "div",
          { class: "seg base" },
          el("button", { class: state.base === "tracked" ? "on" : "", title: "占已记录时长", onclick: () => { state.base = "tracked"; render(); } }, "已记录"),
          el("button", { class: state.base === "full" ? "on" : "", title: "占全天 24h(露出未追踪缺口)", onclick: () => { state.base = "full"; render(); } }, "全天"),
        ),
      ),
    );
    return bar;
  }

  function periodLabel(): string {
    if (state.from === state.to) return state.from === today ? "今天" : state.from.slice(5);
    if (state.from === minDate && state.to === maxDate) return "全部";
    return state.from.slice(5) + "→" + state.to.slice(5);
  }

  function kpi(): HTMLElement {
    const r = aggregate(inRange(), spanDays(state.from, state.to), state.base, ctx);
    // previous period of equal length, immediately before `from`
    const len = spanDays(state.from, state.to);
    const prevTo = ymd(addDays(toDate(state.from), -1));
    const prevFrom = ymd(addDays(toDate(state.from), -len));
    const prev = aggregate(inRange(prevFrom, prevTo), len, "tracked", ctx);
    const delta = prev.trackedMinutes > 0 ? ((r.trackedMinutes - prev.trackedMinutes) / prev.trackedMinutes) * 100 : null;

    const hero = el(
      "div",
      { class: "lf-hero" },
      el("div", { class: "lbl" }, periodLabel() + " · 已记录时长"),
      el("div", { class: "big" }, fmtDur(r.trackedMinutes)),
      delta == null
        ? null
        : el(
            "div",
            { class: "mom", style: { color: delta >= 0 ? "#e0697f" : "#3fb98a" } },
            (delta >= 0 ? "▲ " : "▼ ") + Math.abs(delta).toFixed(0) + "%",
            el("span", { class: "sub" }, ` 较上期 ${fmtDur(prev.trackedMinutes)}`),
          ),
    );
    const stats = el(
      "div",
      { class: "lf-stat-row" },
      el("div", { class: "stat" }, el("div", { class: "v" }, fmtDur(r.perDayMinutes)), el("div", { class: "l" }, "日均")),
      el("div", { class: "stat" }, el("div", { class: "v" }, String(len)), el("div", { class: "l" }, "天数")),
      el("div", { class: "stat" }, el("div", { class: "v" }, String(r.byCategory.length)), el("div", { class: "l" }, "类别")),
    );
    return el("div", {}, hero, stats);
  }

  function donutCard(): HTMLElement {
    const r = aggregate(inRange(), spanDays(state.from, state.to), state.base, ctx);
    const card = el("div", { class: "lf-card" }, el("div", { class: "lf-card-h" }, "大类占比"));
    if (!r.byCategory.length) {
      card.append(el("div", { class: "lf-empty" }, "这段时间没有记录"));
      return card;
    }
    const denom = state.base === "full" ? r.fullMinutes : r.trackedMinutes;
    // build conic-gradient stops (cumulative %)
    const stops: string[] = [];
    let acc = 0;
    for (const c of r.byCategory) {
      const a = (acc / denom) * 100;
      acc += c.minutes;
      const b = (acc / denom) * 100;
      stops.push(`${colorOf(c.category)} ${a}% ${b}%`);
    }
    if (state.base === "full" && r.untrackedMinutes > 0) {
      const a = (acc / denom) * 100;
      stops.push(`${UNTRACKED} ${a}% 100%`);
    }
    const ring = el(
      "div",
      { class: "lf-donut", style: { background: `conic-gradient(${stops.join(", ")})` } },
      el(
        "div",
        { class: "hole" },
        el("div", { class: "big" }, fmtH(r.trackedMinutes)),
        el("div", { class: "sub" }, state.base === "full" ? `占全天 ${pct(r.trackedMinutes / r.fullMinutes)}` : "已记录"),
      ),
    );
    card.append(el("div", { class: "lf-donut-wrap" }, ring));
    return card;
  }

  function tableCard(): HTMLElement {
    const list = inRange();
    const r = aggregate(list, spanDays(state.from, state.to), state.base, ctx);
    const len = spanDays(state.from, state.to);
    const card = el("div", { class: "lf-card" }, el("div", { class: "lf-card-h" }, "分类明细"));
    if (!r.byCategory.length) {
      card.append(el("div", { class: "lf-empty" }, "—"));
      return card;
    }
    const maxMin = Math.max(...r.byCategory.map((c) => c.minutes));
    const tbl = el("div", { class: "lf-table" });
    for (const c of r.byCategory) {
      const open = state.drill === c.category;
      const row = el(
        "div",
        { class: "lf-row" + (open ? " open" : ""), title: "点击展开子类", onclick: () => { state.drill = open ? null : c.category; render(); } },
        el("span", { class: "sw", style: { background: colorOf(c.category) } }),
        el("span", { class: "nm" }, (open ? "▾ " : "▸ ") + c.category),
        el("span", { class: "bar" }, el("span", { class: "fill", style: { width: `${(c.minutes / maxMin) * 100}%`, background: colorOf(c.category) } })),
        el("span", { class: "pc" }, pct(c.share)),
        el("span", { class: "du" }, fmtDur(c.minutes)),
        el("span", { class: "av" }, fmtDur(c.minutes / len) + "/天"),
      );
      tbl.append(row);
      if (open) {
        const subs = subBreakdown(list, c.category, ctx);
        const subMax = Math.max(1, ...subs.map((s) => s.minutes));
        const box = el("div", { class: "lf-sub" });
        for (const s of subs) {
          box.append(
            el(
              "div",
              { class: "lf-subrow" },
              el("span", { class: "nm" }, s.category),
              el("span", { class: "bar" }, el("span", { class: "fill", style: { width: `${(s.minutes / subMax) * 100}%`, background: colorOf(c.category) } })),
              el("span", { class: "pc" }, pct(s.share)),
              el("span", { class: "du" }, fmtDur(s.minutes)),
            ),
          );
        }
        tbl.append(box);
      }
    }
    card.append(tbl);
    return card;
  }

  function trendCard(): HTMLElement {
    const series = dailySeries(inRange(), ctx);
    const card = el("div", { class: "lf-card" }, el("div", { class: "lf-card-h" }, "每日时长(按大类堆叠)"));
    if (!series.length) {
      card.append(el("div", { class: "lf-empty" }, "—"));
      return card;
    }
    const maxTot = Math.max(1, ...series.map((d) => d.total));
    const H = 120; // px for the tallest day
    const chart = el("div", { class: "lf-trend" });
    for (const d of series) {
      const col = el("div", { class: "col", title: `${d.date.slice(5)}　${fmtDur(d.total)}` });
      const stack = el("div", { class: "stack", style: { height: `${(d.total / maxTot) * H}px` } });
      // stack segments largest-first from the bottom
      const segs = [...d.byCategory.entries()].sort((a, b) => b[1] - a[1]);
      for (const [cat, m] of segs) {
        stack.append(el("div", { class: "seg", style: { height: `${(m / maxTot) * H}px`, background: colorOf(cat) }, title: `${cat} ${fmtDur(m)}` }));
      }
      col.append(el("div", { class: "cap" }, fmtH(d.total)), stack, el("div", { class: "xlab" }, d.date.slice(5)));
      chart.append(col);
    }
    card.append(el("div", { class: "lf-trend-scroll" }, chart));
    return card;
  }

  function legendCard(): HTMLElement {
    const r = aggregate(inRange(), spanDays(state.from, state.to), state.base, ctx);
    const wrap = el("div", { class: "lf-legend" });
    for (const c of r.byCategory) {
      wrap.append(el("span", { class: "lg" }, el("span", { class: "dot", style: { background: colorOf(c.category) } }), c.category + " " + pct(c.share)));
    }
    if (state.base === "full" && r.untrackedMinutes > 0) {
      wrap.append(el("span", { class: "lg" }, el("span", { class: "dot", style: { background: UNTRACKED } }), "未追踪 " + pct(r.untrackedMinutes / r.fullMinutes)));
    }
    return wrap;
  }

  function render() {
    clear(root);
    root.append(periodBar());
    root.append(kpi());
    const top = el("div", { class: "lf-top" }, donutCard(), el("div", { class: "lf-top-right" }, legendCard()));
    root.append(top);
    root.append(tableCard());
    root.append(trendCard());
  }
  render();
}

// ---------- scoped style (once) ----------
function injectStyle() {
  if (document.getElementById("lf-stats-style")) return;
  const css = `
.lf-stats{font-size:13px;line-height:1.4;}
.lf-stats .lf-period{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px;}
.lf-stats .seg{display:inline-flex;border:1px solid var(--background-modifier-border);border-radius:7px;overflow:hidden;}
.lf-stats .seg button{border:0;background:transparent;padding:4px 10px;cursor:pointer;color:var(--text-muted);font-size:12px;border-right:1px solid var(--background-modifier-border);}
.lf-stats .seg button:last-child{border-right:0;}
.lf-stats .seg button.on{background:var(--interactive-accent);color:var(--text-on-accent);}
.lf-stats .dates{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
.lf-stats .dates input{font-size:12px;padding:2px 4px;}
.lf-stats .seg.base{margin-left:4px;}
.lf-stats .lf-hero{margin:6px 0 2px;}
.lf-stats .lf-hero .lbl{color:var(--text-muted);font-size:12px;}
.lf-stats .lf-hero .big{font-size:30px;font-weight:700;letter-spacing:.5px;}
.lf-stats .lf-hero .mom{font-size:12px;font-weight:600;}
.lf-stats .lf-hero .mom .sub{color:var(--text-muted);font-weight:400;}
.lf-stats .lf-stat-row{display:flex;gap:18px;margin:8px 0 14px;}
.lf-stats .stat .v{font-size:16px;font-weight:600;}
.lf-stats .stat .l{font-size:11px;color:var(--text-muted);}
.lf-stats .lf-top{display:flex;gap:18px;flex-wrap:wrap;align-items:center;}
.lf-stats .lf-top-right{flex:1;min-width:160px;}
.lf-stats .lf-card{background:var(--background-secondary);border-radius:10px;padding:12px 14px;margin:10px 0;}
.lf-stats .lf-card-h{font-weight:600;font-size:13px;margin-bottom:8px;}
.lf-stats .lf-empty{color:var(--text-muted);font-size:12px;padding:8px 0;}
.lf-stats .lf-donut-wrap{display:flex;justify-content:center;padding:6px 0;}
.lf-stats .lf-donut{width:150px;height:150px;border-radius:50%;position:relative;}
.lf-stats .lf-donut .hole{position:absolute;inset:26px;border-radius:50%;background:var(--background-primary);display:flex;flex-direction:column;align-items:center;justify-content:center;}
.lf-stats .lf-donut .hole .big{font-size:18px;font-weight:700;}
.lf-stats .lf-donut .hole .sub{font-size:10px;color:var(--text-muted);}
.lf-stats .lf-legend{display:flex;flex-direction:column;gap:4px;}
.lf-stats .lf-legend .lg{display:flex;align-items:center;gap:6px;font-size:12px;}
.lf-stats .lf-legend .dot{width:10px;height:10px;border-radius:3px;display:inline-block;}
.lf-stats .lf-table{display:flex;flex-direction:column;}
.lf-stats .lf-row{display:grid;grid-template-columns:14px 1.4fr 2fr auto auto auto;gap:8px;align-items:center;padding:5px 4px;border-radius:6px;cursor:pointer;}
.lf-stats .lf-row:hover{background:var(--background-modifier-hover);}
.lf-stats .lf-row .sw{width:11px;height:11px;border-radius:3px;}
.lf-stats .lf-row .nm{font-weight:500;white-space:nowrap;}
.lf-stats .lf-row .bar{height:7px;background:var(--background-modifier-border);border-radius:4px;overflow:hidden;}
.lf-stats .lf-row .bar .fill,.lf-stats .lf-subrow .bar .fill{display:block;height:100%;border-radius:4px;}
.lf-stats .lf-row .pc{font-variant-numeric:tabular-nums;font-weight:600;text-align:right;min-width:38px;}
.lf-stats .lf-row .du{font-variant-numeric:tabular-nums;color:var(--text-muted);text-align:right;min-width:48px;}
.lf-stats .lf-row .av{font-variant-numeric:tabular-nums;color:var(--text-faint);text-align:right;min-width:60px;font-size:11px;}
.lf-stats .lf-sub{padding:2px 0 8px 22px;}
.lf-stats .lf-subrow{display:grid;grid-template-columns:1.4fr 2fr auto auto;gap:8px;align-items:center;padding:3px 4px;font-size:12px;color:var(--text-muted);}
.lf-stats .lf-subrow .bar{height:5px;background:var(--background-modifier-border);border-radius:3px;overflow:hidden;}
.lf-stats .lf-subrow .pc,.lf-stats .lf-subrow .du{font-variant-numeric:tabular-nums;text-align:right;min-width:38px;}
.lf-stats .lf-trend-scroll{overflow-x:auto;padding-bottom:4px;}
.lf-stats .lf-trend{display:flex;align-items:flex-end;gap:6px;min-height:160px;}
.lf-stats .lf-trend .col{display:flex;flex-direction:column;align-items:center;gap:3px;min-width:22px;}
.lf-stats .lf-trend .cap{font-size:9px;color:var(--text-faint);}
.lf-stats .lf-trend .stack{display:flex;flex-direction:column-reverse;width:18px;border-radius:3px;overflow:hidden;}
.lf-stats .lf-trend .stack .seg{width:100%;}
.lf-stats .lf-trend .xlab{font-size:9px;color:var(--text-muted);transform:rotate(-45deg);transform-origin:top left;white-space:nowrap;height:18px;}
`;
  const tag = el("style", { id: "lf-stats-style", html: css });
  document.head.append(tag);
}
