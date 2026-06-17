/**
 * parser.ts — deterministic core of the log pipeline.
 *
 * Design (ported from the original Python `parse_log.py`):
 *   - The raw log is the single source of truth; everything here is reproducible.
 *   - The LLM only makes *semantic* judgements (entry type, activity split,
 *     classification). All time arithmetic happens here, in code.
 *   - The LLM references intervals by *entry index*, never by writing wall-clock
 *     times — this is what kills timestamp hallucination.
 *   - Pure functions only. No file IO, no network. Side effects live in src/io.
 */
import type {
  Block,
  DayResult,
  Entry,
  EventPoint,
  Expense,
  LlmOutput,
  ParseConfig,
  Presence,
  Taxonomy,
} from "./schema";

export class ValidationError extends Error {}

const DAY_SECONDS = 24 * 3600;

/* ------------------------------------------------------------------- regexes */

// Leading timestamp, after _normalizeLine strips obsidian prefixes.
const TS_RE = /^(\d{1,2}):(\d{2}):(\d{2})[:：]?(?:\s+([\s\S]*))?$/;
const PREFIX_RE = /^(?:>\s*|-\s+|\*\s+|\d+\.\s+)+/; // quote / list prefixes (stackable)
const CALLOUT_RE = /^\[!\w+\][+-]?\s*/; // callout head [!log]±
const WRAP_TS_RE = /^\*{1,2}(\d{1,2}:\d{2}:\d{2})\*{1,2}/; // *italic*/**bold** timestamp

const BOLD_RE = /\*\*(.+?)\*\*/;
const ATTACH_RE = /!\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g;
const MD_IMG_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g;
const BARE_IMG_RE = /^([\w\-./]+\.(?:png|jpe?g|gif|webp|heic))\s*$/gim;

const LITERAL_TIME_RE = /^\s*(\d{1,2}):(\d{2}):(\d{2})\s*$/;
const CROSSDAY_TIME_RE = /^\s*(前一天|后一天|第二天)\s+(\d{1,2}):(\d{2}):(\d{2})\s*$/;

/* ------------------------------------------------------------------- helpers */

export function hmsToSec(h: number, m: number, s: number): number {
  return h * 3600 + m * 60 + s;
}

export function secToHms(sec: number): string {
  if (sec >= DAY_SECONDS) return "24:00:00";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(sec / 3600))}:${p(Math.floor((sec % 3600) / 60))}:${p(sec % 60)}`;
}

function normalizeLine(raw: string): string {
  let line = raw.trim();
  line = line.replace(PREFIX_RE, "");
  line = line.replace(CALLOUT_RE, "");
  line = line.replace(WRAP_TS_RE, "$1");
  return line;
}

export function extractAttachments(text: string): string[] {
  const found: string[] = [];
  for (const re of [ATTACH_RE, MD_IMG_RE, BARE_IMG_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) found.push(m[1]);
  }
  const out: string[] = [];
  for (const f of found) if (!out.includes(f)) out.push(f);
  return out;
}

/* ------------------------------------------------------- step 1: read note */

/** If a log heading is configured, slice from it to the next same-level heading. */
export function extractLogText(noteText: string, heading: string | null | undefined): string {
  if (!heading) return noteText;
  const lines = noteText.split("\n");
  let found: { start: number; level: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const hm = /^(#+)\s+(.*)$/.exec(lines[i].trim());
    if (hm && hm[2].trim() === heading) {
      found = { start: i, level: hm[1].length };
      break;
    }
  }
  if (!found) return noteText; // caller logs the miss
  const out: string[] = [];
  for (const line of lines.slice(found.start + 1)) {
    const hm = /^(#+)\s/.exec(line);
    if (hm && hm[1].length <= found.level) break;
    out.push(line);
  }
  return out.join("\n");
}

/** Split the log into entries. Lines without a timestamp continue the previous. */
export function parseEntries(text: string): { entries: Entry[]; warnings: string[] } {
  const entries: Entry[] = [];
  const warnings: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const m = TS_RE.exec(normalizeLine(line));
    if (m) {
      const h = +m[1],
        mi = +m[2],
        s = +m[3];
      if (h > 23 || mi > 59 || s > 59) continue;
      const p = (n: number) => String(n).padStart(2, "0");
      entries.push({
        i: entries.length,
        t: `${p(h)}:${p(mi)}:${p(s)}`,
        sec: hmsToSec(h, mi, s),
        c: (m[4] || "").trim(),
      });
    } else if (entries.length) {
      entries[entries.length - 1].c += "\n" + normalizeLine(line);
    }
  }
  for (let i = 0; i + 1 < entries.length; i++) {
    if (entries[i + 1].sec < entries[i].sec) {
      warnings.push(`时间戳非递增 ${entries[i].t} -> ${entries[i + 1].t},区间计算可能异常`);
    }
  }
  return { entries, warnings };
}

/* ----------------------------------------------------- taxonomy accessors */

function specOf(tax: Taxonomy, cat: string): { hint: string; labels?: string[]; label_hints?: Record<string, string>; fallback_label?: string; proj?: boolean } | null {
  const v = tax[cat];
  if (v == null) return null;
  if (typeof v === "string") return { hint: v };
  return v;
}

/* --------------------------------------------- step 3: build & validate */

interface ResolvedPoint {
  sec: number | null;
  t: string | null;
  openEnd: boolean;
}

/** Resolve a block boundary (index | sentinel | literal | cross-day) into a point. */
function resolvePoint(ref: unknown, entries: Entry[], side: "start" | "end"): ResolvedPoint {
  if (ref === "day_start") {
    if (side !== "start") throw new ValidationError("day_start 只能出现在 start");
    return { sec: 0, t: "00:00:00", openEnd: false };
  }
  if (ref === "day_end") {
    if (side !== "end") throw new ValidationError("day_end 只能出现在 end");
    return { sec: null, t: null, openEnd: true };
  }
  if (typeof ref === "string") {
    let m = LITERAL_TIME_RE.exec(ref);
    if (m) {
      const h = +m[1],
        mi = +m[2],
        s = +m[3];
      if (h > 23 || mi > 59 || s > 59) throw new ValidationError(`字面时间不合法: ${ref}`);
      const p = (n: number) => String(n).padStart(2, "0");
      return { sec: hmsToSec(h, mi, s), t: `${p(h)}:${p(mi)}:${p(s)}`, openEnd: false };
    }
    m = CROSSDAY_TIME_RE.exec(ref);
    if (m) {
      const tag = m[1];
      const h = +m[2],
        mi = +m[3],
        s = +m[4];
      if (h > 23 || mi > 59 || s > 59) throw new ValidationError(`跨日时间不合法: ${ref}`);
      let sec = hmsToSec(h, mi, s);
      if (tag === "前一天") {
        if (side !== "start") throw new ValidationError("前一天 只能出现在 start");
        sec -= DAY_SECONDS;
      } else {
        if (side !== "end") throw new ValidationError(`${tag} 只能出现在 end`);
        sec += DAY_SECONDS;
      }
      return { sec, t: ref.trim(), openEnd: false };
    }
    throw new ValidationError(`非法时间字符串: ${ref}`);
  }
  if (typeof ref !== "number" || !Number.isInteger(ref) || ref < 0 || ref >= entries.length) {
    throw new ValidationError(`非法条目索引: ${String(ref)}`);
  }
  const e = entries[ref];
  return { sec: e.sec, t: e.t, openEnd: false };
}

function isCrossdayBlock(block: Pick<Block, "start" | "end">): boolean {
  for (const v of [block.start, block.end]) {
    if (typeof v === "string" && CROSSDAY_TIME_RE.test(v)) return true;
  }
  return false;
}

/** Total-order key mapping cross-day prefixes to ±DAY_SECONDS. */
function blockSortKey(block: { start: string | null }): number {
  const s = block.start || "";
  let m = CROSSDAY_TIME_RE.exec(s);
  if (m) {
    const base = hmsToSec(+m[2], +m[3], +m[4]);
    return base + (m[1] === "前一天" ? -DAY_SECONDS : DAY_SECONDS);
  }
  m = LITERAL_TIME_RE.exec(s);
  if (m) return hmsToSec(+m[1], +m[2], +m[3]);
  return 0;
}

/**
 * Validate the LLM output against the taxonomy and turn it into a DayResult.
 * Mirrors the Python `build_output`: vocab snapping, project normalization,
 * coverage-gap detection, and a pile of defensive warnings.
 */
export function buildOutput(date: string, entries: Entry[], llmOut: LlmOutput, cfg: ParseConfig): DayResult {
  const warnings: string[] = [];
  const timeCats = new Set(Object.keys(cfg.time_categories));
  const expCats = new Set(Object.keys(cfg.expense_categories));
  const fallback = cfg.fallback_category || "其他";

  if (!llmOut || !Array.isArray(llmOut.blocks)) {
    throw new ValidationError("LLM 输出缺少 blocks 字段");
  }

  // Vocab snap: label must come from a category's `labels`; fuzzy-absorb on
  // mutual containment ("洛克王国日常" -> "洛克王国"), else fall back.
  const checkVocab = (tax: Taxonomy, cat: string, name: string, kind: string): string => {
    const spec = specOf(tax, cat);
    const vocab = spec?.labels;
    if (!vocab || vocab.includes(name)) return name;
    const cands = vocab.filter((v) => v.includes(name) || name.includes(v));
    if (cands.length) return cands.reduce((a, b) => (b.length > a.length ? b : a));
    const fb = spec?.fallback_label || vocab[vocab.length - 1];
    warnings.push(`${kind} “${name}” 不在 “${cat}” 词表中 -> ${fb}`);
    return fb;
  };

  // Project registry (name + aliases -> canonical name; canonical -> label).
  const projMap = new Map<string, string>();
  const registered = new Set<string>();
  const projLabel = new Map<string, string>();
  for (const p of cfg.projects) {
    registered.add(p.name);
    projMap.set(p.name, p.name);
    projLabel.set(p.name, p.label || "");
    for (const a of p.aliases || []) projMap.set(a, p.name);
  }
  const wildProjs = new Set<string>();

  const blocks: Block[] = [];
  for (const b of llmOut.blocks) {
    const sp = resolvePoint(b.start, entries, "start");
    const ep = resolvePoint(b.end, entries, "end");
    if (ep.sec !== null && sp.sec !== null && ep.sec < sp.sec) {
      throw new ValidationError(`块区间倒置: ${sp.t} -> ${ep.t} (${b.label})`);
    }
    if (ep.sec !== null && sp.sec !== null && ep.sec === sp.sec) {
      warnings.push(`零长度块已丢弃: ${b.label} @ ${sp.t}`);
      continue;
    }
    let cat = b.category ?? fallback;
    if (!timeCats.has(cat)) {
      warnings.push(`未知时间类目 “${cat}” -> ${fallback} (${b.label})`);
      cat = fallback;
    }
    const rawLabel = String(b.label ?? "").trim().slice(0, 24) || "(未命名)";
    let label = checkVocab(cfg.time_categories, cat, rawLabel, "label");
    const spec = specOf(cfg.time_categories, cat);
    const vocab = spec?.labels;
    const projEnabled = !!spec?.proj;
    const rawProj = String(b.proj ?? "").trim().slice(0, 24);
    let proj = projMap.get(rawProj) ?? rawProj;
    if (!projEnabled) {
      proj = "";
    } else if (!proj) {
      proj = label; // silent fallback: label is the default project
    } else if (registered.has(proj)) {
      const regL = projLabel.get(proj);
      if (regL && regL !== label && vocab && vocab.includes(regL)) {
        warnings.push(`label “${label}” 与 proj “${proj}” 注册的 label “${regL}” 不一致,已按注册表修正`);
        label = regL;
      }
    }
    let note = "";
    let attachments: string[] = [];
    if (typeof b.src === "number" && b.src >= 0 && b.src < entries.length) {
      note = entries[b.src].c;
      attachments = extractAttachments(note);
    }
    blocks.push({
      start: sp.t as string,
      end: ep.t,
      label,
      category: cat,
      detail: String(b.detail ?? "").trim().slice(0, 80),
      proj,
      background: !!b.background,
      inferred: !!b.inferred,
      confidence: b.confidence ?? "high",
      open_end: ep.openEnd,
      note,
      attachments,
    });
  }
  for (const b of blocks) {
    if (b.proj && !registered.has(b.proj) && b.proj !== b.label) wildProjs.add(b.proj);
  }
  for (const w of [...wildProjs].sort()) {
    warnings.push(`未注册 proj “${w}”,建议加入 projects.json(或作为别名)后重刷`);
  }
  blocks.sort((a, b) => blockSortKey(a) - blockSortKey(b));

  const expenses: Expense[] = [];
  for (const x of llmOut.expenses || []) {
    const amt = Number(x.amount);
    if (!Number.isFinite(amt)) throw new ValidationError(`费用金额非法: ${JSON.stringify(x)}`);
    const amount = Math.round(amt * 100) / 100;
    let cat = x.category ?? fallback;
    if (!expCats.has(cat)) {
      warnings.push(`未知费用类目 “${cat}” -> ${fallback} (${x.item})`);
      cat = fallback;
    }
    const sub = checkVocab(cfg.expense_categories, cat, String(x.sub ?? "").trim(), "二级分类");
    let etype = x.type ?? "支出";
    if (etype !== "支出" && etype !== "收入") {
      warnings.push(`非法收支类型 “${etype}” -> 支出 (${x.item})`);
      etype = "支出";
    }
    const idx = x.entry;
    const t = typeof idx === "number" && idx >= 0 && idx < entries.length ? entries[idx].t : null;
    expenses.push({
      time: t,
      amount,
      item: String(x.item ?? "").trim(),
      category: cat,
      sub,
      type: etype as "支出" | "收入",
      channel: x.channel || null,
    });
  }
  expenses.sort((a, b) => (a.time || "").localeCompare(b.time || ""));

  const events: EventPoint[] = [];
  for (const ev of llmOut.events || []) {
    const idx = ev.entry;
    if (!(typeof idx === "number" && idx >= 0 && idx < entries.length)) {
      warnings.push(`事件条目索引非法,已丢弃: ${JSON.stringify(ev)}`);
      continue;
    }
    let cat = ev.category ?? fallback;
    if (!timeCats.has(cat)) {
      warnings.push(`未知事件类目 “${cat}” -> ${fallback} (${ev.label})`);
      cat = fallback;
    }
    events.push({
      time: entries[idx].t,
      label: String(ev.label ?? "").trim().slice(0, 24) || "(未命名)",
      category: cat,
      note: entries[idx].c,
    });
  }
  events.sort((a, b) => a.time.localeCompare(b.time));

  const presence: Presence[] = [];
  for (const sp of llmOut.presence || []) {
    const person = String(sp.person ?? "").trim();
    if (!person) {
      warnings.push(`presence 缺 person,已丢弃: ${JSON.stringify(sp)}`);
      continue;
    }
    let s: ResolvedPoint, e: ResolvedPoint;
    try {
      s = resolvePoint(sp.start, entries, "start");
      e = resolvePoint(sp.end, entries, "end");
    } catch (err) {
      warnings.push(`presence 区间非法,已丢弃 (${person}): ${(err as Error).message}`);
      continue;
    }
    if (e.sec !== null && s.sec !== null && e.sec <= s.sec) {
      warnings.push(`presence 区间倒置/零长,已丢弃 (${person})`);
      continue;
    }
    const notes: { time: string; text: string }[] = [];
    for (const n of sp.notes || []) {
      const idx = n.entry;
      if (typeof idx === "number" && idx >= 0 && idx < entries.length) {
        notes.push({ time: entries[idx].t, text: String(n.text ?? "").trim().slice(0, 80) });
      }
    }
    notes.sort((a, b) => a.time.localeCompare(b.time));
    presence.push({ person, start: s.t as string, end: e.t, open_end: e.openEnd, notes });
  }
  presence.sort((a, b) => blockSortKey(a) - blockSortKey(b));

  // Expense sanity: a bold segment that produced no expense record.
  const expensed = new Set(expenses.map((x) => x.time));
  for (const e of entries) {
    if (BOLD_RE.test(e.c) && !expensed.has(e.t)) {
      warnings.push(`条目 ${e.t} 含 **粗体** 但未提取出费用,请检查`);
    }
  }

  // Coverage: foreground gaps > 30 min. Cross-day blocks excluded.
  if (entries.length) {
    const covered: [number, number][] = [];
    for (const b of blocks) {
      if (b.background || isCrossdayBlock(b)) continue;
      try {
        const [sh, sm, ss] = b.start.split(":").map(Number);
        const sSec = hmsToSec(sh, sm, ss);
        let eSec = DAY_SECONDS;
        if (b.end) {
          const [eh, em, es] = b.end.split(":").map(Number);
          eSec = hmsToSec(eh, em, es);
        }
        if ([sh, sm, ss].some((n) => Number.isNaN(n))) continue;
        covered.push([sSec, eSec]);
      } catch {
        continue;
      }
    }
    covered.sort((a, b) => a[0] - b[0]);
    let cursor = entries[0].sec;
    for (const [s, e] of covered) {
      if (s - cursor > 1800) warnings.push(`未覆盖空洞: ${secToHms(cursor)} ~ ${secToHms(s)}`);
      cursor = Math.max(cursor, e);
    }
  }

  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    date,
    blocks,
    presence,
    events,
    expenses,
    daily_total: r2(expenses.filter((x) => x.type === "支出").reduce((a, b) => a + b.amount, 0)),
    daily_income: r2(expenses.filter((x) => x.type === "收入").reduce((a, b) => a + b.amount, 0)),
    open_end: blocks.some((b) => b.open_end) || presence.some((p) => p.open_end),
    warnings,
  };
}

/* ------------------------------------------------- step 4: cross-day & merge */

function blockStartSec(block: { start: string | null }): number {
  return blockSortKey(block);
}

function blockEndSec(block: { end: string | null }): number {
  const e = block.end;
  if (typeof e !== "string") return DAY_SECONDS;
  const m = LITERAL_TIME_RE.exec(e);
  if (m) return hmsToSec(+m[1], +m[2], +m[3]);
  return DAY_SECONDS;
}

function timeSec(s: string | null | undefined): number | null {
  if (typeof s !== "string") return null;
  const m = LITERAL_TIME_RE.exec(s);
  if (!m) return null;
  return hmsToSec(+m[1], +m[2], +m[3]);
}

/**
 * Merge a fresh parse into the existing raw daily using the watermark as the
 * dividing line: keep existing pre-watermark items, take new post-watermark
 * items. Idempotent re-runs never destroy earlier work.
 */
export function mergeWithExisting(next: DayResult, existing: DayResult | null, watermarkTime: string | null): DayResult {
  if (!existing || !watermarkTime || watermarkTime === "00:00:00") return next;
  const wm = timeSec(watermarkTime) ?? 0;

  const splitBlocks = (blocks: { start: string | null; end: string | null }[]) => {
    const pre: any[] = [];
    const post: any[] = [];
    for (const b of blocks) {
      const endSec = blockEndSec(b);
      const startSec = blockStartSec(b);
      if (endSec <= wm) pre.push(b);
      else if (startSec >= wm) post.push(b);
      // straddling: drop (the new run produces a proper successor)
    }
    return { pre, post };
  };
  const splitTimed = (items: { time?: string | null }[]) => {
    const pre: any[] = [];
    const post: any[] = [];
    for (const x of items) {
      const t = timeSec(x.time);
      if (t === null) continue;
      (t <= wm ? pre : post).push(x);
    }
    return { pre, post };
  };

  const blocksPre = splitBlocks(existing.blocks).pre;
  const presencePre = splitBlocks(existing.presence).pre;
  const eventsPre = splitTimed(existing.events).pre;
  const expensesPre = splitTimed(existing.expenses).pre;

  const blocksPost = splitBlocks(next.blocks).post;
  const presencePost = splitBlocks(next.presence).post;
  const eventsPost = splitTimed(next.events).post;
  const expensesPost = splitTimed(next.expenses).post;

  const merged: DayResult = { ...next };
  merged.blocks = [...blocksPre, ...blocksPost].sort((a, b) => blockSortKey(a) - blockSortKey(b));
  merged.presence = [...presencePre, ...presencePost].sort((a, b) => blockSortKey(a) - blockSortKey(b));
  merged.events = [...eventsPre, ...eventsPost].sort((a, b) => a.time.localeCompare(b.time));
  merged.expenses = [...expensesPre, ...expensesPost].sort((a, b) => (a.time || "").localeCompare(b.time || ""));
  const r2 = (n: number) => Math.round(n * 100) / 100;
  merged.daily_total = r2(merged.expenses.filter((x) => (x.type || "支出") === "支出").reduce((a, b) => a + b.amount, 0));
  merged.daily_income = r2(merged.expenses.filter((x) => x.type === "收入").reduce((a, b) => a + b.amount, 0));
  merged.open_end = merged.blocks.some((b) => b.open_end) || merged.presence.some((p) => p.open_end);
  return merged;
}

/** Close yesterday's open blocks to 24:00:00 (cross-day split at midnight). */
export function closeOpenBlocks(prev: DayResult): { changed: boolean; result: DayResult } {
  let changed = false;
  const result: DayResult = { ...prev, blocks: prev.blocks.map((b) => ({ ...b })), presence: prev.presence.map((p) => ({ ...p })) };
  for (const b of [...result.blocks, ...result.presence]) {
    if ((b as Block).open_end || (b as Presence).open_end) {
      (b as Block).end = "24:00:00";
      (b as Block).open_end = false;
      changed = true;
    }
  }
  if (changed) result.open_end = false;
  return { changed, result };
}

/* -------------------------------------------------------------- step 5: notify */

function durationSec(start: string, end: string): number | null {
  try {
    const [sh, sm, ss] = start.split(":").map(Number);
    const [eh, em, es] = end.split(":").map(Number);
    if ([sh, sm, ss, eh, em, es].some((n) => Number.isNaN(n))) return null;
    return hmsToSec(eh, em, es) - hmsToSec(sh, sm, ss);
  } catch {
    return null;
  }
}

/** Human-readable one-day summary (used for notifications). */
export function summarize(out: DayResult): string {
  const byCat = new Map<string, number>();
  for (const b of out.blocks) {
    if (b.end === null) continue;
    const dur = durationSec(b.start, b.end);
    if (dur === null) continue;
    byCat.set(b.category, (byCat.get(b.category) || 0) + dur);
  }
  const top = [...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const fmtDur = (v: number) => `${Math.floor(v / 3600)}h${String(Math.floor((v % 3600) / 60)).padStart(2, "0")}m`;
  const topS = top.map(([k, v]) => `${k} ${fmtDur(v)}`).join(" / ");
  const pp = new Map<string, number>();
  for (const p of out.presence) {
    if (p.end === null) continue;
    const d = durationSec(p.start, p.end);
    if (d === null) continue;
    pp.set(p.person, (pp.get(p.person) || 0) + d);
  }
  const lines = [
    `📒 ${out.date}`,
    `💰 支出 ¥${out.daily_total} | 收入 ¥${out.daily_income || 0}(${out.expenses.length} 笔)`,
    `⏱ 时间 Top3: ${topS || "—"}`,
  ];
  if (pp.size) lines.push("👥 " + [...pp.entries()].map(([k, v]) => `${k} ${fmtDur(v)}`).join(" / "));
  if (out.warnings.length) lines.push("⚠️ " + out.warnings.slice(0, 4).join("; "));
  return lines.join("\n");
}
