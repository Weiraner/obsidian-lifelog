/**
 * stats.test.ts — pure aggregation for the time-stats dashboard.
 * Covers clock parsing (cross-day / open), background exclusion, both share
 * bases, per-day series, and subcategory drill-down.
 */
import { describe, expect, it } from "vitest";
import {
  aggregate,
  blockMinutes,
  dailySeries,
  parseClock,
  subBreakdown,
  type DayBlocks,
  type DurationCtx,
} from "../src/core/stats";

const CTX: DurationCtx = { nowMin: 12 * 60, todayDate: "2026-06-30" };

describe("parseClock", () => {
  it("parses HH:MM:SS to minutes from midnight", () => {
    expect(parseClock("08:45:00")).toBe(525);
    expect(parseClock("00:00:00")).toBe(0);
  });
  it("handles cross-day prefixes", () => {
    expect(parseClock("前一天 22:30:00")).toBe(22 * 60 + 30 - 1440);
    expect(parseClock("后一天 01:00:00")).toBe(60 + 1440);
  });
  it("returns null for junk", () => {
    expect(parseClock("")).toBeNull();
    expect(parseClock(null)).toBeNull();
    expect(parseClock("nope")).toBeNull();
  });
});

describe("blockMinutes", () => {
  it("computes a normal span", () => {
    expect(blockMinutes({ start: "08:00:00", end: "09:30:00", category: "x" }, "2026-06-29", CTX)).toBe(90);
  });
  it("open block on a past day fills to 24:00", () => {
    expect(blockMinutes({ start: "23:00:00", end: null, category: "x" }, "2026-06-29", CTX)).toBe(60);
  });
  it("open block today fills to now", () => {
    expect(blockMinutes({ start: "10:00:00", end: null, category: "x" }, "2026-06-30", CTX)).toBe(120);
  });
  it("counts the portion of a cross-day block", () => {
    expect(blockMinutes({ start: "前一天 23:00:00", end: "01:00:00", category: "x" }, "2026-06-29", CTX)).toBe(120);
  });
  it("treats inverted / zero spans as 0", () => {
    expect(blockMinutes({ start: "09:00:00", end: "08:00:00", category: "x" }, "2026-06-29", CTX)).toBe(0);
  });
});

const DAYS: DayBlocks[] = [
  {
    date: "2026-06-28",
    blocks: [
      { start: "00:00:00", end: "08:00:00", category: "睡眠" }, // 480
      { start: "08:00:00", end: "10:00:00", category: "学习工作", label: "刷题" }, // 120
      { start: "10:00:00", end: "11:00:00", category: "学习工作", label: "项目" }, // 60
      { start: "10:00:00", end: "12:00:00", category: "生活", background: true }, // 120, excluded
    ],
  },
  {
    date: "2026-06-29",
    blocks: [
      { start: "00:00:00", end: "06:00:00", category: "睡眠" }, // 360
      { start: "09:00:00", end: "12:00:00", category: "学习工作", label: "刷题" }, // 180
    ],
  },
];

describe("aggregate", () => {
  it("excludes background blocks and sums by category", () => {
    const r = aggregate(DAYS, 2, "tracked", CTX);
    const byCat = Object.fromEntries(r.byCategory.map((c) => [c.category, c.minutes]));
    expect(byCat["睡眠"]).toBe(840);
    expect(byCat["学习工作"]).toBe(360);
    expect(byCat["生活"]).toBeUndefined(); // background-only → dropped
    expect(r.trackedMinutes).toBe(1200);
  });

  it("tracked-base shares sum to 1", () => {
    const r = aggregate(DAYS, 2, "tracked", CTX);
    const total = r.byCategory.reduce((a, c) => a + c.share, 0);
    expect(total).toBeCloseTo(1, 5);
    expect(r.byCategory[0].category).toBe("睡眠"); // sorted desc
  });

  it("full-base divides by spanDays × 24h and exposes the untracked gap", () => {
    const r = aggregate(DAYS, 2, "full", CTX);
    expect(r.fullMinutes).toBe(2880);
    expect(r.untrackedMinutes).toBe(1680); // 2880 − 1200
    const sleep = r.byCategory.find((c) => c.category === "睡眠")!;
    expect(sleep.share).toBeCloseTo(840 / 2880, 5);
  });

  it("per-day average uses spanDays, not days-with-data", () => {
    const r = aggregate(DAYS.slice(0, 1), 7, "tracked", CTX); // one day of data, week span
    expect(r.perDayMinutes).toBeCloseTo(660 / 7, 5); // 480+120+60 counted, /7
  });
});

describe("open block capping (mid-day)", () => {
  // A sleep block left open at 01:50 with later activity must stop at the next
  // start (10:40), not swallow the day to 24:00.
  const day: DayBlocks[] = [
    {
      date: "2026-06-13",
      blocks: [
        { start: "01:50:00", end: null, category: "睡眠" },
        { start: "10:40:00", end: "12:00:00", category: "学习工作" },
      ],
    },
  ];
  it("caps the open block at the next recorded start", () => {
    const r = aggregate(day, 1, "tracked", CTX);
    const sleep = r.byCategory.find((c) => c.category === "睡眠")!;
    expect(sleep.minutes).toBe(530); // 10:40 − 01:50 = 8h50m, not to midnight
  });
  it("still fills a trailing open block to 24:00 on a past day", () => {
    const trailing: DayBlocks[] = [{ date: "2026-06-13", blocks: [{ start: "22:00:00", end: null, category: "睡眠" }] }];
    const r = aggregate(trailing, 1, "tracked", CTX);
    expect(r.trackedMinutes).toBe(120); // 22:00 → 24:00
  });
});

describe("dailySeries", () => {
  it("returns one stacked entry per day, sorted, background excluded", () => {
    const s = dailySeries(DAYS, CTX);
    expect(s.map((d) => d.date)).toEqual(["2026-06-28", "2026-06-29"]);
    expect(s[0].total).toBe(660); // 480+120+60, background 120 excluded
    expect(s[0].byCategory.get("学习工作")).toBe(180);
    expect(s[1].total).toBe(540);
  });
});

describe("subBreakdown", () => {
  it("breaks one category down by label, shares relative to that category", () => {
    const sub = subBreakdown(DAYS, "学习工作", CTX);
    const byLabel = Object.fromEntries(sub.map((s) => [s.category, s.minutes]));
    expect(byLabel["刷题"]).toBe(300); // 120 + 180
    expect(byLabel["项目"]).toBe(60);
    const total = sub.reduce((a, s) => a + s.share, 0);
    expect(total).toBeCloseTo(1, 5);
  });
  it("buckets unlabeled blocks under the empty label", () => {
    const days: DayBlocks[] = [{ date: "2026-06-28", blocks: [{ start: "08:00:00", end: "09:00:00", category: "事务" }] }];
    const sub = subBreakdown(days, "事务", CTX);
    expect(sub[0].category).toBe("(未细分)");
    expect(sub[0].minutes).toBe(60);
  });
});
