/**
 * stats.ts — pure time-allocation aggregation for the stats dashboard.
 *
 * No DOM, no IO. Takes already-loaded day blocks and produces category totals,
 * percentages, a per-day stacked series, and per-category subcategory (label)
 * breakdowns — everything the stats view renders.
 *
 * Two decisions baked in here (confirmed in the feature discussion):
 *  - Background blocks (`background: true`, e.g. 洗衣机/烤箱) are excluded from
 *    totals: they're set-and-forget parallel work and would push a day past 24h.
 *  - Percentages support two denominators: "tracked" (sum of counted blocks, so
 *    shares always add to 100%) and "full" (calendar days × 24h, surfacing the
 *    untracked gap). The caller picks via `ShareBase`.
 *
 * Clock parsing mirrors timeblock-calendar's `parseClock` so cross-day blocks
 * ("前一天 HH:MM:SS") and open blocks resolve identically to the calendar.
 */

export const MINUTES_PER_DAY = 1440;

export interface StatsBlock {
  start: string;
  end: string | null;
  category: string;
  label?: string;
  background?: boolean;
}

/** One day's blocks, keyed by its file date (YYYY-MM-DD). */
export interface DayBlocks {
  date: string;
  blocks: StatsBlock[];
}

/** Context for resolving open (end=null) blocks against "now". */
export interface DurationCtx {
  /** Minutes-from-midnight "now", used for open blocks dated today. */
  nowMin: number;
  /** Today's date (YYYY-MM-DD); open blocks on other days fill to 24:00. */
  todayDate: string;
}

export type ShareBase = "tracked" | "full";

export interface CategoryStat {
  category: string;
  minutes: number;
  /** Fraction of the active denominator (0..1). */
  share: number;
}

export interface StatsResult {
  /** Per-category totals, sorted by minutes desc. */
  byCategory: CategoryStat[];
  /** Sum of all counted block minutes in range. */
  trackedMinutes: number;
  /** Calendar days in the selected range (not just days with data). */
  spanDays: number;
  /** spanDays × 24h. */
  fullMinutes: number;
  /** trackedMinutes / spanDays. */
  perDayMinutes: number;
  /** max(0, fullMinutes − trackedMinutes); the "未追踪" gap under the full base. */
  untrackedMinutes: number;
}

/**
 * "HH:MM:SS" / "前一天 HH:MM:SS" / "后一天 …" → minutes from midnight (may be
 * <0 or >1440). Returns null when unparseable. Lenient on H:MM and missing
 * seconds, matching the calendar's tolerance.
 */
export function parseClock(s: string | null | undefined): number | null {
  if (s == null) return null;
  let str = String(s).trim();
  let cross = 0;
  if (str.includes("前一天")) cross = -1;
  else if (str.includes("后一天")) cross = 1;
  str = str.replace(/前一天|后一天/g, "").trim();
  const m = str.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const min = +m[1] * 60 + +m[2] + (m[3] ? +m[3] / 60 : 0);
  return min + cross * MINUTES_PER_DAY;
}

/**
 * Duration of one isolated block in minutes (no same-day neighbors considered).
 * Open blocks (end=null) fill to "now" when the day is today, else to 24:00.
 * Unparseable or non-positive spans count as 0. Day-level aggregation uses
 * `dayDurations` instead, which also caps open blocks at the next activity.
 */
export function blockMinutes(b: StatsBlock, dayDate: string, ctx: DurationCtx): number {
  const s = parseClock(b.start);
  if (s == null) return 0;
  let e = b.end == null ? null : parseClock(b.end);
  if (e == null) e = dayDate === ctx.todayDate ? ctx.nowMin : MINUTES_PER_DAY;
  const dur = e - s;
  return dur > 0 ? dur : 0;
}

interface Counted {
  block: StatsBlock;
  minutes: number;
}

/**
 * Resolve every block in a day to its counted minutes. Unlike `blockMinutes`,
 * an open block (end=null) is capped at the *next recorded start* that day —
 * so a sleep block someone forgot to close stops at the next activity instead
 * of swallowing the whole day. With no later activity it fills to now (today) /
 * 24:00 (past), matching the calendar.
 */
function dayDurations(day: DayBlocks, ctx: DurationCtx): Counted[] {
  const dayEnd = day.date === ctx.todayDate ? ctx.nowMin : MINUTES_PER_DAY;
  const starts: number[] = [];
  for (const b of day.blocks) {
    const s = parseClock(b.start);
    if (s != null) starts.push(s);
  }
  return day.blocks.map((block) => {
    const s = parseClock(block.start);
    if (s == null) return { block, minutes: 0 };
    let e = block.end == null ? null : parseClock(block.end);
    if (e == null) {
      const later = starts.filter((x) => x > s);
      e = later.length ? Math.min(...later, dayEnd) : dayEnd;
    }
    const dur = e - s;
    return { block, minutes: dur > 0 ? dur : 0 };
  });
}

/** Should this block be counted toward stats? (drops background when excluded.) */
function counts(b: StatsBlock, excludeBackground: boolean): boolean {
  return !(excludeBackground && b.background);
}

/**
 * Aggregate counted blocks into per-category totals + summary stats.
 * `spanDays` is the number of calendar days the period covers (e.g. 7 for a
 * week), used for per-day averages and the "full" denominator — pass it from the
 * selected from/to range, not the count of days that happen to have data.
 */
export function aggregate(
  days: DayBlocks[],
  spanDays: number,
  base: ShareBase,
  ctx: DurationCtx,
  excludeBackground = true,
): StatsResult {
  const catMin = new Map<string, number>();
  let tracked = 0;
  for (const day of days) {
    for (const { block, minutes } of dayDurations(day, ctx)) {
      if (!counts(block, excludeBackground) || minutes <= 0) continue;
      const cat = block.category || "其他";
      catMin.set(cat, (catMin.get(cat) || 0) + minutes);
      tracked += minutes;
    }
  }
  const fullMinutes = Math.max(0, spanDays) * MINUTES_PER_DAY;
  const denom = base === "full" ? fullMinutes : tracked;
  const byCategory: CategoryStat[] = [...catMin.entries()]
    .map(([category, minutes]) => ({ category, minutes, share: denom > 0 ? minutes / denom : 0 }))
    .sort((a, b) => b.minutes - a.minutes);
  return {
    byCategory,
    trackedMinutes: tracked,
    spanDays,
    fullMinutes,
    perDayMinutes: spanDays > 0 ? tracked / spanDays : 0,
    untrackedMinutes: Math.max(0, fullMinutes - tracked),
  };
}

/** Per-day stacked series: one entry per day with data, sorted by date. */
export interface DayStack {
  date: string;
  total: number;
  byCategory: Map<string, number>;
}

export function dailySeries(days: DayBlocks[], ctx: DurationCtx, excludeBackground = true): DayStack[] {
  const out: DayStack[] = [];
  for (const day of [...days].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const byCategory = new Map<string, number>();
    let total = 0;
    for (const { block, minutes } of dayDurations(day, ctx)) {
      if (!counts(block, excludeBackground) || minutes <= 0) continue;
      const cat = block.category || "其他";
      byCategory.set(cat, (byCategory.get(cat) || 0) + minutes);
      total += minutes;
    }
    out.push({ date: day.date, total, byCategory });
  }
  return out;
}

/**
 * Drill-down: within one category, break counted minutes down by `label`
 * subcategory. Shares are relative to that category's own total. Blocks with no
 * label fall into `emptyLabel`.
 */
export function subBreakdown(
  days: DayBlocks[],
  category: string,
  ctx: DurationCtx,
  excludeBackground = true,
  emptyLabel = "(未细分)",
): CategoryStat[] {
  const sub = new Map<string, number>();
  let total = 0;
  for (const day of days) {
    for (const { block, minutes } of dayDurations(day, ctx)) {
      if ((block.category || "其他") !== category) continue;
      if (!counts(block, excludeBackground) || minutes <= 0) continue;
      const k = (block.label || "").trim() || emptyLabel;
      sub.set(k, (sub.get(k) || 0) + minutes);
      total += minutes;
    }
  }
  return [...sub.entries()]
    .map(([category, minutes]) => ({ category, minutes, share: total > 0 ? minutes / total : 0 }))
    .sort((a, b) => b.minutes - a.minutes);
}
