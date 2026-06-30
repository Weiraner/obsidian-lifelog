/**
 * expense-dashboard.ts — the 记账 (expense) view.
 *
 * Faithful TypeScript port of the original zero-dependency vanilla-JS component.
 * Boundaries are typed (mount signature + config); the internal DOM-building
 * code stays dynamic by design — it's exercised through the Obsidian runtime,
 * not the type checker. Reads override-first (override file wins over raw daily),
 * counts only `type === "支出"`, and writes edits back into the overrides layer.
 */
import type { App } from "obsidian";

export interface ExpenseCatStyle {
  color: string;
  icon: string;
}
export interface ExpenseConfig {
  dataRoot: string;
  overrideRoot: string;
  catsPath: string;
  incomeCats: string[];
  accent: string;
  upColor: string;
  downColor: string;
  fallbackColor: string;
  fallbackIcon: string;
  tableLimit: number;
  cats: Record<string, ExpenseCatStyle>;
}
export interface MountOpts {
  app: App;
  config: Partial<ExpenseConfig>;
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
const clear = (n: any) => {
  if (n.empty) n.empty();
  else n.innerHTML = "";
};

// ---------- number / date utils ----------
const round2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number) => "¥" + round2(n).toFixed(2);
const fmtShort = (n: number) =>
  n >= 1000 ? "¥" + (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : "¥" + Math.round(n);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const dateOf = (p: string) => (p.match(/(\d{4}-\d{2}-\d{2})\.json$/) || [])[1];
const pad = (n: number) => String(n).padStart(2, "0");
const toDate = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function isoWeekKey(s: string): string {
  const d = toDate(s);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day + 3);
  const firstThu = new Date(d.getFullYear(), 0, 4);
  const week = 1 + Math.round(((d.getTime() - firstThu.getTime()) / 86400000 - 3 + ((firstThu.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${pad(week)}`;
}
function hexRgb(hex: string): [number, number, number] {
  let h = String(hex || "#888").replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function hexToRgba(hex: string, a: number) {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
function mix(hex: string, target: string, t: number) {
  const a = hexRgb(hex),
    b = hexRgb(target);
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
function textOn(hex: string) {
  const [r, g, b] = hexRgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "rgba(0,0,0,.72)" : "#fff";
}

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

// ===================================================================
export async function mount(container: HTMLElement, opts: MountOpts): Promise<any> {
  const app = opts.app;
  const cfg = opts.config || {};
  const A: any = app.vault.adapter;

  const DATA_ROOT = cfg.dataRoot || ".lifelog/daily";
  const OVERRIDE_ROOT = cfg.overrideRoot || ".lifelog/daily/overrides";
  const CATS_PATH = cfg.catsPath || ".lifelog/categories.json";
  const INCOME_CATS = new Set(cfg.incomeCats || ["出物", "红包", "劳动", "转账", "请客"]);
  const ACCENT = cfg.accent || "#6c8eef";
  const UP = cfg.upColor || "#e0697f";
  const DOWN = cfg.downColor || "#3fb98a";
  const CAT: Record<string, ExpenseCatStyle> = cfg.cats || {};
  const FALLBACK_COLOR = cfg.fallbackColor || "#b5bac2";
  const FALLBACK_ICON = cfg.fallbackIcon || "📦";
  const TBL_LIMIT = cfg.tableLimit || 400;

  const colorOf = (c: string) => (CAT[c] && CAT[c].color) || FALLBACK_COLOR;
  const iconOf = (c: string) => (CAT[c] && CAT[c].icon) || FALLBACK_ICON;

  // ---------- categories enum (static) ----------
  let cats: any = { expense_categories: {} };
  try {
    cats = JSON.parse(await A.read(CATS_PATH));
  } catch (e) {
    console.warn("categories.json 读取失败", e);
  }
  const enumCats = Object.keys(cats.expense_categories || {}).filter((c) => !INCOME_CATS.has(c));

  // ---------- dataset (reloadable) ----------
  let all: any[] = [],
    dailyTotalMap: Map<string, number> = new Map(),
    srcByDate: Map<string, string> = new Map(),
    fileByDate: Map<string, { f: string; src: string }> = new Map(),
    minDate = "",
    maxDate = "",
    catList: string[] = [],
    channelList: string[] = [];
  async function load() {
    const rawFiles = await walk(A, DATA_ROOT, OVERRIDE_ROOT);
    const ovFiles = await walk(A, OVERRIDE_ROOT, null);
    fileByDate = new Map();
    for (const f of rawFiles) {
      const d = dateOf(f);
      if (d) fileByDate.set(d, { f, src: "daily" });
    }
    for (const f of ovFiles) {
      const d = dateOf(f);
      if (d) fileByDate.set(d, { f, src: "override" });
    }

    all = [];
    dailyTotalMap = new Map();
    srcByDate = new Map();
    for (const [date, { f, src }] of [...fileByDate.entries()].sort()) {
      srcByDate.set(date, src);
      let j: any;
      try {
        j = JSON.parse(await A.read(f));
      } catch (e) {
        console.warn("坏文件", f, e);
        continue;
      }
      let dayTot = 0;
      (j.expenses || []).forEach((e: any, fi: number) => {
        if ((e.type || "支出") !== "支出") return;
        const amount = Number(e.amount) || 0;
        all.push({
          date,
          fidx: fi,
          time: e.time || "",
          amount,
          item: e.item || "",
          category: e.category || "其他",
          sub: e.sub || "",
          channel: e.channel || null,
        });
        dayTot += amount;
      });
      dailyTotalMap.set(date, round2(dayTot));
    }
    const allDates = [...fileByDate.keys()].sort();
    minDate = allDates[0] || ymd(new Date());
    maxDate = allDates[allDates.length - 1] || ymd(new Date());
    const dataCats = [...new Set(all.map((e) => e.category))];
    catList = [...new Set([...enumCats, ...dataCats])];
    channelList = [...new Set(all.map((e) => e.channel).filter(Boolean))].sort();
  }
  await load();
  async function reload() {
    await load();
  }

  // ---------- write back to override (full doc; only expenses) ----------
  async function getFullDoc(date: string): Promise<any> {
    const ent = fileByDate.get(date);
    if (ent) {
      try {
        return JSON.parse(await A.read(ent.f));
      } catch (e) {
        console.warn("读取失败", ent.f, e);
      }
    }
    return { date, expenses: [] };
  }
  async function commitExpenses(date: string, doc: any) {
    const ym = date.slice(0, 7);
    for (const d of [`${DATA_ROOT}/overrides`, `${DATA_ROOT}/overrides/${ym}`]) {
      try {
        if (!(await A.exists(d))) await A.mkdir(d);
      } catch (e) {}
    }
    await A.write(`${DATA_ROOT}/overrides/${ym}/${date}.json`, JSON.stringify(doc, null, 1));
    await reload();
    render();
  }
  async function saveEntry(rec: any, patch: any) {
    const doc = await getFullDoc(rec.date);
    doc.expenses = doc.expenses || [];
    if (doc.expenses[rec.fidx]) doc.expenses[rec.fidx] = Object.assign({}, doc.expenses[rec.fidx], patch);
    else doc.expenses.push(Object.assign({ type: "支出" }, patch));
    await commitExpenses(rec.date, doc);
  }
  async function deleteEntry(rec: any) {
    const doc = await getFullDoc(rec.date);
    doc.expenses = doc.expenses || [];
    if (rec.fidx < doc.expenses.length) doc.expenses.splice(rec.fidx, 1);
    await commitExpenses(rec.date, doc);
  }
  // Add a brand-new expense (manual entry) to a given day's override doc.
  async function addEntry(date: string, patch: any) {
    const doc = await getFullDoc(date);
    doc.expenses = doc.expenses || [];
    doc.expenses.push(Object.assign({ type: "支出", time: null }, patch));
    if (date < state.from) state.from = date; // make the new entry visible
    if (date > state.to) state.to = date;
    await commitExpenses(date, doc);
  }

  // ---------- state ----------
  const today = ymd(new Date());
  const state: any = {
    tab: "概览",
    from: `${today.slice(0, 7)}-01`,
    to: today,
    trend: "day",
    cats: new Set<string>(),
    channels: new Set<string>(),
    q: "",
    sortKey: "date",
    sortDir: -1,
  };
  if (![...fileByDate.keys()].some((d) => d >= state.from && d <= state.to)) {
    state.from = minDate;
    state.to = maxDate;
  }

  function filtered(applyDrill: boolean): any[] {
    const q = state.q.trim().toLowerCase();
    return all.filter((e) => {
      if (e.date < state.from || e.date > state.to) return false;
      if (applyDrill) {
        if (state.cats.size && !state.cats.has(e.category)) return false;
        if (state.channels.size && !state.channels.has(e.channel)) return false;
        if (q && !`${e.item} ${e.category} ${e.sub} ${e.channel || ""}`.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }

  // ---------- style (once) ----------
  injectStyle(ACCENT, UP);

  // ---------- root ----------
  clear(container);
  const root = el("div", { class: "exp-dash" });
  container.append(root);

  // =================== sub-renderers ===================
  function kpiBlock() {
    const data = filtered(false);
    const tot = sum(data.map((e) => e.amount));
    const cnt = data.length;
    const span = (toDate(state.to).getTime() - toDate(state.from).getTime()) / 86400000 + 1;
    const perDay = span > 0 ? tot / span : 0;
    const prevTo = ymd(new Date(toDate(state.from).getTime() - 86400000));
    const prevFrom = ymd(new Date(toDate(state.from).getTime() - span * 86400000));
    const prevTot = sum(all.filter((e) => e.date >= prevFrom && e.date <= prevTo).map((e) => e.amount));
    const mom = prevTot > 0 ? ((tot - prevTot) / prevTot) * 100 : null;

    const hero = el(
      "div",
      { class: "exp-hero" },
      el("div", { class: "lbl" }, periodLabel() + " · 支出"),
      el("div", { class: "big" }, fmt(tot).replace(".00", "")),
      mom == null
        ? null
        : el(
            "div",
            { class: "mom", style: { color: mom >= 0 ? UP : DOWN } },
            (mom >= 0 ? "▲ " : "▼ ") + Math.abs(mom).toFixed(0) + "%",
            el("span", { class: "sub" }, ` 较上期 ${fmtShort(prevTot)}`),
          ),
    );
    const stats = el(
      "div",
      { class: "exp-stats" },
      el("div", { class: "stat" }, el("div", { class: "v" }, cnt), el("div", { class: "l" }, "笔数")),
      el("div", { class: "stat" }, el("div", { class: "v" }, fmtShort(perDay)), el("div", { class: "l" }, "日均")),
      el("div", { class: "stat" }, el("div", { class: "v" }, cnt ? fmtShort(tot / cnt) : "¥0"), el("div", { class: "l" }, "笔均")),
    );
    return el("div", {}, hero, stats);
  }

  function periodLabel() {
    if (state.from === minDate && state.to === maxDate) return "全部";
    if (state.from === `${today.slice(0, 7)}-01` && state.to === today) return "本月";
    return state.from.slice(5) + "→" + state.to.slice(5);
  }

  function periodBar() {
    const bar = el("div", { class: "exp-period" });
    const quick = (label: string, fromD: string, toD: string) => {
      const on = state.from === fromD && state.to === toD;
      return el("button", { class: on ? "on" : "", onclick: () => { state.from = fromD; state.to = toD; render(); } }, label);
    };
    const d0 = new Date();
    bar.append(
      el(
        "div",
        { class: "seg" },
        quick("本月", `${today.slice(0, 7)}-01`, today),
        quick("近30天", ymd(new Date(d0.getTime() - 29 * 86400000)), today),
        quick("全部", minDate, maxDate),
      ),
    );
    bar.append(
      el(
        "div",
        { class: "dates" },
        el("input", { type: "date", value: state.from, min: minDate, max: maxDate, onchange: (e: any) => { state.from = e.target.value; render(); } }),
        el("span", { class: "tilde" }, "→"),
        el("input", { type: "date", value: state.to, min: minDate, max: maxDate, onchange: (e: any) => { state.to = e.target.value; render(); } }),
        el("button", { class: "exp-add", title: "新增一笔花销(写入 override)", onclick: () => openCreate() }, "＋ 记一笔"),
      ),
    );
    return bar;
  }

  function tabBar() {
    const tabs = ["概览", "分类", "明细"];
    const seg = el("div", { class: "exp-tabs" });
    for (const t of tabs) {
      seg.append(el("button", { class: state.tab === t ? "on" : "", onclick: () => { state.tab = t; render(); } }, t));
    }
    return seg;
  }

  // ---- 概览 ----
  function viewOverview() {
    const data = filtered(false);
    const wrap = el("div", {});

    const trendCard = card(
      "支出趋势",
      el(
        "div",
        { class: "seg sm" },
        ...["day", "week", "month"].map((p) =>
          el("button", { class: state.trend === p ? "on" : "", onclick: () => { state.trend = p; render(); } }, ({ day: "日", week: "周", month: "月" } as any)[p]),
        ),
      ),
    );
    const keyFn = state.trend === "day" ? (e: any) => e.date : state.trend === "week" ? (e: any) => isoWeekKey(e.date) : (e: any) => e.date.slice(0, 7);
    const agg = new Map<string, number>();
    // Track each bucket's actual date span so a click can scope 明细 to exactly
    // the records that make up the bar (precise; no empty calendar padding).
    const bounds = new Map<string, { min: string; max: string }>();
    for (const e of data) {
      const k = keyFn(e);
      agg.set(k, (agg.get(k) || 0) + e.amount);
      const b = bounds.get(k);
      if (!b) bounds.set(k, { min: e.date, max: e.date });
      else {
        if (e.date < b.min) b.min = e.date;
        if (e.date > b.max) b.max = e.date;
      }
    }
    const keys = [...agg.keys()].sort();
    const maxV = Math.max(1, ...agg.values());
    const chart = el("div", { class: "exp-trend" });
    for (const k of keys) {
      const v = agg.get(k)!;
      const b = bounds.get(k)!;
      chart.append(
        el(
          "div",
          { class: "col", title: `${k}　${fmt(v)}　— 点击查看明细`, onclick: () => drillToPeriod(b.min, b.max) },
          el("div", { class: "cap" }, v >= 1000 ? (v / 1000).toFixed(1) + "k" : Math.round(v)),
          el("div", { class: "barfill", style: { height: `${Math.round((v / maxV) * 100)}px` } }),
          el("div", { class: "xlab" }, state.trend === "month" ? k.slice(2) : k.slice(5)),
        ),
      );
    }
    trendCard.append(keys.length ? chart : empty());
    wrap.append(trendCard);

    const catTot = new Map<string, number>();
    const subByCat = new Map<string, Map<string, number>>();
    for (const e of data) {
      catTot.set(e.category, (catTot.get(e.category) || 0) + e.amount);
      if (!subByCat.has(e.category)) subByCat.set(e.category, new Map());
      const sm = subByCat.get(e.category)!;
      const sk = e.sub || "（未分）";
      sm.set(sk, (sm.get(sk) || 0) + e.amount);
    }
    const ranked = [...catTot.entries()].sort((a, b) => b[1] - a[1]);
    const tot = sum([...catTot.values()]);
    const shareCard = card("类目占比");
    if (ranked.length) {
      shareCard.append(stackedBar(ranked, tot));
      const list = el("div", { class: "exp-catlist" });
      for (const [c, v] of ranked) list.append(catRow(c, v, tot, subByCat.get(c) || new Map()));
      shareCard.append(list);
    } else shareCard.append(empty());
    wrap.append(shareCard);

    wrap.append(heatCard());
    return wrap;
  }

  function drillTo(cat: string, sub: string | null) {
    state.cats = new Set([cat]);
    state.channels.clear();
    state.q = sub && sub !== "（未分）" ? sub : "";
    state.tab = "明细";
    render();
  }

  // Narrow the period to [from, to] (a clicked trend bar / heat cell) and jump
  // to 明细 showing everything in it — category/channel/search drill is cleared
  // so the detail matches the bar, which is computed across all categories.
  function drillToPeriod(from: string, to: string) {
    state.from = from;
    state.to = to;
    state.cats.clear();
    state.channels.clear();
    state.q = "";
    state.tab = "明细";
    render();
  }

  function stackedBar(ranked: [string, number][], tot: number) {
    const bar = el("div", { class: "exp-stack" });
    for (const [c, v] of ranked) {
      const frac = tot > 0 ? v / tot : 0;
      bar.append(
        el("div", {
          class: "seg",
          style: { width: `${frac * 100}%`, background: colorOf(c) },
          title: `${c}　${fmt(v)}　(${(frac * 100).toFixed(0)}%)　— 点击查看明细`,
          onclick: () => drillTo(c, null),
        }),
      );
    }
    return bar;
  }

  function catRow(c: string, v: number, tot: number, subMap: Map<string, number>) {
    const base = colorOf(c);
    const subs = [...subMap.entries()].sort((a, b) => b[1] - a[1]);
    const n = subs.length;
    const bar = el("div", { class: "exp-subbar" });
    subs.forEach(([s, sv], i) => {
      const frac = v > 0 ? sv / v : 0;
      const bg = mix(base, "#ffffff", n > 1 ? (i / (n - 1)) * 0.55 : 0);
      const fg = textOn(bg);
      bar.append(
        el(
          "div",
          {
            class: "seg",
            style: { width: `${frac * 100}%`, background: bg, color: fg },
            title: `${c} - ${s}　${fmt(sv)}　(${(frac * 100).toFixed(0)}%)　— 点击查看明细`,
            onclick: () => drillTo(c, s),
          },
          el("span", { class: "lab" }, `${s} ${fmtShort(sv)}`),
        ),
      );
    });
    return el(
      "div",
      { class: "exp-catrow" },
      el(
        "div",
        { class: "head" },
        el("span", { class: "ic" }, iconOf(c)),
        el("span", { class: "nm" }, c),
        el("span", { class: "amt" }, fmt(v).replace(".00", "")),
        el("span", { class: "pct", style: { color: base } }, tot > 0 ? ((v / tot) * 100).toFixed(0) + "%" : ""),
      ),
      bar,
    );
  }

  function heatCard() {
    const c = card("消费日历");
    const start = toDate(state.from),
      end = toDate(state.to);
    const cells: string[] = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) cells.push(ymd(new Date(d)));
    const hmMax = Math.max(1, ...cells.map((d) => dailyTotalMap.get(d) || 0));
    const grid = el("div", { class: "exp-heat" });
    let week = el("div", { class: "wk" });
    const firstDow = (toDate(cells[0] || state.from).getDay() + 6) % 7;
    for (let i = 0; i < firstDow; i++) week.append(el("div", { class: "cell ghost" }));
    for (const d of cells) {
      const v = dailyTotalMap.get(d) || 0;
      const lvl = v <= 0 ? 0 : Math.max(0.18, v / hmMax);
      week.append(
        el("div", {
          class: "cell" + (v > 0 ? " hit" : ""),
          style: { background: v <= 0 ? "var(--background-modifier-border)" : hexToRgba(ACCENT, lvl) },
          title: v > 0 ? `${d}　${fmt(v)}　— 点击查看明细` : `${d}　${fmt(v)}`,
          onclick: v > 0 ? () => drillToPeriod(d, d) : null,
        }),
      );
      if ((toDate(d).getDay() + 6) % 7 === 6) {
        grid.append(week);
        week = el("div", { class: "wk" });
      }
    }
    if (week.childNodes.length) grid.append(week);
    c.append(cells.length ? grid : empty());
    c.append(
      el(
        "div",
        { class: "exp-heat-legend" },
        "少",
        ...[0.18, 0.4, 0.7, 1].map((a) => el("div", { class: "cell", style: { background: hexToRgba(ACCENT, a) } })),
        "多",
      ),
    );
    return c;
  }

  // ---- 分类 ----
  function viewCategories() {
    const data = filtered(false);
    const wrap = el("div", {});
    const catTot = new Map<string, number>();
    for (const e of data) catTot.set(e.category, (catTot.get(e.category) || 0) + e.amount);
    const ranked = [...catTot.entries()].sort((a, b) => b[1] - a[1]);
    const tot = sum([...catTot.values()]);
    const rmax = Math.max(1, ...ranked.map((r) => r[1]));

    const rankCard = card("类目排行");
    rankCard.append(el("div", { class: "exp-hint" }, "点一行 → 在「明细」筛选该类目"));
    for (const [c, v] of ranked) {
      rankCard.append(
        el(
          "div",
          { class: "exp-rank", onclick: () => { state.cats = new Set([c]); state.channels.clear(); state.q = ""; state.tab = "明细"; render(); } },
          el("span", { class: "ic" }, iconOf(c)),
          el(
            "div",
            { class: "mid" },
            el("div", { class: "top" }, el("span", { class: "nm" }, c), el("span", { class: "amt" }, fmt(v).replace(".00", ""))),
            el("div", { class: "track" }, el("div", { class: "fill", style: { width: `${Math.max(3, (v / rmax) * 100)}%`, background: colorOf(c) } })),
          ),
          el("span", { class: "pct" }, tot > 0 ? ((v / tot) * 100).toFixed(0) + "%" : ""),
        ),
      );
    }
    if (!ranked.length) rankCard.append(empty());
    wrap.append(rankCard);

    const chTot = new Map<string, number>();
    for (const e of data) {
      const k = e.channel || "（无渠道）";
      chTot.set(k, (chTot.get(k) || 0) + e.amount);
    }
    const chRanked = [...chTot.entries()].sort((a, b) => b[1] - a[1]);
    if (chRanked.length) {
      const cmax = Math.max(1, ...chRanked.map((r) => r[1]));
      const chCard = card("渠道分布");
      for (const [c, v] of chRanked) {
        chCard.append(
          el(
            "div",
            { class: "exp-rank slim" },
            el(
              "div",
              { class: "mid" },
              el("div", { class: "top" }, el("span", { class: "nm" }, c), el("span", { class: "amt" }, fmt(v).replace(".00", ""))),
              el("div", { class: "track" }, el("div", { class: "fill", style: { width: `${Math.max(3, (v / cmax) * 100)}%`, background: hexToRgba(ACCENT, 0.85) } })),
            ),
          ),
        );
      }
      wrap.append(chCard);
    }
    return wrap;
  }

  // ---- 明细 ----
  function viewDetail() {
    const wrap = el("div", {});
    const f = card("筛选");
    f.append(
      el("input", {
        class: "exp-search",
        type: "text",
        placeholder: "搜索 项目 / 类目 / 渠道…",
        value: state.q,
        oninput: (e: any) => { state.q = e.target.value; renderTableOnly(); },
      }),
    );
    const catBar = el("div", { class: "exp-chips" });
    for (const c of catList) {
      const on = state.cats.has(c);
      catBar.append(
        el(
          "span",
          {
            class: "chip" + (on ? " on" : ""),
            style: on ? { background: colorOf(c), borderColor: "transparent", color: "#fff" } : null,
            onclick: () => { on ? state.cats.delete(c) : state.cats.add(c); render(); },
          },
          iconOf(c) + " " + c,
        ),
      );
    }
    f.append(catBar);
    if (channelList.length) {
      const chBar = el("div", { class: "exp-chips" });
      chBar.append(el("span", { class: "chips-lbl" }, "渠道"));
      for (const ch of channelList) {
        const on = state.channels.has(ch);
        chBar.append(el("span", { class: "chip" + (on ? " on" : ""), style: on ? { background: ACCENT, borderColor: "transparent", color: "#fff" } : null, onclick: () => { on ? state.channels.delete(ch) : state.channels.add(ch); render(); } }, ch));
      }
      f.append(chBar);
    }
    if (state.cats.size || state.channels.size || state.q) {
      f.append(el("span", { class: "exp-clear", onclick: () => { state.cats.clear(); state.channels.clear(); state.q = ""; render(); } }, "✕ 清空筛选"));
    }
    wrap.append(f);

    const tblCard = card("明细");
    tblCard.id = "exp-tbl-card";
    tblCard.append(tableEl());
    wrap.append(tblCard);
    return wrap;
  }

  function tableEl() {
    const data = filtered(true);
    const box = el("div", {});
    box.append(el("div", { class: "exp-hint" }, `共 ${data.length} 笔　·　合计 ${fmt(sum(data.map((e) => e.amount))).replace(".00", "")}　·　点行编辑（写入 override）`));
    const rows = [...data].sort((a, b) => {
      let r = 0;
      if (state.sortKey === "amount") r = a.amount - b.amount;
      else if (state.sortKey === "date") r = (a.date + a.time).localeCompare(b.date + b.time);
      else r = String(a[state.sortKey]).localeCompare(String(b[state.sortKey]));
      return r * state.sortDir;
    });
    const table = el("table", { class: "exp-table" });
    const head = el("tr");
    const cdef = [["date", "日期"], ["item", "项目"], ["category", "类目"], ["channel", "渠道"], ["amount", "金额", "num"]];
    for (const [k, label, cls] of cdef)
      head.append(
        el("th", { class: cls || "", onclick: () => { if (state.sortKey === k) state.sortDir *= -1; else { state.sortKey = k; state.sortDir = k === "amount" ? -1 : 1; } renderTableOnly(); } }, label + (state.sortKey === k ? (state.sortDir > 0 ? " ↑" : " ↓") : "")),
      );
    table.append(head);
    for (const e of rows.slice(0, TBL_LIMIT)) {
      table.append(
        el(
          "tr",
          { class: "editable", onclick: () => openEdit(e) },
          el("td", {}, el("span", { title: srcByDate.get(e.date) === "override" ? "已人工清洗" : "raw" }, e.date.slice(5)), el("span", { class: "tm" }, " " + e.time.slice(0, 5))),
          el("td", {}, e.item || "—"),
          el("td", {}, el("span", { class: "exp-tag", style: { background: hexToRgba(colorOf(e.category), 0.16), color: colorOf(e.category) } }, iconOf(e.category) + " " + e.category), e.sub ? el("span", { class: "sub" }, " " + e.sub) : null),
          el("td", { class: "ch" }, e.channel || "—"),
          el("td", { class: "num" }, fmt(e.amount).replace(".00", "")),
        ),
      );
    }
    box.append(el("div", { class: "exp-tablewrap" }, table));
    if (rows.length > TBL_LIMIT) box.append(el("div", { class: "exp-hint" }, `仅显示前 ${TBL_LIMIT} / 共 ${rows.length} 条`));
    return box;
  }

  function renderTableOnly() {
    const c = root.querySelector("#exp-tbl-card");
    if (!c) return render();
    const h = c.querySelector(".exp-card-h");
    clear(c);
    if (h) c.append(h);
    c.append(tableEl());
  }

  // ---------- edit modal (save/delete → override expenses) ----------
  function openEdit(rec: any) {
    const overlay = el("div", { class: "exp-overlay", onclick: (ev: any) => { if (ev.target === overlay) overlay.remove(); } });
    const itemIn = el("input", { type: "text", value: rec.item }) as HTMLInputElement;
    const amtIn = el("input", { type: "number", step: "0.01", value: String(rec.amount) }) as HTMLInputElement;
    const catOpts = [...new Set([...catList, rec.category])];
    const catSel = el("select", {}, ...catOpts.map((c) => el("option", { value: c, selected: c === rec.category ? "selected" : null }, iconOf(c) + " " + c))) as HTMLSelectElement;
    const subIn = el("input", { type: "text", value: rec.sub, list: "exp-dl-sub", placeholder: "二级（可空）" }) as HTMLInputElement;
    const chIn = el("input", { type: "text", value: rec.channel || "", list: "exp-dl-ch", placeholder: "渠道（可空）" }) as HTMLInputElement;
    const subSet = [...new Set(all.map((e) => e.sub).filter(Boolean))].sort();
    const dlSub = el("datalist", { id: "exp-dl-sub" }, ...subSet.map((s) => el("option", { value: s })));
    const dlCh = el("datalist", { id: "exp-dl-ch" }, ...channelList.map((s) => el("option", { value: s })));
    const fld = (label: string, input: any) => el("label", { class: "fld" }, el("span", {}, label), input);
    const modal = el(
      "div",
      { class: "exp-modal" },
      el("h3", {}, "编辑记录"),
      el("div", { class: "meta" }, `${rec.date}　${(rec.time || "").slice(0, 8)}　·　${srcByDate.get(rec.date) === "override" ? "override" : "raw → 将写入 override"}`),
      fld("项目", itemIn),
      fld("金额", amtIn),
      fld("类目", catSel),
      fld("二级", subIn),
      fld("渠道", chIn),
      dlSub,
      dlCh,
      el(
        "div",
        { class: "acts" },
        el("button", { class: "del", onclick: async () => { if (window.confirm("删除这条记录？")) { overlay.remove(); await deleteEntry(rec); } } }, "删除"),
        el(
          "span",
          {},
          el("button", { onclick: () => overlay.remove() }, "取消"),
          el("button", { class: "primary", onclick: async () => { const patch = { item: itemIn.value.trim(), amount: Number(amtIn.value) || 0, category: catSel.value, sub: subIn.value.trim(), channel: chIn.value.trim() || null }; overlay.remove(); await saveEntry(rec, patch); } }, "保存"),
        ),
      ),
    );
    overlay.append(modal);
    document.body.append(overlay);
  }

  // ---------- new-expense modal (manual entry → override) ----------
  function openCreate() {
    const overlay = el("div", { class: "exp-overlay", onclick: (ev: any) => { if (ev.target === overlay) overlay.remove(); } });
    const defaultDate = state.to <= today ? state.to : today;
    const dateIn = el("input", { type: "date", value: defaultDate }) as HTMLInputElement;
    const timeIn = el("input", { type: "time", step: "1" }) as HTMLInputElement;
    const itemIn = el("input", { type: "text", value: "", placeholder: "项目" }) as HTMLInputElement;
    const amtIn = el("input", { type: "number", step: "0.01", value: "", placeholder: "0.00" }) as HTMLInputElement;
    const catOpts = catList.length ? catList : ["其他"];
    const catSel = el("select", {}, ...catOpts.map((c) => el("option", { value: c }, iconOf(c) + " " + c))) as HTMLSelectElement;
    const subIn = el("input", { type: "text", value: "", list: "exp-dl-sub", placeholder: "二级（可空）" }) as HTMLInputElement;
    const chIn = el("input", { type: "text", value: "", list: "exp-dl-ch", placeholder: "渠道（可空）" }) as HTMLInputElement;
    const subSet = [...new Set(all.map((e) => e.sub).filter(Boolean))].sort();
    const dlSub = el("datalist", { id: "exp-dl-sub" }, ...subSet.map((s) => el("option", { value: s })));
    const dlCh = el("datalist", { id: "exp-dl-ch" }, ...channelList.map((s) => el("option", { value: s })));
    const fld = (label: string, input: any) => el("label", { class: "fld" }, el("span", {}, label), input);
    const err = el("div", { class: "exp-err" });
    const modal = el(
      "div",
      { class: "exp-modal" },
      el("h3", {}, "新增花销"),
      el("div", { class: "meta" }, "手动记一笔,写入对应日期的 override(中间数据层)"),
      fld("日期", dateIn),
      fld("时间", timeIn),
      fld("项目", itemIn),
      fld("金额", amtIn),
      fld("类目", catSel),
      fld("二级", subIn),
      fld("渠道", chIn),
      dlSub,
      dlCh,
      err,
      el(
        "div",
        { class: "acts" },
        el("span", {}),
        el(
          "span",
          {},
          el("button", { onclick: () => overlay.remove() }, "取消"),
          el("button", {
            class: "primary",
            onclick: async () => {
              const date = dateIn.value;
              const amount = round2(Number(amtIn.value) || 0);
              if (!date) { err.textContent = "请选择日期"; return; }
              if (!(amount > 0)) { err.textContent = "金额需大于 0"; return; }
              const t = timeIn.value.trim();
              const patch = {
                time: t ? (t.length === 5 ? t + ":00" : t) : null,
                item: itemIn.value.trim(),
                amount,
                category: catSel.value,
                sub: subIn.value.trim(),
                channel: chIn.value.trim() || null,
              };
              overlay.remove();
              await addEntry(date, patch);
            },
          }, "保存"),
        ),
      ),
    );
    overlay.append(modal);
    document.body.append(overlay);
    itemIn.focus();
  }

  // ---------- helpers ----------
  function card(title: string, headRight?: any) {
    const c = el("div", { class: "exp-card" });
    if (title) c.append(el("div", { class: "exp-card-h" }, el("h4", {}, title), headRight || null));
    return c;
  }
  const empty = () => el("div", { class: "exp-empty" }, "无数据");

  // ---------- master render ----------
  function render() {
    clear(root);
    root.append(periodBar());
    root.append(kpiBlock());
    root.append(tabBar());
    const content = el("div", { class: "exp-content" });
    content.append(state.tab === "概览" ? viewOverview() : state.tab === "分类" ? viewCategories() : viewDetail());
    root.append(content);
    root.append(el("div", { class: "exp-foot" }, `${minDate} ~ ${maxDate}　·　${fileByDate.size} 天　·　override ${[...srcByDate.values()].filter((s) => s === "override").length} 天`));
    bindSwipe(content);
  }

  function bindSwipe(content: HTMLElement) {
    const tabs = ["概览", "分类", "明细"];
    let x0: number | null = null;
    content.addEventListener("touchstart", (e: any) => { x0 = e.touches[0].clientX; }, { passive: true });
    content.addEventListener("touchend", (e: any) => {
      if (x0 == null) return;
      const dx = e.changedTouches[0].clientX - x0;
      x0 = null;
      if (Math.abs(dx) < 60) return;
      const i = tabs.indexOf(state.tab);
      const ni = dx < 0 ? Math.min(tabs.length - 1, i + 1) : Math.max(0, i - 1);
      if (ni !== i) { state.tab = tabs[ni]; render(); }
    }, { passive: true });
  }

  render();
  return { state, render };
}

// ===================================================================
function injectStyle(accent: string, UP: string) {
  const id = "exp-dash-style";
  let s = document.getElementById(id);
  const css = `
    .exp-dash { --acc:${accent}; --r:16px; font-size:14px; line-height:1.5; max-width:920px; margin:0 auto; }
    .exp-dash * { box-sizing:border-box; }
    .exp-period { display:flex; flex-wrap:wrap; gap:10px; align-items:center; justify-content:space-between; margin:4px 0 14px; }
    .exp-period .seg { display:inline-flex; background:var(--background-modifier-border); border-radius:10px; padding:3px; }
    .exp-period .seg button { border:none; background:transparent; padding:5px 14px; border-radius:8px; cursor:pointer; color:var(--text-muted); font-size:13px; }
    .exp-period .seg button.on { background:var(--background-primary); color:var(--text-normal); font-weight:600; box-shadow:0 1px 3px rgba(0,0,0,.08); }
    .exp-period .dates { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--text-muted); }
    .exp-period input[type=date] { background:var(--background-secondary); border:1px solid var(--background-modifier-border); border-radius:8px; padding:4px 8px; color:var(--text-normal); font-size:12px; }
    .exp-period .exp-add { background:${accent}; color:#fff; border:none; border-radius:8px; padding:5px 12px; cursor:pointer; font-size:12px; font-weight:600; white-space:nowrap; }
    .exp-period .exp-add:hover { filter:brightness(1.08); }
    .exp-hero { background:linear-gradient(135deg, ${hexToRgba(accent, 0.16)}, ${hexToRgba(accent, 0.04)}); border:1px solid ${hexToRgba(accent, 0.18)}; border-radius:var(--r); padding:18px 20px; margin-bottom:12px; }
    .exp-hero .lbl { font-size:13px; color:var(--text-muted); }
    .exp-hero .big { font-size:38px; font-weight:800; letter-spacing:-.5px; margin:2px 0 4px; font-variant-numeric:tabular-nums; }
    .exp-hero .mom { font-size:13px; font-weight:600; } .exp-hero .mom .sub { color:var(--text-muted); font-weight:400; }
    .exp-stats { display:flex; gap:12px; margin-bottom:16px; }
    .exp-stats .stat { flex:1; background:var(--background-secondary); border-radius:14px; padding:12px 14px; text-align:center; }
    .exp-stats .stat .v { font-size:19px; font-weight:700; font-variant-numeric:tabular-nums; }
    .exp-stats .stat .l { font-size:11px; color:var(--text-muted); margin-top:2px; }
    .exp-tabs { display:flex; background:var(--background-modifier-border); border-radius:12px; padding:4px; gap:4px; margin-bottom:14px; }
    .exp-tabs button { flex:1; border:none; background:transparent; padding:8px 0; border-radius:9px; cursor:pointer; color:var(--text-muted); font-size:14px; font-weight:500; }
    .exp-tabs button.on { background:var(--background-primary); color:var(--acc); font-weight:700; box-shadow:0 1px 4px rgba(0,0,0,.1); }
    .exp-content { animation:exp-fade .18s ease; }
    @keyframes exp-fade { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }
    .exp-card { background:var(--background-secondary); border-radius:var(--r); padding:16px 18px; margin-bottom:14px; box-shadow:0 1px 2px rgba(0,0,0,.04), 0 2px 8px rgba(0,0,0,.04); }
    .exp-card-h { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
    .exp-card-h h4 { margin:0; font-size:14px; font-weight:700; }
    .exp-hint { font-size:11px; color:var(--text-muted); margin:-4px 0 10px; }
    .exp-empty { color:var(--text-muted); text-align:center; padding:28px 0; font-size:13px; }
    .seg.sm { display:inline-flex; background:var(--background-modifier-border); border-radius:9px; padding:2px; }
    .seg.sm button { border:none; background:transparent; padding:3px 11px; border-radius:7px; cursor:pointer; color:var(--text-muted); font-size:12px; }
    .seg.sm button.on { background:var(--background-primary); color:var(--text-normal); font-weight:600; }
    .exp-trend { display:flex; align-items:flex-end; gap:4px; height:140px; overflow-x:auto; padding-top:14px; }
    .exp-trend .col { display:flex; flex-direction:column; align-items:center; flex:1 0 20px; min-width:20px; cursor:pointer; border-radius:5px; transition:background .12s; }
    .exp-trend .col:hover { background:var(--background-modifier-hover); }
    .exp-trend .cap { font-size:9px; color:var(--text-muted); margin-bottom:3px; }
    .exp-trend .barfill { width:62%; min-height:2px; border-radius:5px 5px 0 0; background:linear-gradient(to top, ${hexToRgba(accent, 0.55)}, ${accent}); }
    .exp-trend .col:hover .barfill { filter:brightness(1.12); }
    .exp-trend .xlab { font-size:9px; color:var(--text-faint); margin-top:5px; white-space:nowrap; }
    .exp-stack { display:flex; width:100%; height:26px; border-radius:8px; overflow:hidden; background:var(--background-modifier-border); }
    .exp-stack .seg { height:100%; min-width:2px; transition:filter .12s; cursor:pointer; }
    .exp-stack .seg:hover { filter:brightness(1.12); }
    .exp-catlist { display:flex; flex-direction:column; gap:14px; margin-top:16px; }
    .exp-catrow .head { display:flex; align-items:center; gap:7px; font-size:13px; margin-bottom:5px; }
    .exp-catrow .head .ic { font-size:15px; }
    .exp-catrow .head .nm { font-weight:600; }
    .exp-catrow .head .amt { margin-left:auto; font-variant-numeric:tabular-nums; color:var(--text-muted); }
    .exp-catrow .head .pct { font-weight:700; font-size:12px; width:36px; text-align:right; }
    .exp-subbar { display:flex; width:100%; height:24px; border-radius:7px; overflow:hidden; background:var(--background-modifier-border); }
    .exp-subbar .seg { height:100%; min-width:3px; display:flex; align-items:center; padding:0 6px; overflow:hidden; transition:filter .12s; cursor:pointer; }
    .exp-subbar .seg:hover { filter:brightness(1.08); }
    .exp-subbar .seg .lab { font-size:11px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .exp-rank { display:flex; align-items:center; gap:12px; padding:9px 8px; border-radius:11px; cursor:pointer; transition:background .12s; }
    .exp-rank:hover { background:var(--background-modifier-hover); }
    .exp-rank.slim { cursor:default; } .exp-rank.slim:hover { background:none; }
    .exp-rank .ic { font-size:20px; flex:0 0 auto; width:26px; text-align:center; }
    .exp-rank .mid { flex:1; min-width:0; }
    .exp-rank .top { display:flex; justify-content:space-between; font-size:13px; margin-bottom:5px; }
    .exp-rank .top .nm { font-weight:600; } .exp-rank .top .amt { font-variant-numeric:tabular-nums; }
    .exp-rank .track { height:7px; border-radius:4px; background:var(--background-modifier-border); overflow:hidden; }
    .exp-rank .track .fill { height:100%; border-radius:4px; }
    .exp-rank .pct { font-size:12px; color:var(--text-muted); width:34px; text-align:right; flex:0 0 auto; }
    .exp-heat { display:flex; gap:3px; overflow-x:auto; padding:6px 0 4px; }
    .exp-heat .wk { display:flex; flex-direction:column; gap:3px; }
    .exp-heat .cell { width:14px; height:14px; border-radius:3px; }
    .exp-heat .cell.hit { cursor:pointer; }
    .exp-heat .cell.hit:hover { outline:2px solid var(--text-muted); outline-offset:1px; }
    .exp-heat .cell.ghost { visibility:hidden; }
    .exp-heat-legend { display:flex; gap:4px; align-items:center; margin-top:8px; font-size:11px; color:var(--text-muted); }
    .exp-heat-legend .cell { width:14px; height:14px; border-radius:3px; }
    .exp-search { width:100%; background:var(--background-primary); border:1px solid var(--background-modifier-border); border-radius:10px; padding:8px 12px; color:var(--text-normal); font-size:13px; margin-bottom:10px; }
    .exp-chips { display:flex; flex-wrap:wrap; gap:7px; align-items:center; margin-bottom:8px; }
    .exp-chips .chips-lbl { font-size:11px; color:var(--text-muted); }
    .exp-chips .chip { padding:5px 12px; border-radius:14px; border:1px solid var(--background-modifier-border); cursor:pointer; user-select:none; font-size:12.5px; color:var(--text-muted); background:var(--background-primary); }
    .exp-chips .chip.on { font-weight:600; }
    .exp-clear { font-size:12px; color:var(--acc); cursor:pointer; }
    .exp-tablewrap { overflow-x:auto; }
    .exp-table { width:100%; border-collapse:collapse; font-size:12.5px; }
    .exp-table th, .exp-table td { padding:8px 10px; border-bottom:1px solid var(--background-modifier-border); text-align:left; white-space:nowrap; }
    .exp-table th { cursor:pointer; color:var(--text-muted); font-weight:600; font-size:12px; }
    .exp-table td.num, .exp-table th.num { text-align:right; font-variant-numeric:tabular-nums; font-weight:600; }
    .exp-table .tm { color:var(--text-faint); font-size:11px; }
    .exp-table .ch { color:var(--text-muted); }
    .exp-table tr:hover td { background:var(--background-modifier-hover); }
    .exp-table tr.editable { cursor:pointer; }
    .exp-tag { padding:2px 9px; border-radius:11px; font-size:11px; font-weight:600; }
    .exp-table .sub { color:var(--text-muted); font-size:11px; }
    .exp-overlay { position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px; }
    .exp-modal { background:var(--background-primary); border-radius:16px; width:100%; max-width:420px; padding:20px 22px; box-shadow:0 12px 40px rgba(0,0,0,.35); }
    .exp-modal h3 { margin:0 0 2px; font-size:16px; }
    .exp-modal .meta { font-size:11px; color:var(--text-muted); margin-bottom:14px; }
    .exp-modal .fld { display:flex; align-items:center; gap:10px; margin-bottom:10px; }
    .exp-modal .fld > span { width:46px; font-size:12px; color:var(--text-muted); flex:0 0 auto; }
    .exp-modal .fld input, .exp-modal .fld select { flex:1; min-width:0; background:var(--background-secondary); border:1px solid var(--background-modifier-border); border-radius:8px; padding:7px 10px; color:var(--text-normal); font-size:13px; }
    .exp-modal .acts { display:flex; justify-content:space-between; align-items:center; margin-top:18px; }
    .exp-modal .acts button { border:1px solid var(--background-modifier-border); background:var(--background-secondary); border-radius:8px; padding:7px 16px; cursor:pointer; color:var(--text-normal); font-size:13px; margin-left:8px; }
    .exp-modal .acts .del { color:${UP}; border-color:transparent; background:transparent; margin-left:0; }
    .exp-modal .acts .primary { background:${accent}; color:#fff; border-color:transparent; font-weight:600; }
    .exp-modal .exp-err { color:${UP}; font-size:12px; min-height:14px; margin-top:6px; }
    .exp-foot { color:var(--text-faint); font-size:11px; margin-top:6px; text-align:center; }
  `;
  if (s) s.textContent = css;
  else {
    s = el("style", { id, html: css });
    document.head.append(s);
  }
}
