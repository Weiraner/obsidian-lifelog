/**
 * pipeline.ts — the side-effecting glue that turns daily notes into structured
 * day JSON. The Obsidian counterpart of the original `parse_log.py`:
 *   read note → prev-day context → buildPrompt(watermark) → LLM (retry) →
 *   buildOutput → merge with existing → close yesterday → write.
 *
 * The pure engine (parser/prompt) and the LLM call (llm) are imported; this file
 * owns all IO, plus the three run modes that replace the Python entrypoints:
 *   - parseNote / parseDate : one day (the manual command, backfill unit)
 *   - incrementalParse      : watermark → today (replaces incremental_run)
 *   - backfill              : a date range / all days (replaces backfill.py)
 */
import { App, TFile, TFolder } from "obsidian";
import { Categories, Project, type DayResult, type ParseConfig } from "../core/schema";
import { buildOutput, closeOpenBlocks, extractLogText, mergeWithExisting, parseEntries } from "../core/parser";
import { buildPrompt } from "../core/prompt";
import { callLLM } from "./llm";
import { parseJsonLoose, type LlmSettings, type LlmUsage } from "./llm-core";

export interface PipelineSettings {
  dataRoot: string;
  /** Vault-relative root that holds the daily notes (e.g. "10 Journal"). */
  journalRoot: string;
  logHeading: string | null;
  fallbackCategory: string;
  llm: LlmSettings;
}

/** Incremental progress marker: the last entry timestamp already processed. */
export interface Watermark {
  date: string; // "YYYY-MM-DD"
  time: string; // "HH:MM:SS"
}

export interface ParseOptions {
  /** HH:MM:SS for THIS day; null / "00:00:00" = fresh full-day parse. */
  watermarkTime?: string | null;
  /** Override the date that would otherwise be inferred from the note. */
  date?: string;
}

export interface PipelineResult {
  date: string;
  out: DayResult;
  usage: LlmUsage;
  outPath: string;
  /** Largest entry timestamp seen in the note — used to advance the watermark. */
  latestEntryTime: string | null;
}

const pad = (n: number) => String(n).padStart(2, "0");

function parseYmd(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split("-").map(Number);
  return { y, m, d };
}
function shiftDate(date: string, n: number): string {
  const { y, m, d } = parseYmd(date);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}
function todayStr(): string {
  const n = new Date();
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
}

/* ----------------------------------------------------------------- path helpers */

/** Directory that holds categories.json / projects.json (dataRoot's parent-ish). */
function configDir(dataRoot: string): string {
  return dataRoot.endsWith("/daily") ? dataRoot.slice(0, -"/daily".length) : dataRoot;
}
function dayOutPath(settings: PipelineSettings, date: string): string {
  const [yy, ym] = [date.slice(0, 4), date.slice(0, 7)];
  return `${settings.dataRoot}/${yy}/${ym}/${date}.json`;
}
function overridePath(settings: PipelineSettings, date: string): string {
  return `${settings.dataRoot}/overrides/${date.slice(0, 7)}/${date}.json`;
}

async function ensureDir(app: App, path: string): Promise<void> {
  const A = app.vault.adapter;
  const parts = path.split("/");
  let cur = "";
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p;
    try {
      if (!(await A.exists(cur))) await A.mkdir(cur);
    } catch {
      /* race / already exists */
    }
  }
}

async function readDayJson(app: App, path: string): Promise<DayResult | null> {
  try {
    return JSON.parse(await app.vault.adapter.read(path)) as DayResult;
  } catch {
    return null; // missing or unparseable — treated as "no prior data"
  }
}

/* ------------------------------------------------------------- config + dates */

async function loadConfig(app: App, settings: PipelineSettings): Promise<ParseConfig> {
  const dir = configDir(settings.dataRoot);
  const A = app.vault.adapter;
  let cats: Categories;
  try {
    cats = Categories.parse(JSON.parse(await A.read(`${dir}/categories.json`)));
  } catch (e) {
    throw new Error(`读取/校验 ${dir}/categories.json 失败: ${(e as Error).message}`);
  }
  let projects: Project[] = [];
  try {
    const raw = JSON.parse(await A.read(`${dir}/projects.json`));
    projects = (Array.isArray(raw) ? raw : []).map((p) => Project.parse(p)).filter((p) => p.status === "active");
  } catch {
    // projects.json is optional
  }
  return {
    time_categories: cats.time_categories,
    expense_categories: cats.expense_categories,
    projects,
    fallback_category: settings.fallbackCategory,
  };
}

/** Best-effort date for a note: frontmatter → filename → path-year + MM-DD → today. */
function resolveDate(app: App, file: TFile): string {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
  const fmDate = fm?.date;
  if (typeof fmDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fmDate)) return fmDate;

  const full = file.basename.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (full) return `${full[1]}-${full[2]}-${full[3]}`;

  const md = file.basename.match(/(\d{1,2})-(\d{1,2})/);
  const yr = file.path.match(/(?:^|\/)(\d{4})(?:\/|-)/);
  if (md && yr) return `${yr[1]}-${pad(+md[1])}-${pad(+md[2])}`;

  return todayStr();
}

/**
 * Resolve a date to its daily-note file. Mirrors parse_log.py's note_path_for:
 * look in `<journalRoot>/YYYY/YYYY-MM/` for a markdown file whose name contains
 * the MM-DD token (tolerates 中文/英文 weekday drift), with a vault-wide glob as
 * the last resort.
 */
function findNoteForDate(app: App, settings: PipelineSettings, date: string): TFile | null {
  const { y, m, d } = parseYmd(date);
  const yyyy = String(y).padStart(4, "0");
  const mm = pad(m);
  const mmdd = `${mm}-${pad(d)}`;
  const dir = `${settings.journalRoot}/${yyyy}/${yyyy}-${mm}`;
  const folder = app.vault.getAbstractFileByPath(dir);
  if (folder instanceof TFolder) {
    const hit = folder.children.find((c) => c instanceof TFile && c.extension === "md" && c.name.includes(mmdd));
    if (hit instanceof TFile) return hit;
  }
  const glob = app.vault
    .getMarkdownFiles()
    .filter((f) => f.path.includes(`${yyyy}-${mm}`) && f.basename.includes(mmdd));
  return glob[0] ?? null;
}

/** All dates under journalRoot whose note name encodes a day. Sorted ascending. */
function allJournalDates(app: App, settings: PipelineSettings): string[] {
  const root = `${settings.journalRoot}/`;
  const dates = new Set<string>();
  for (const f of app.vault.getMarkdownFiles()) {
    if (!f.path.startsWith(root)) continue;
    if (!/\d{4}-\d{2}-\d{2}/.test(f.basename) && !/\d{1,2}-\d{1,2}/.test(f.basename)) continue;
    dates.add(resolveDate(app, f));
  }
  return [...dates].sort();
}

/**
 * Short summary of yesterday's tail so the model can decide whether today's
 * first entry continues across midnight. Port of load_prev_day_context.
 */
async function loadPrevDayContext(app: App, settings: PipelineSettings, date: string): Promise<string> {
  const prevDate = shiftDate(date, -1);
  const prev = await readDayJson(app, dayOutPath(settings, prevDate));
  if (!prev) return `(前一天 ${prevDate} 没有解析过, 无上下文)`;

  const literal = /^\d{1,2}:\d{2}:\d{2}$/;
  const sameDay = (prev.blocks || []).filter((b) => !b.open_end && typeof b.end === "string" && literal.test(b.end));
  const lastBlock = sameDay.length ? sameDay.reduce((a, b) => ((b.end as string) > (a.end as string) ? b : a)) : null;
  const openEnd = !!prev.open_end;

  const lines = [`前一天 = ${prevDate} (已解析)`];
  if (lastBlock) {
    lines.push(
      `前一天最后一个块: end=${lastBlock.end}, label=${JSON.stringify(lastBlock.label)}, ` +
        `category=${JSON.stringify(lastBlock.category)}, detail=${JSON.stringify(lastBlock.detail || "")}, open_end=${openEnd}`,
    );
  } else if (openEnd) {
    lines.push("前一天最后一个块标记为 open_end (没有明确结束时间)");
  } else {
    lines.push("前一天无可用的块尾信息");
  }
  lines.push(
    '判断: 如果今天的第一条 entry 是回顾型(「X完了/X了一会儿」),且时间戳与「前一天最后一个块的 end」' +
      '之间有间隙,这段间隙很可能就是今天第一条 entry 描述的活动 → 生成块时 start 用 "前一天 HH:MM:SS" ' +
      "指向前一天块 end 的时刻。",
  );
  return lines.join("\n");
}

/** Close yesterday's open blocks to 24:00:00 when today gets written. */
async function closePrevDay(app: App, settings: PipelineSettings, date: string): Promise<void> {
  const path = dayOutPath(settings, shiftDate(date, -1));
  const prev = await readDayJson(app, path);
  if (!prev) return;
  const { changed, result } = closeOpenBlocks(prev);
  if (changed) await app.vault.adapter.write(path, JSON.stringify(result, null, 1));
}

/* ----------------------------------------------------------------- core run */

/**
 * Parse one resolved (file, date) into raw daily JSON and write it. Handles the
 * full parse_log.py run() contract: prev-day context, watermark instruction,
 * 2-attempt retry with error feedback, merge-with-existing, close-previous-day,
 * override_present flag, and a usage-ledger line.
 */
async function runParse(app: App, file: TFile, date: string, settings: PipelineSettings, opts: ParseOptions): Promise<PipelineResult> {
  const content = await app.vault.read(file);
  const text = extractLogText(content, settings.logHeading);
  const { entries } = parseEntries(text);
  if (!entries.length) throw new Error(`${file.basename} 中没有可解析的时间戳条目`);

  const cfg = await loadConfig(app, settings);
  const watermarkTime = opts.watermarkTime ?? null;
  const prevDayContext = await loadPrevDayContext(app, settings, date);
  const basePrompt = buildPrompt(cfg, entries, { prevDayContext, watermarkTime });

  // Retry once, feeding the validation error back to the model (faithful to
  // parse_log.py's two-attempt loop).
  let out: DayResult | null = null;
  let usage: LlmUsage | null = null;
  let lastErr = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = attempt === 1 ? basePrompt : `${basePrompt}\n\n## 上次输出的问题(请修正后重新输出完整 JSON)\n${lastErr}`;
    try {
      const res = await callLLM(prompt, settings.llm);
      usage = res.usage;
      out = buildOutput(date, entries, parseJsonLoose(res.text), cfg);
      break;
    } catch (e) {
      lastErr = (e as Error).message;
      if (attempt === 2) throw e;
    }
  }
  if (!out || !usage) throw new Error("解析未产出结果"); // unreachable; satisfies the type narrower
  out.generated_at = new Date().toISOString();

  // Merge with on-disk raw daily so pre-watermark blocks survive an incremental run.
  const outPath = dayOutPath(settings, date);
  if (watermarkTime && watermarkTime !== "00:00:00") {
    const existing = await readDayJson(app, outPath);
    if (existing) out = mergeWithExisting(out, existing, watermarkTime);
  }

  // Flag (don't sync) the override file — the dashboard owns override creation/edits.
  out.override_present = await app.vault.adapter.exists(overridePath(settings, date));

  await closePrevDay(app, settings, date);
  await ensureDir(app, `${settings.dataRoot}/${date.slice(0, 4)}/${date.slice(0, 7)}`);
  await app.vault.adapter.write(outPath, JSON.stringify(out, null, 1));

  // One usage-ledger line per call (faithful to usage_log.jsonl). Aggregate w/ jq.
  const ledgerDir = configDir(settings.dataRoot);
  await ensureDir(app, ledgerDir);
  const ledgerLine =
    JSON.stringify({
      ts: new Date().toISOString(),
      date,
      provider: settings.llm.provider,
      model: usage.model,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
    }) + "\n";
  try {
    await app.vault.adapter.append(`${ledgerDir}/usage.jsonl`, ledgerLine);
  } catch (e) {
    console.warn("[lifelog] usage ledger append failed", e);
  }

  const latestEntryTime = entries.reduce<string | null>((a, e) => (a === null || e.t > a ? e.t : a), null);
  return { date, out, usage, outPath, latestEntryTime };
}

/* --------------------------------------------------------------- entrypoints */

/** Parse a specific note (the manual command). Date inferred from the note. */
export async function parseNote(app: App, file: TFile, settings: PipelineSettings, opts: ParseOptions = {}): Promise<PipelineResult> {
  return runParse(app, file, opts.date || resolveDate(app, file), settings, opts);
}

/** Parse the note belonging to a given date (resolves the file first). */
export async function parseDate(app: App, date: string, settings: PipelineSettings, opts: ParseOptions = {}): Promise<PipelineResult> {
  const file = findNoteForDate(app, settings, date);
  if (!file) throw new Error(`找不到 ${date} 的日记`);
  return runParse(app, file, date, settings, opts);
}

/**
 * Dates from the watermark day to today that have a daily note. Entry-level
 * filtering is unnecessary: runParse passes the watermark, so the model skips
 * pre-watermark entries and mergeWithExisting keeps existing blocks — reparsing
 * a fully-processed day is a no-op.
 */
function affectedDates(app: App, settings: PipelineSettings, sinceDate: string): string[] {
  const today = todayStr();
  const out: string[] = [];
  let cursor = sinceDate;
  while (cursor <= today) {
    if (findNoteForDate(app, settings, cursor)) out.push(cursor);
    cursor = shiftDate(cursor, 1);
  }
  return out;
}

export interface IncrementalResult {
  results: PipelineResult[];
  failures: { date: string; error: string }[];
  newWatermark: Watermark | null;
}

/**
 * Replace incremental_run: parse every affected day from `since` to today,
 * advancing the watermark to the latest entry processed. Idempotent — merge keeps
 * pre-watermark blocks, so re-running the same range is safe.
 */
export async function incrementalParse(app: App, settings: PipelineSettings, since: Watermark | null): Promise<IncrementalResult> {
  const sinceDate = since?.date ?? shiftDate(todayStr(), -1);
  const sinceTime = since?.time ?? "00:00:00";
  const dates = affectedDates(app, settings, sinceDate);

  const results: PipelineResult[] = [];
  const failures: { date: string; error: string }[] = [];
  let newWatermark = since;
  for (const d of dates) {
    const wm = d === sinceDate ? sinceTime : "00:00:00";
    try {
      const r = await parseDate(app, d, settings, { watermarkTime: wm });
      results.push(r);
      if (r.latestEntryTime) {
        const cand: Watermark = { date: d, time: r.latestEntryTime };
        if (!newWatermark || cand.date > newWatermark.date || (cand.date === newWatermark.date && cand.time > newWatermark.time)) {
          newWatermark = cand;
        }
      }
    } catch (e) {
      failures.push({ date: d, error: (e as Error).message });
    }
  }
  return { results, failures, newWatermark };
}

export interface BackfillResult {
  results: PipelineResult[];
  failures: { date: string; error: string }[];
  skipped: string[];
}

/**
 * Replace backfill.py: full re-parse of a date range (or all journal days).
 * `skipExisting` only parses days that have no raw daily yet. Always a fresh
 * full parse (watermark null) — raw log is the single source of truth.
 */
export async function backfill(app: App, settings: PipelineSettings, opts: { from?: string; to?: string; skipExisting?: boolean } = {}): Promise<BackfillResult> {
  let dates = allJournalDates(app, settings);
  if (opts.from) dates = dates.filter((d) => d >= opts.from!);
  if (opts.to) dates = dates.filter((d) => d <= opts.to!);

  const results: PipelineResult[] = [];
  const failures: { date: string; error: string }[] = [];
  const skipped: string[] = [];
  for (const d of dates) {
    if (opts.skipExisting && (await app.vault.adapter.exists(dayOutPath(settings, d)))) {
      skipped.push(d);
      continue;
    }
    try {
      results.push(await parseDate(app, d, settings, { watermarkTime: null }));
    } catch (e) {
      failures.push({ date: d, error: (e as Error).message });
    }
  }
  return { results, failures, skipped };
}
