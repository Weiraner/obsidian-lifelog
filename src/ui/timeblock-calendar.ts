/**
 * timeblock-calendar.ts — the time-block (calendar) view.
 *
 * Faithful TypeScript port of the original zero-dependency vanilla-JS component.
 * Day/week grid with lazy per-day loading (override-first), overlap layout,
 * adjacent-block merge, cross-midnight carry-over, zoom, and inline editing that
 * writes back to the overrides layer. Boundaries are typed; the dynamic DOM and
 * geometry code is exercised through the Obsidian runtime.
 */
import type { App } from "obsidian";

export interface TimeblockConfig {
  dataRoot: string;
  colors: Record<string, string>;
  fallbackColor: string;
  presenceColor: string;
  blockOpacity: number;
  hourPx: number;
  minHourPx: number;
  maxHourPx: number;
  zoomStep: number;
  scrollMaxVh: number;
  autoFit: boolean;
  autoFitRatio: number;
  mergeGapMin: number;
}
export interface MountOpts {
  app: App;
  config: Partial<TimeblockConfig>;
}

const WD = ["一", "二", "三", "四", "五", "六", "日"];

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
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s: string) => {
  const [y, m, d] = String(s).split("-").map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const getMonday = (d: Date) => addDays(d, -((d.getDay() + 6) % 7));
const nowMin = () => {
  const n = new Date();
  return n.getHours() * 60 + n.getMinutes();
};
const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function hexToRgba(hex: string, a: number) {
  let h = String(hex || "#888").replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16) || 0;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function shade(hex: string, f: number) {
  let h = String(hex || "#888").replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16) || 0;
  return `rgb(${Math.round(((n >> 16) & 255) * f)},${Math.round(((n >> 8) & 255) * f)},${Math.round((n & 255) * f)})`;
}
// 朝白色混合 f(0~1):用于深色模式下把马卡龙色提亮成浅色字体,保证暗底可读。
function tint(hex: string, f: number) {
  let h = String(hex || "#888").replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16) || 0;
  const mix = (c: number) => Math.round(c + (255 - c) * f);
  return `rgb(${mix((n >> 16) & 255)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
}
// Obsidian 在 <body> 上挂 theme-dark / theme-light;据此切换字体明暗方向。
function isDarkTheme() {
  return typeof document !== "undefined" && document.body.classList.contains("theme-dark");
}
// 可读的文字色:浅色模式加深(白底),深色模式提亮(暗底)。
function textColor(color: string) {
  return isDarkTheme() ? tint(color, 0.45) : shade(color, 0.55);
}

// 解析时钟字符串 → 当天午夜起算分钟(可<0 或 >1440)。容错 前一天/后一天/H:MM[:SS]。
function parseClock(s: any): number | null {
  if (s == null) return null;
  let str = String(s).trim(),
    cross = 0;
  if (str.includes("前一天")) cross = -1;
  else if (str.includes("后一天")) cross = 1;
  str = str.replace(/前一天|后一天/g, "").trim();
  const m = str.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const min = +m[1] * 60 + +m[2] + (m[3] ? +m[3] / 60 : 0);
  return min + cross * 1440;
}

function splitTime(s: any): { off: number; hms: string } {
  if (s == null) return { off: 0, hms: "" };
  let str = String(s),
    off = 0;
  if (str.includes("前一天")) off = -1;
  else if (str.includes("后一天")) off = 1;
  const m = str.replace(/前一天|后一天/g, "").trim().match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  return { off, hms: m ? `${m[1].padStart(2, "0")}:${m[2]}:${m[3] || "00"}` : "" };
}
function joinTime(off: number, hms: any): string | null | undefined {
  hms = String(hms || "").trim();
  if (!hms) return null;
  if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(hms)) return undefined;
  const pre = off < 0 ? "前一天 " : off > 0 ? "后一天 " : "";
  return pre + (hms.split(":").length === 2 ? hms + ":00" : hms);
}

// 合并相邻同 label/同 category 的块 → render units(group 保留 segments)
function mergeAdjacent(fg: any[], gap: number): any[] {
  const sorted = fg.slice().sort((a, b) => a.s - b.s || a.e - b.e);
  const units: any[] = [];
  let run: any[] = [];
  const flush = () => {
    if (!run.length) return;
    if (run.length === 1) units.push(Object.assign({ kind: "single" }, run[0]));
    else
      units.push({
        kind: "group",
        label: run[0].label,
        category: run[0].category,
        s: run[0].s,
        e: run[run.length - 1].e,
        segments: run.slice(),
        col: 0,
        ncol: 1,
      });
    run = [];
  };
  for (const b of sorted) {
    if (run.length) {
      const prev = run[run.length - 1];
      const sameLabel = (b.label || "") !== "" && b.label === prev.label && b.category === prev.category;
      const g = b.s - prev.e;
      if (sameLabel && g >= -1 && g <= gap) {
        run.push(b);
        continue;
      }
      flush();
    }
    run.push(b);
  }
  flush();
  return units;
}

function layoutCluster(cluster: any[]) {
  if (cluster.length === 1) {
    const u = cluster[0];
    u.leftPct = 0;
    u.widthPct = 100;
    u.layer = 0;
    u.textCapPct = 100;
    return;
  }
  const byDur = cluster.slice().sort((a, b) => b.e - b.s - (a.e - a.s) || a.s - b.s);
  const primary = byDur[0];
  primary.leftPct = 0;
  primary.widthPct = 100;
  primary.layer = 0;
  primary.textCapPct = 50;
  const rest = byDur.slice(1).sort((a, b) => a.s - b.s || a.e - b.e);
  primary._cover = rest.map((b: any) => [b.s, b.e]);
  const subEnds: number[] = [];
  for (const b of rest) {
    let placed = false;
    for (let i = 0; i < subEnds.length; i++)
      if (subEnds[i] <= b.s + 1e-6) {
        b._sub = i;
        subEnds[i] = b.e;
        placed = true;
        break;
      }
    if (!placed) {
      b._sub = subEnds.length;
      subEnds.push(b.e);
    }
  }
  const subN = subEnds.length || 1;
  for (const b of rest) {
    const w = 50 / subN;
    b.leftPct = 50 + b._sub * w;
    b.widthPct = w;
    b.layer = 1;
    b.textCapPct = 100;
  }
}

function packColumns(items: any[]) {
  items.sort((a, b) => a.s - b.s || a.e - b.e);
  let cluster: any[] = [],
    clusterEnd: number | null = null;
  const flush = () => {
    if (!cluster.length) return;
    layoutCluster(cluster);
    cluster = [];
  };
  for (const b of items) {
    if (clusterEnd !== null && b.s >= clusterEnd) {
      flush();
      clusterEnd = null;
    }
    cluster.push(b);
    clusterEnd = clusterEnd === null ? b.e : Math.max(clusterEnd, b.e);
  }
  flush();
}

// ============================ component ============================
export class TimeBlockCalendar {
  host: HTMLElement;
  app: App;
  cfg: Partial<TimeblockConfig>;
  colors: Record<string, string>;
  fallback: string;
  opacity: number;
  dataRoot: string;
  minH: number;
  maxH: number;
  zoomStep: number;
  autoFitRatio: number;
  mergeGap: number;
  state: any;
  dayCache: Map<string, any>;
  normCache: Map<string, any>;
  _nowTimer: any;
  _restoreScrollTop: number | null;
  _scrollToNow: boolean;
  _manualLock?: boolean;
  _lastW?: number;
  _ro?: ResizeObserver;
  scrollEl: any;
  gridEl: any;
  axisEl: any;
  zoomSlider: any;
  zoomLabel: any;
  autoBtn: any;
  cols: any;
  viewDays: any;
  viewNorms: any;

  constructor(container: HTMLElement, app: App, config: Partial<TimeblockConfig>) {
    this.host = container;
    this.app = app;
    this.cfg = config || {};
    this.colors = this.cfg.colors || {};
    this.fallback = this.cfg.fallbackColor || "#9aa0a8";
    this.opacity = this.cfg.blockOpacity != null ? this.cfg.blockOpacity : 0.22;
    this.dataRoot = this.cfg.dataRoot || ".lifelog/daily";
    this.minH = this.cfg.minHourPx || 22;
    this.maxH = this.cfg.maxHourPx || 120;
    this.zoomStep = this.cfg.zoomStep || 8;
    this.autoFitRatio = this.cfg.autoFitRatio || 0.052;
    this.mergeGap = this.cfg.mergeGapMin != null ? this.cfg.mergeGapMin : 2;

    let savedH = NaN,
      savedAf: string | null = null;
    try {
      savedH = Number(localStorage.getItem("tb-hourPx"));
      savedAf = localStorage.getItem("tb-autofit");
    } catch (e) {}
    this.state = {
      view: "week",
      anchor: new Date(),
      hourPx: savedH >= this.minH && savedH <= this.maxH ? savedH : this.cfg.hourPx || 46,
      autoFit: savedAf == null ? this.cfg.autoFit !== false : savedAf === "1",
      hidden: new Set<string>(),
    };
    this.dayCache = new Map();
    this.normCache = new Map();
    this._nowTimer = null;
    this._restoreScrollTop = null;
    this._scrollToNow = false;
    this.scrollEl = this.gridEl = this.axisEl = this.zoomSlider = this.zoomLabel = this.autoBtn = null;
    this.cols = null;
    this.viewDays = null;
    this.viewNorms = null;
  }

  colorOf(c: string) {
    return this.colors[c] || this.fallback;
  }
  persistH() {
    try {
      localStorage.setItem("tb-hourPx", String(this.state.hourPx));
    } catch (e) {}
  }
  persistAf() {
    try {
      localStorage.setItem("tb-autofit", this.state.autoFit ? "1" : "0");
    } catch (e) {}
  }
  rangeKey(d: Date) {
    return this.state.view === "day" ? ymd(d) : ymd(getMonday(d));
  }

  async loadDay(dateStr: string): Promise<any> {
    if (this.dayCache.has(dateStr)) return this.dayCache.get(dateStr);
    const y = dateStr.slice(0, 4),
      ym = dateStr.slice(0, 7);
    const cands: [string, string][] = [
      ["override", `${this.dataRoot}/overrides/${ym}/${dateStr}.json`],
      ["daily", `${this.dataRoot}/${y}/${ym}/${dateStr}.json`],
    ];
    let out: any = null;
    for (const [src, p] of cands) {
      try {
        const j = JSON.parse(await (this.app.vault.adapter as any).read(p));
        if (!Array.isArray(j.blocks)) j.blocks = j.blocks || [];
        out = { date: dateStr, src, blocks: j.blocks, presence: j.presence || [], events: j.events || [], full: j };
        break;
      } catch (e) {
        /* not found, try next */
      }
    }
    this.dayCache.set(dateStr, out);
    return out;
  }

  normalize(day: any, dateStr: string, next: any, nextStr: string) {
    const isToday = dateStr === ymd(new Date());
    const fg: any[] = [],
      bg: any[] = [];
    ((day && day.blocks) || []).forEach((b: any, index: number) => {
      if (this.state.hidden.has(b.category)) return;
      const s = parseClock(b.start);
      let e = b.end == null ? null : parseClock(b.end);
      if (s == null) return;
      const open = e == null;
      if (open) e = isToday ? Math.max(s + 5, nowMin()) : 1440;
      const ds = Math.max(0, s);
      let de = Math.min(1440, e as number);
      if (de - ds < 1) {
        if (de <= 0 || ds >= 1440) return;
        de = ds + 1;
      }
      const g = Object.assign({}, b, { s: ds, e: de, open, _idx: index, _date: dateStr });
      (b.background ? bg : fg).push(g);
    });
    ((next && next.blocks) || []).forEach((b: any, index: number) => {
      if (b.background || this.state.hidden.has(b.category)) return;
      const sRaw = parseClock(b.start);
      if (sRaw == null || sRaw >= 0) return;
      const ds = sRaw + 1440;
      const eRaw = b.end == null ? null : parseClock(b.end);
      const de = Math.min(1440, eRaw == null ? 1440 : eRaw + 1440);
      if (ds >= 1440 || de - ds < 1) return;
      fg.push(Object.assign({}, b, { s: ds, e: de, open: false, _idx: index, _date: nextStr, _carry: true, _carryNextEnd: b.end }));
    });
    const units = mergeAdjacent(fg, this.mergeGap);
    packColumns(units);
    return { units, bg, presence: (day && day.presence) || [], events: (day && day.events) || [], src: day && day.src };
  }

  async loadNorm(dateStr: string): Promise<any> {
    const isToday = dateStr === ymd(new Date());
    if (!isToday && this.normCache.has(dateStr)) return this.normCache.get(dateStr);
    const nextStr = ymd(addDays(parseYmd(dateStr), 1));
    const norm = this.normalize(await this.loadDay(dateStr), dateStr, await this.loadDay(nextStr), nextStr);
    if (!isToday) this.normCache.set(dateStr, norm);
    return norm;
  }

  daysInView(): Date[] {
    if (this.state.view === "day") return [new Date(this.state.anchor)];
    const mon = getMonday(this.state.anchor);
    return Array.from({ length: 7 }, (_, i) => addDays(mon, i));
  }

  resolveAttachment(name: string): string | null {
    try {
      const f = this.app.metadataCache.getFirstLinkpathDest(name, "");
      if (f) return this.app.vault.getResourcePath(f);
    } catch (e) {}
    return null;
  }

  openModal(b: any) {
    const overlay = el("div", { class: "tb-overlay", onclick: (e: any) => { if (e.target === overlay) overlay.remove(); } });
    const dur = b.e - b.s;
    const durStr = b.e === b.s ? "瞬间" : `${Math.floor(dur / 60)}h${pad(Math.round(dur % 60))}m`;
    const color = this.colorOf(b.category);
    const modal = el(
      "div",
      { class: "tb-modal" },
      el("h3", { style: { color: isDarkTheme() ? tint(color, 0.5) : shade(color, 0.6) } }, b.label || "(无标题)"),
      el("div", { class: "meta" }, `${b.category || ""}${b.proj ? " · " + b.proj : ""} · ${durStr}` + (b.open ? " · 开放块" : "") + (b.inferred ? " · 推断" : "") + (b.confidence === "low" ? " · 低置信" : "")),
      b.detail ? el("div", { style: { marginBottom: "6px" } }, b.detail) : null,
      b.note ? el("div", { class: "note" }, b.note) : null,
    );
    for (const name of b.attachments || []) {
      const url = this.resolveAttachment(name);
      modal.append(url ? el("img", { src: url, alt: name, loading: "lazy", onclick: () => window.open(url) }) : el("div", { class: "miss" }, "🖼 未找到附件: " + name));
    }
    const footer = el("div", { style: { textAlign: "right", marginTop: "10px" } });
    const esc = (e: any) => { if (e.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", esc); } };
    if (b._idx != null && b._date) footer.append(el("button", { style: { marginRight: "8px" }, onclick: () => { overlay.remove(); document.removeEventListener("keydown", esc); this.openEditor(b, false); } }, "✎ 编辑"));
    footer.append(el("button", { onclick: () => overlay.remove() }, "关闭"));
    modal.append(footer);
    overlay.append(modal);
    document.body.append(overlay);
    document.addEventListener("keydown", esc);
  }

  openEditor(b: any, isNew: boolean) {
    const overlay = el("div", { class: "tb-overlay", onclick: (e: any) => { if (e.target === overlay) overlay.remove(); } });
    const FS = { width: "100%", boxSizing: "border-box", padding: "5px 8px", border: "1px solid var(--background-modifier-border)", borderRadius: "6px", background: "var(--background-secondary)", color: "var(--text-normal)", font: "inherit" };
    const row = (label: string, ...controls: any[]) =>
      el("div", { style: { marginBottom: "8px" } }, el("div", { style: { fontSize: "11px", opacity: ".6", marginBottom: "3px" } }, label), el("div", { style: { display: "flex", gap: "6px", alignItems: "center" } }, ...controls));
    const t0 = splitTime(isNew ? "" : b.start),
      t1 = splitTime(isNew ? "" : b.end);
    const offSel = (val: any) => el("select", { style: Object.assign({}, FS, { width: "auto", flex: "0 0 auto" }) }, ...[["-1", "前一天"], ["0", "当天"], ["1", "后一天"]].map(([v, t]) => el("option", { value: v, selected: String(val) === v ? "selected" : null }, t)));
    const fDate = el("input", { type: "date", style: Object.assign({}, FS, { width: "auto" }), value: isNew ? ymd(this.state.anchor) : b._date }) as HTMLInputElement;
    if (!isNew) fDate.disabled = true;
    const fLabel = el("input", { type: "text", style: FS, value: b.label || "", placeholder: "标题 label" }) as HTMLInputElement;
    const cats = Object.keys(this.colors);
    const fCat = el("select", { style: FS }, ...cats.map((c) => el("option", { value: c, selected: b.category === c ? "selected" : null }, c))) as HTMLSelectElement;
    if (b.category && !cats.includes(b.category)) fCat.prepend(el("option", { value: b.category, selected: "selected" }, b.category));
    const fProj = el("input", { type: "text", style: FS, value: b.proj || "", placeholder: "项目 proj(可空)" }) as HTMLInputElement;
    const fDetail = el("textarea", { style: Object.assign({}, FS, { minHeight: "48px", resize: "vertical" }), placeholder: "备注 detail" }, b.detail || "") as HTMLTextAreaElement;
    const fSOff = offSel(t0.off) as HTMLSelectElement,
      fST = el("input", { type: "text", style: FS, value: t0.hms, placeholder: "HH:MM:SS" }) as HTMLInputElement;
    const fEOff = offSel(t1.off) as HTMLSelectElement,
      fET = el("input", { type: "text", style: FS, value: t1.hms, placeholder: "HH:MM:SS · 空=进行中" }) as HTMLInputElement;
    const err = el("div", { style: { color: "#e84f6b", fontSize: "11px", minHeight: "14px", margin: "2px 0" } });
    const save = async () => {
      const start = joinTime(+fSOff.value, fST.value),
        end = joinTime(+fEOff.value, fET.value);
      if (start === null) { err.textContent = "开始时间不能为空"; return; }
      if (start === undefined || end === undefined) { err.textContent = "时间格式应为 HH:MM 或 HH:MM:SS"; return; }
      if (!fLabel.value.trim()) { err.textContent = "标题不能为空"; return; }
      const e = { start, end, label: fLabel.value.trim(), category: fCat.value, proj: fProj.value.trim(), detail: fDetail.value.trim() };
      try {
        isNew ? await this.addEntry(fDate.value, e) : await this.updateEntry(b._date, b._idx, e);
        overlay.remove();
      } catch (ex: any) {
        err.textContent = "保存失败: " + ((ex && ex.message) || ex);
      }
    };
    const del = async () => {
      if (!window.confirm(`删除时间块「${b.label || ""}」?`)) return;
      try {
        await this.deleteEntry(b._date, b._idx);
        overlay.remove();
      } catch (ex: any) {
        err.textContent = "删除失败: " + ((ex && ex.message) || ex);
      }
    };
    overlay.append(
      el(
        "div",
        { class: "tb-modal" },
        el("h3", {}, isNew ? "新增时间块" : "编辑时间块"),
        row("日期", fDate),
        row("标题 label", fLabel),
        row("分类 category", fCat),
        row("项目 proj", fProj),
        row("开始 start", fSOff, fST),
        row("结束 end", fEOff, fET),
        row("备注 detail", fDetail),
        err,
        el("div", { style: { display: "flex", justifyContent: "space-between", marginTop: "10px" } }, isNew ? el("span") : el("button", { style: { color: "#e84f6b" }, onclick: del }, "删除"), el("span", {}, el("button", { style: { marginRight: "8px" }, onclick: () => overlay.remove() }, "取消"), el("button", { onclick: save }, "保存"))),
      ),
    );
    document.body.append(overlay);
  }

  async fullForEdit(dateStr: string): Promise<any> {
    const dd = await this.loadDay(dateStr);
    if (dd && dd.full) return dd.full;
    return { date: dateStr, blocks: [], presence: [], events: [], daily_total: 0, daily_income: 0 };
  }
  async commitDay(dateStr: string, full: any) {
    const A: any = this.app.vault.adapter,
      ym = dateStr.slice(0, 7);
    for (const d of [`${this.dataRoot}/overrides`, `${this.dataRoot}/overrides/${ym}`]) {
      try {
        if (!(await A.exists(d))) await A.mkdir(d);
      } catch (e) {}
    }
    await A.write(`${this.dataRoot}/overrides/${ym}/${dateStr}.json`, JSON.stringify(full, null, 1));
    this.dayCache.delete(dateStr);
    this.normCache.delete(dateStr);
    this.normCache.delete(ymd(addDays(parseYmd(dateStr), -1)));
    if (this.scrollEl) this._restoreScrollTop = this.scrollEl.scrollTop;
    this.render();
  }
  async updateEntry(dateStr: string, idx: number, e: any) {
    const full = await this.fullForEdit(dateStr);
    full.blocks = full.blocks || [];
    full.blocks[idx] = Object.assign({}, full.blocks[idx] || {}, { start: e.start, end: e.end, label: e.label, category: e.category, proj: e.proj, detail: e.detail, open_end: e.end == null });
    await this.commitDay(dateStr, full);
  }
  async addEntry(dateStr: string, e: any) {
    const full = await this.fullForEdit(dateStr);
    full.blocks = full.blocks || [];
    full.blocks.push({ start: e.start, end: e.end, label: e.label, category: e.category, proj: e.proj, detail: e.detail, background: false, inferred: false, confidence: "high", open_end: e.end == null, note: "", attachments: [] });
    full.blocks.sort((a: any, b: any) => (parseClock(a.start) || 0) - (parseClock(b.start) || 0));
    await this.commitDay(dateStr, full);
  }
  async deleteEntry(dateStr: string, idx: number) {
    const full = await this.fullForEdit(dateStr);
    full.blocks = full.blocks || [];
    if (idx >= 0 && idx < full.blocks.length) full.blocks.splice(idx, 1);
    await this.commitDay(dateStr, full);
  }

  blockBaseStyle(top: number, h: number, u: any, color: string) {
    const left = u.leftPct || 0,
      w = u.widthPct != null ? u.widthPct : 100;
    return {
      top: top + "px",
      height: h + "px",
      left: `calc(${left}% + 8px)`,
      width: `calc(${w}% - 10px)`,
      background: hexToRgba(color, this.opacity),
      color: textColor(color),
      borderLeft: `3px solid ${color}`,
      boxShadow: `inset 0 0 0 1px ${hexToRgba(color, 0.32)}`,
      zIndex: String(u.layer || 0),
    };
  }

  fillColumn(col: any, dd: any, dateStr: string, isToday: boolean) {
    const HP = this.state.hourPx;
    clear(col);
    for (let h = 1; h < 24; h++) col.append(el("div", { class: "tb-hline", style: { top: h * HP + "px" } }));
    if (!dd) {
      col.append(el("div", { class: "tb-loading" }, "…"));
      return;
    }

    (dd.presence || []).forEach((p: any, pi: number) => {
      const s = parseClock(p.start),
        e = p.end == null ? 1440 : parseClock(p.end);
      if (s == null) return;
      const ds = Math.max(0, s),
        de = Math.min(1440, e as number);
      if (de <= ds) return;
      col.append(el("div", { class: "tb-pres", title: `${p.person || "陪伴"} ${p.start}~${p.end || "…"}`, style: { left: 2 + pi * 5 + "px", top: (ds / 60) * HP + "px", height: ((de - ds) / 60) * HP + "px", background: this.cfg.presenceColor || "#f0b54f" } }));
    });

    const laneKey = (u: any) => Math.round(u.leftPct || 0) + ":" + Math.round(u.widthPct != null ? u.widthPct : 100);
    const lanes: any = {};
    for (const u of dd.units) (lanes[laneKey(u)] = lanes[laneKey(u)] || []).push(u);
    for (const k in lanes) lanes[k].sort((a: any, b: any) => a.s - b.s);
    const nextTopOf = (u: any) => {
      const a = lanes[laneKey(u)],
        i = a.indexOf(u);
      return i < a.length - 1 ? (a[i + 1].s / 60) * HP : Infinity;
    };

    const fs = clampN(HP / 46, 0.85, 1.7);
    const labelFs = (11.5 * fs).toFixed(1) + "px";
    const detailFs = (10 * fs).toFixed(1) + "px";
    const glabelFs = (11 * fs).toFixed(1) + "px";
    const LH = Math.round(12 * fs + 4);
    const WRAP = { whiteSpace: "normal", overflowWrap: "anywhere", wordBreak: "break-word", textOverflow: "clip" };
    const crossTime = (startStr: any) => {
      const m = String(startStr || "").match(/前一天[^0-9]*(\d{1,2}:\d{2})/);
      return m ? m[1] : null;
    };
    const crossBadge = (startStr: any) => {
      const t = crossTime(startStr);
      return t ? el("div", { style: { fontSize: (9 * fs).toFixed(1) + "px", opacity: ".75", fontWeight: "600", lineHeight: "1.2" } }, "↥ 前一天 " + t) : null;
    };
    const carryMark = (b: any) =>
      b && b._carry ? el("div", { style: { fontSize: (9 * fs).toFixed(1) + "px", opacity: ".7", fontWeight: "600", lineHeight: "1.2" } }, "↧ 次日 " + (b._carryNextEnd ? splitTime(b._carryNextEnd).hms.slice(0, 5) : "进行中")) : null;
    const coverHit = (t: number, cov: any) => !!cov && cov.some(([cs, ce]: [number, number]) => t >= cs - 1e-6 && t < ce - 1e-6);

    for (const u of dd.units) {
      const top = (u.s / 60) * HP;
      const h = Math.max(2, Math.min(Math.max(14, ((u.e - u.s) / 60) * HP), nextTopOf(u) - top));
      const color = this.colorOf(u.category);
      if (u.kind === "single") {
        const uMax = coverHit(u.s, u._cover) ? "50%" : "100%";
        const node = el(
          "div",
          { class: "tb-block" + (u.inferred ? " inferred" : "") + (u.confidence === "low" ? " lowc" : ""), style: this.blockBaseStyle(top, h, u, color), title: `${u.label}　${u.detail || ""}`, onclick: (ev: any) => { ev.stopPropagation(); this.openModal(u); } },
          crossBadge(u.start),
          el("div", { class: "bl-t", style: Object.assign({ fontSize: labelFs, maxWidth: uMax }, WRAP) }, u.label),
          h >= LH + 10 && u.detail ? el("div", { class: "bl-d", style: Object.assign({ fontSize: detailFs, maxWidth: uMax }, WRAP) }, u.detail) : null,
          carryMark(u),
        );
        if ((u.attachments || []).length) node.append(el("span", { class: "clip" }, "📎"));
        col.append(node);
      } else {
        const ct = crossTime(u.start);
        const group = el("div", { class: "tb-group", style: this.blockBaseStyle(top, h, u, color) });
        const labelMax = coverHit(u.s, u._cover) ? "50%" : "100%";
        group.append(el("div", { class: "tb-glabel", style: { fontSize: glabelFs, top: "0px", height: LH + "px", lineHeight: LH + "px", background: hexToRgba(color, 0.32), maxWidth: labelMax, whiteSpace: "nowrap" } }, (ct ? "↥" + ct + " " : "") + u.label));
        const segs = u.segments,
          span = u.e - u.s,
          innerH = Math.max(0, h - LH);
        segs.forEach((seg: any, si: number) => {
          const fracS = span > 0 ? (seg.s - u.s) / span : 0;
          const fracE = span > 0 ? ((si < segs.length - 1 ? segs[si + 1].s : u.e) - u.s) / span : 1;
          const st = LH + fracS * innerH;
          const sh = Math.max(1, (fracE - fracS) * innerH);
          const segMax = coverHit(seg.s, u._cover) ? "50%" : "100%";
          const segEl = el(
            "div",
            { class: "tb-seg" + (seg.inferred ? " inferred" : "") + (seg.confidence === "low" ? " lowc" : ""), style: { top: st + "px", height: sh + "px", maxWidth: segMax, borderTop: si > 0 ? `1px solid ${hexToRgba(color, 0.5)}` : "none" }, title: `${seg.label}　${seg.detail || ""}`, onclick: (ev: any) => { ev.stopPropagation(); this.openModal(seg); } },
            seg.detail && sh >= 11 ? el("div", { class: "bl-d", style: Object.assign({ fontSize: detailFs }, WRAP) }, seg.detail) : null,
            sh >= 22 ? carryMark(seg) : null,
          );
          if ((seg.attachments || []).length) segEl.append(el("span", { class: "clip" }, "📎"));
          group.append(segEl);
        });
        col.append(group);
      }
    }

    dd.bg.forEach((b: any, bi: number) => {
      const top = (b.s / 60) * HP,
        h = Math.max(8, ((b.e - b.s) / 60) * HP),
        color = this.colorOf(b.category);
      col.append(el("div", { class: "tb-bg", title: `${b.label} (后台)`, style: { top: top + "px", height: h + "px", right: 1 + bi * 8 + "px", background: hexToRgba(color, 0.55) }, onclick: (ev: any) => { ev.stopPropagation(); this.openModal(b); } }));
    });

    (dd.events || []).forEach((evt: any) => {
      if (this.state.hidden.has(evt.category)) return;
      const m = parseClock(evt.time);
      if (m == null) return;
      col.append(el("div", { class: "tb-evt", title: `${evt.label || ""} @${evt.time}`, style: { top: (m / 60) * HP + "px", background: this.colorOf(evt.category) }, onclick: (e2: any) => { e2.stopPropagation(); this.openModal({ label: evt.label, category: evt.category, detail: "", note: evt.note, s: m, e: m, attachments: [] }); } }));
    });

    if (isToday) {
      const line = el("div", { class: "tb-now", style: { top: (nowMin() / 60) * HP + "px" } });
      col.append(line);
      const t = setInterval(() => {
        if (!line.isConnected) { clearInterval(t); return; }
        line.style.top = (nowMin() / 60) * this.state.hourPx + "px";
      }, 60000);
      this._nowTimer = t;
    }
  }

  buildAxis(HP: number) {
    clear(this.axisEl);
    for (let h = 0; h <= 24; h++) this.axisEl.append(el("div", { class: "hr", style: { top: h * HP + "px" } }, h === 24 ? "" : pad(h) + ":00"));
  }

  rescale(px: number) {
    px = clampN(Math.round(px), this.minH, this.maxH);
    if (!this.scrollEl || !this.cols) {
      this.state.hourPx = px;
      return;
    }
    const cur = this.state.hourPx;
    const vh = this.scrollEl.clientHeight || 400;
    const center = ((this.scrollEl.scrollTop + vh / 2) / cur) * 60;
    this.state.hourPx = px;
    this.persistH();
    this.gridEl.style.height = px * 24 + "px";
    this.buildAxis(px);
    const todayStr = ymd(new Date());
    this.viewDays.forEach((d: Date, i: number) => {
      const ds = ymd(d);
      this.fillColumn(this.cols[i], this.viewNorms[i] || null, ds, ds === todayStr);
    });
    this.scrollEl.scrollTop = Math.max(0, (center / 60) * px - vh / 2);
    if (this.zoomSlider) this.zoomSlider.value = px;
    if (this.zoomLabel) this.zoomLabel.textContent = px + "px";
  }

  zoomManual(px: number) {
    this._manualLock = true;
    if (this.state.autoFit) {
      this.state.autoFit = false;
      this.persistAf();
      this.updateAutoBtn();
    }
    this.rescale(px);
  }
  toggleAuto() {
    this.state.autoFit = !this.state.autoFit;
    this.persistAf();
    this.updateAutoBtn();
    if (this.state.autoFit) {
      this._manualLock = false;
      this.applyAutoFit();
    }
  }
  updateAutoBtn() {
    if (!this.autoBtn) return;
    const on = this.state.autoFit;
    this.autoBtn.style.background = on ? "var(--interactive-accent)" : "var(--background-secondary)";
    this.autoBtn.style.color = on ? "#fff" : "var(--text-normal)";
  }
  applyAutoFit() {
    if (!this.state.autoFit || this._manualLock) return;
    const w = this.host.clientWidth || (this.scrollEl && this.scrollEl.clientWidth) || 800;
    const target = clampN(Math.round(w * this.autoFitRatio), this.minH, this.maxH);
    if (target !== this.state.hourPx) this.rescale(target);
    else {
      if (this.zoomSlider) this.zoomSlider.value = this.state.hourPx;
      if (this.zoomLabel) this.zoomLabel.textContent = this.state.hourPx + "px";
    }
  }

  scrollToNow(smooth: boolean) {
    const vh = this.scrollEl.clientHeight || 400;
    const top = Math.max(0, (nowMin() / 60) * this.state.hourPx - vh / 2);
    if (smooth && this.scrollEl.scrollTo) this.scrollEl.scrollTo({ top, behavior: "smooth" });
    else this.scrollEl.scrollTop = top;
  }

  navTo(anchor: Date, opts?: any) {
    opts = opts || {};
    if (this.scrollEl) this._restoreScrollTop = this.scrollEl.scrollTop;
    if (opts.scrollToNow) {
      this._restoreScrollTop = null;
      this._scrollToNow = true;
    }
    this.state.anchor = anchor;
    this.render();
  }

  render() {
    if (this._nowTimer) {
      clearInterval(this._nowTimer);
      this._nowTimer = null;
    }
    const host = this.host;
    clear(host);
    host.classList.add("tb-cal");
    this.injectStyle();

    const HP = this.state.hourPx,
      DAY = HP * 24;
    const days = this.daysInView();
    const todayStr = ymd(new Date());
    const step = this.state.view === "day" ? 1 : 7;

    const rangeLabel =
      this.state.view === "day"
        ? `${ymd(this.state.anchor)} 周${WD[(this.state.anchor.getDay() + 6) % 7]}`
        : (() => {
            const m = getMonday(this.state.anchor);
            return `${ymd(m)} ~ ${ymd(addDays(m, 6))}`;
          })();
    const isDay = this.state.view === "day";
    const BTN: any = { display: "inline-block", verticalAlign: "middle", padding: "3px 10px", border: "1px solid var(--background-modifier-border)", background: "var(--background-secondary)", color: "var(--text-normal)", cursor: "pointer", whiteSpace: "nowrap", boxSizing: "border-box", position: "static", float: "none", font: "inherit", lineHeight: "1.4" };
    const seg = (items: any[]) =>
      items.map((it, i) => {
        const r = items.length === 1 ? "6px" : i === 0 ? "6px 0 0 6px" : i === items.length - 1 ? "0 6px 6px 0" : "0";
        const st = Object.assign({}, BTN, { borderRadius: r, marginLeft: i > 0 ? "-1px" : "0" });
        if (it.on) Object.assign(st, { background: "var(--interactive-accent)", color: "#fff", position: "relative", zIndex: "1" });
        return el("button", { style: st, onclick: it.fn }, it.label);
      });
    const solo = (label: string, fn: any, extra?: any) => el("button", { style: Object.assign({}, BTN, { borderRadius: "6px" }, extra), onclick: fn }, label);
    this.zoomSlider = el("input", { type: "range", min: this.minH, max: this.maxH, value: HP, style: { display: "inline-block", width: "108px", verticalAlign: "middle", position: "static", float: "none" }, oninput: (e: any) => this.zoomManual(+e.target.value) });
    this.zoomLabel = el("span", { style: { display: "inline-block", verticalAlign: "middle", fontSize: "11px", opacity: ".6", marginLeft: "6px", minWidth: "40px" } }, HP + "px");
    this.autoBtn = solo("Auto", () => this.toggleAuto(), this.state.autoFit ? { background: "var(--interactive-accent)", color: "#fff" } : {});
    this.autoBtn.title = "随窗口宽度自动缩放";
    const COMP: any = { display: "inline-block", verticalAlign: "middle", marginRight: "18px" };
    const ROW: any = { margin: "5px 0", lineHeight: "2.2", whiteSpace: "normal", position: "static", float: "none" };
    host.append(
      el(
        "div",
        { style: ROW },
        el("span", { style: COMP }, ...seg([
          { label: "‹ " + (isDay ? "前一天" : "上周"), fn: () => this.navTo(addDays(this.state.anchor, -step)) },
          { label: isDay ? "今天" : "本周", fn: () => { const t = new Date(); if (this.rangeKey(t) === this.rangeKey(this.state.anchor)) this.scrollToNow(true); else this.navTo(t, { scrollToNow: true }); } },
          { label: (isDay ? "后一天" : "下周") + " ›", fn: () => this.navTo(addDays(this.state.anchor, step)) },
        ])),
        el("span", { style: { display: "inline-block", verticalAlign: "middle", fontWeight: "600", opacity: ".7" } }, rangeLabel),
      ),
    );
    host.append(
      el(
        "div",
        { style: Object.assign({}, ROW, { marginBottom: "10px" }) },
        el("span", { style: { display: "inline-block", verticalAlign: "middle", float: "right" } }, ...seg([
          { label: "日", on: isDay, fn: () => { if (this.scrollEl) this._restoreScrollTop = this.scrollEl.scrollTop; this.state.view = "day"; this.render(); } },
          { label: "周", on: !isDay, fn: () => { if (this.scrollEl) this._restoreScrollTop = this.scrollEl.scrollTop; this.state.view = "week"; this.render(); } },
        ])),
        el("span", { style: COMP, title: "拖动缩放(或 Ctrl/⌘+滚轮)" }, this.zoomSlider, this.zoomLabel),
        el("span", { style: COMP }, this.autoBtn),
        el("span", { style: COMP }, solo("＋ 新增块", () => this.openEditor({ label: "", category: Object.keys(this.colors)[0], proj: "", detail: "", start: "", end: "" }, true))),
        el("div", { style: { clear: "both", height: "0", overflow: "hidden" } }),
      ),
    );

    const headrow = el("div", { class: "tb-headrow" }, el("div", { class: "tb-gutter" }));
    days.forEach((d) => headrow.append(el("div", { class: "tb-dayhead" + (ymd(d) === todayStr ? " today" : ""), onclick: () => { if (this.scrollEl) this._restoreScrollTop = this.scrollEl.scrollTop; this.state.view = "day"; this.state.anchor = new Date(d); this.render(); } }, el("div", { class: "dow" }, "周" + WD[(d.getDay() + 6) % 7]), el("div", { class: "dnum" }, d.getDate()))));

    const scroll = el("div", { class: "tb-scroll", style: { maxHeight: (this.cfg.scrollMaxVh || 62) + "vh" } });
    const grid = el("div", { class: "tb-grid", style: { height: DAY + "px" } });
    const axis = el("div", { class: "tb-axis" });
    grid.append(axis);
    const cols = days.map(() => {
      const c = el("div", { class: "tb-col" });
      grid.append(c);
      return c;
    });
    scroll.append(grid);

    this.scrollEl = scroll;
    this.gridEl = grid;
    this.axisEl = axis;
    this.cols = cols;
    this.viewDays = days;
    this.viewNorms = new Array(days.length);
    this.buildAxis(HP);

    let tx = 0,
      ty = 0;
    scroll.addEventListener("touchstart", (e: any) => { tx = e.touches[0].clientX; ty = e.touches[0].clientY; }, { passive: true });
    scroll.addEventListener("touchend", (e: any) => {
      const dx = e.changedTouches[0].clientX - tx,
        dy = e.changedTouches[0].clientY - ty;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) this.navTo(addDays(this.state.anchor, dx < 0 ? step : -step));
    }, { passive: true });
    scroll.addEventListener("wheel", (e: any) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.zoomManual(this.state.hourPx + (e.deltaY < 0 ? this.zoomStep : -this.zoomStep));
      }
    }, { passive: false });

    host.append(headrow, scroll);

    const legend = el("div", { class: "tb-legend" });
    legend.append(el("span", { class: "tb-lg-hint" }, "类目筛选:"));
    for (const c in this.colors) {
      const off = this.state.hidden.has(c);
      legend.append(el("span", { class: "tb-lg" + (off ? " off" : ""), style: { "--c": this.colors[c] }, title: off ? `显示「${c}」` : `隐藏「${c}」`, onclick: () => { off ? this.state.hidden.delete(c) : this.state.hidden.add(c); this.normCache.clear(); if (this.scrollEl) this._restoreScrollTop = this.scrollEl.scrollTop; this.render(); } }, c));
    }
    if (this.state.hidden.size) legend.append(el("span", { class: "tb-lg-reset", onclick: () => { this.state.hidden.clear(); this.normCache.clear(); if (this.scrollEl) this._restoreScrollTop = this.scrollEl.scrollTop; this.render(); } }, "重置"));
    host.append(legend);
    const srcLine = el("div", { class: "tb-src" }, "加载中…");
    host.append(srcLine);

    const marks = new Array(days.length).fill("…");
    const mark = (dd: any) => (dd && dd.src ? (dd.src === "override" ? "✓" : "·") : "✕");
    const updateSrc = () => { srcLine.textContent = "来源: " + marks.join(" ") + "　(✓override ·raw ✕缺)"; };
    days.forEach((d, i) => {
      const ds = ymd(d),
        isToday = ds === todayStr;
      const cached = ds !== todayStr ? this.normCache.get(ds) : null;
      if (cached) {
        this.viewNorms[i] = cached;
        this.fillColumn(cols[i], cached, ds, isToday);
        marks[i] = mark(cached);
      } else {
        this.fillColumn(cols[i], null, ds, isToday);
        this.loadNorm(ds).then((dd) => {
          if (this.cols !== cols) return;
          this.viewNorms[i] = dd;
          this.fillColumn(cols[i], dd, ds, isToday);
          marks[i] = mark(dd);
          updateSrc();
        });
      }
    });
    updateSrc();

    requestAnimationFrame(() => {
      const vh = scroll.clientHeight || 400;
      let top;
      if (this._scrollToNow) {
        this._scrollToNow = false;
        top = (nowMin() / 60) * HP - vh / 2;
      } else if (this._restoreScrollTop != null) {
        top = this._restoreScrollTop;
        this._restoreScrollTop = null;
      } else top = days.some((d) => ymd(d) === todayStr) ? (nowMin() / 60) * HP - vh / 2 : 7 * HP;
      scroll.scrollTop = Math.max(0, top);
      this.applyAutoFit();
    });
  }

  setupAutoFit() {
    if (typeof ResizeObserver === "undefined") return;
    let raf: any = null;
    this._lastW = this.host.clientWidth;
    this._ro = new ResizeObserver(() => {
      const w = this.host.clientWidth;
      if (w === this._lastW) return;
      this._lastW = w;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => this.applyAutoFit());
    });
    this._ro.observe(this.host);
  }

  destroy() {
    if (this._nowTimer) clearInterval(this._nowTimer);
    if (this._ro) this._ro.disconnect();
  }

  injectStyle() {
    let style = document.getElementById("tb-cal-style");
    if (!style) {
      style = document.createElement("style");
      style.id = "tb-cal-style";
      document.head.append(style);
    }
    style.textContent = `
     .tb-cal { font-size:12px; }
     .tb-cal button { display:inline-block; width:auto; min-width:0; position:static; vertical-align:middle; box-sizing:border-box; float:none; background:var(--background-secondary); border:1px solid var(--background-modifier-border); padding:3px 9px; cursor:pointer; white-space:nowrap; }
     .tb-headrow { display:flex; border-bottom:1px solid var(--background-modifier-border); position:sticky; top:0; background:var(--background-primary); z-index:5; }
     .tb-gutter { width:42px; flex:0 0 42px; }
     .tb-dayhead { flex:1 1 0; text-align:center; padding:4px 2px; cursor:pointer; border-left:1px solid var(--background-modifier-border); min-width:0; }
     .tb-dayhead .dow { opacity:.6; font-size:11px; } .tb-dayhead .dnum { font-size:15px; font-weight:600; }
     .tb-dayhead.today .dnum { color:#fff; background:#e84f6b; border-radius:50%; width:22px; height:22px; line-height:22px; display:inline-block; }
     .tb-scroll { overflow-y:auto; overflow-x:hidden; position:relative; touch-action:pan-y; overscroll-behavior:contain; }
     .tb-grid { display:flex; position:relative; }
     .tb-axis { width:42px; flex:0 0 42px; position:relative; }
     .tb-axis .hr { position:absolute; right:4px; font-size:10px; opacity:.5; transform:translateY(-6px); }
     .tb-col { flex:1 1 0; position:relative; border-left:1px solid var(--background-modifier-border); min-width:0; }
     .tb-hline { position:absolute; left:0; right:0; border-top:1px solid var(--background-modifier-border); opacity:.35; }
     .tb-loading { position:absolute; top:38%; left:0; right:0; text-align:center; opacity:.4; }
     .tb-block { position:absolute; border-radius:5px; padding:1px 5px; overflow:hidden; cursor:pointer; box-sizing:border-box; }
     .tb-block .bl-t { font-weight:600; line-height:1.2; font-size:11.5px; white-space:normal; overflow-wrap:anywhere; word-break:break-word; }
     .bl-d { font-size:10px; opacity:.82; line-height:1.2; white-space:normal; overflow-wrap:anywhere; word-break:break-word; }
     .tb-block.inferred { border:1px dashed currentColor; }
     .tb-block.lowc, .tb-seg.lowc { opacity:.55; }
     .clip { position:absolute; right:3px; bottom:1px; font-size:10px; }
     .tb-group { position:absolute; border-radius:5px; overflow:hidden; box-sizing:border-box; }
     .tb-glabel { position:absolute; left:0; right:0; font-weight:700; padding:0 5px; pointer-events:none; z-index:2; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; box-sizing:border-box; border-radius:5px 5px 0 0; }
     .tb-seg { position:absolute; left:0; right:0; padding:1px 5px; box-sizing:border-box; cursor:pointer; overflow:hidden; }
     .tb-seg.inferred { border:1px dashed currentColor; }
     .tb-bg { position:absolute; width:6px; border-radius:3px; cursor:pointer; }
     .tb-pres { position:absolute; width:4px; border-radius:2px; opacity:.75; }
     .tb-evt { position:absolute; left:0; width:9px; height:9px; border-radius:50%; transform:translate(-3px,-4px); border:2px solid var(--background-primary); cursor:pointer; z-index:3; }
     .tb-now { position:absolute; left:0; right:0; border-top:2px solid #e84f6b; z-index:4; }
     .tb-now::before { content:""; position:absolute; left:-3px; top:-4px; width:7px; height:7px; border-radius:50%; background:#e84f6b; }
     .tb-legend { display:flex; flex-wrap:wrap; gap:5px 6px; margin-top:10px; align-items:center; }
     .tb-legend .tb-lg-hint { font-size:11px; opacity:.5; margin-right:2px; }
     .tb-legend .tb-lg { font-size:11px; padding:2px 9px; border-radius:11px; cursor:pointer; user-select:none; border:1px solid var(--background-modifier-border); display:inline-flex; align-items:center; line-height:1.4; }
     .tb-legend .tb-lg::before { content:""; width:8px; height:8px; border-radius:50%; margin-right:5px; background:var(--c); flex:0 0 auto; }
     .tb-legend .tb-lg.off { opacity:.4; text-decoration:line-through; }
     .tb-legend .tb-lg-reset { font-size:11px; padding:2px 8px; cursor:pointer; opacity:.7; text-decoration:underline; }
     .tb-src { opacity:.4; font-size:11px; margin-top:4px; }
     .tb-overlay { position:fixed; inset:0; background:rgba(0,0,0,.6); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px; }
     .tb-modal { background:var(--background-primary); border-radius:12px; max-width:520px; width:100%; max-height:86vh; overflow:auto; padding:16px 18px; }
     .tb-modal h3 { margin:0 0 4px; } .tb-modal .meta { opacity:.6; font-size:12px; margin-bottom:8px; }
     .tb-modal .note { font-size:12px; opacity:.7; white-space:pre-wrap; border-left:2px solid var(--background-modifier-border); padding-left:8px; }
     .tb-modal img { max-width:100%; border-radius:8px; margin-top:8px; cursor:zoom-in; }
     .tb-modal .miss { font-size:11px; opacity:.5; margin-top:6px; }
    `;
  }
}

export function mount(container: HTMLElement, opts: MountOpts): TimeBlockCalendar {
  const inst = new TimeBlockCalendar(container, opts.app, opts.config);
  inst.render();
  inst.setupAutoFit();
  return inst;
}
