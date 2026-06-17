/**
 * seed.ts — deterministic demo-data generator.
 *
 * Produces a few months of realistic daily JSON in `demo-vault/.lifelog/daily/`,
 * matching the exact shape the real pipeline emits — but WITHOUT calling an LLM.
 * That's the point: anyone can `git clone` → `npm run seed` → open the demo vault
 * and see both dashboards populated, with no API key and no private data.
 *
 * Deterministic: a fixed seed + the date string drive a small PRNG, so the same
 * command always produces byte-identical output (stable screenshots, stable CI).
 *
 * Usage:  npm run seed [days] [endDate]
 *   days     number of days to generate (default 75)
 *   endDate  last day, YYYY-MM-DD (default 2026-06-15)
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { DayResult } from "../src/core/schema";
import { secToHms } from "../src/core/parser";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO_ROOT = join(HERE, "..", "demo-vault", ".lifelog", "daily");

const GLOBAL_SEED = 1337;
const DAYS = Number(process.argv[2]) || 75;
const END_DATE = process.argv[3] || "2026-06-15";

/* ----------------------------------------------------------------- PRNG */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s: string): number {
  let h = GLOBAL_SEED >>> 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

/** A per-day RNG bundle: stable for a given date. */
function makeRng(dateStr: string) {
  const rand = mulberry32(hashStr(dateStr));
  return {
    rand,
    int: (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1)),
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)],
    chance: (p: number) => rand() < p,
    money: (lo: number, hi: number) => Math.round((lo + rand() * (hi - lo)) * 100) / 100,
  };
}

/* -------------------------------------------------------------- content pools */

// Foreground activity archetypes: [category, label, detailPool, weight, proj?]
interface Act {
  category: string;
  label: string;
  details: readonly string[];
  weight: number;
  proj?: string;
}
const ACTS: readonly Act[] = [
  { category: "学习工作", label: "项目", details: ["写后端接口", "调前端页面", "联调修bug", "部署与文档", "数据库设计"], weight: 7, proj: "二手书网站" },
  { category: "学习工作", label: "刷题", details: ["刷了几道dp", "二分与双指针", "周赛复盘"], weight: 5, proj: "算法刷题" },
  { category: "学习工作", label: "作业", details: ["写课程作业", "赶lab报告", "复习考点"], weight: 4 },
  { category: "学习工作", label: "上课", details: ["上专业课", "看网课", "自习补基础"], weight: 4 },
  { category: "学习工作", label: "找工", details: ["改简历投递", "刷面经", "准备面试"], weight: 2, proj: "实习投递" },
  { category: "网络娱乐", label: "刷视频", details: ["B站看技术分享", "刷短视频", "看剧集更新"], weight: 7 },
  { category: "网络娱乐", label: "打游戏", details: ["和室友联机", "打了几把", "单机推进度"], weight: 4 },
  { category: "网络娱乐", label: "看剧", details: ["追美剧", "看电影", "纪录片"], weight: 3 },
  { category: "网络娱乐", label: "听播客", details: ["通勤听播客", "技术播客"], weight: 1 },
  { category: "健康", label: "跑步", details: ["夜跑 5km", "操场慢跑", "河边跑步"], weight: 3 },
  { category: "健康", label: "健身", details: ["练腿", "上肢训练", "拉伸放松"], weight: 2 },
  { category: "生活", label: "吃饭", details: ["食堂吃饭", "点外卖", "和室友吃"], weight: 6 },
  { category: "生活", label: "做饭", details: ["自己煮面", "简单炒个菜"], weight: 2 },
  { category: "生活", label: "通勤", details: ["骑车去教学楼", "坐校车", "地铁出门"], weight: 2 },
  { category: "生活", label: "取快递", details: ["下楼拿快递", "取外卖"], weight: 2 },
  { category: "线下娱乐", label: "逛街", details: ["商场逛逛", "买点东西"], weight: 2 },
  { category: "线下娱乐", label: "咖啡店", details: ["咖啡店自习", "和朋友坐坐"], weight: 1 },
  { category: "购物", label: "数码", details: ["挑机械键盘", "看显示器"], weight: 1 },
  { category: "购物", label: "日用", details: ["补日用品", "囤点零食"], weight: 1 },
  { category: "社交", label: "聊天", details: ["和家里视频", "和朋友聊天"], weight: 2 },
  { category: "事务", label: "杂事", details: ["缴费报销", "预约事项"], weight: 1 },
];

const BACKGROUND_ACTS: readonly Act[] = [
  { category: "生活", label: "洗衣晾衣", details: ["扔进洗衣机"], weight: 1 },
  { category: "生活", label: "做饭", details: ["煮饭中"], weight: 1 },
];

// Expense archetypes: [category, sub, itemPool, channelPool, amountRange, income?]
interface ExpSpec {
  category: string;
  sub: string;
  items: readonly string[];
  channels: readonly (string | null)[];
  lo: number;
  hi: number;
  income?: boolean;
  weight: number;
}
const EXPENSES: readonly ExpSpec[] = [
  { category: "食物", sub: "午餐", items: ["黄焖鸡", "盖浇饭", "牛肉拉面", "麻辣烫"], channels: ["食堂", "美团"], lo: 10, hi: 30, weight: 8 },
  { category: "食物", sub: "晚餐", items: ["麻辣香锅", "炸鸡", "火锅外卖", "炒饭"], channels: ["食堂", "美团", "饿了么"], lo: 12, hi: 40, weight: 8 },
  { category: "食物", sub: "早餐", items: ["包子豆浆", "三明治", "煎饼"], channels: ["食堂", "便利店"], lo: 5, hi: 15, weight: 4 },
  { category: "食物", sub: "奶茶", items: ["奶茶", "美式", "拿铁"], channels: ["一点点", "瑞幸", null], lo: 9, hi: 25, weight: 4 },
  { category: "食物", sub: "零食", items: ["便利店零食", "水果"], channels: ["便利店", null], lo: 6, hi: 30, weight: 3 },
  { category: "交通", sub: "公交", items: ["地铁", "校车", "公交"], channels: [null], lo: 2, hi: 15, weight: 3 },
  { category: "交通", sub: "打车", items: ["打车回宿舍", "拼车"], channels: ["滴滴"], lo: 10, hi: 40, weight: 2 },
  { category: "日常", sub: "日用品", items: ["纸巾洗漱", "数据线", "收纳"], channels: ["淘宝", "拼多多"], lo: 10, hi: 80, weight: 3 },
  { category: "日常", sub: "衣物", items: ["T恤", "卫衣", "袜子"], channels: ["淘宝", null], lo: 40, hi: 200, weight: 2 },
  { category: "学习", sub: "书籍", items: ["专业教材", "技术书"], channels: ["网上书店", null], lo: 30, hi: 90, weight: 2 },
  { category: "娱乐", sub: "订阅", items: ["视频会员", "云服务器", "软件订阅"], channels: [null], lo: 12, hi: 60, weight: 2 },
  { category: "娱乐", sub: "电影", items: ["电影票"], channels: [null], lo: 30, hi: 60, weight: 1 },
  { category: "劳动", sub: "兼职", items: ["助教兼职工资", "家教"], channels: ["学校", null], lo: 100, hi: 400, income: true, weight: 1 },
  { category: "红包", sub: "家里", items: ["家里给的生活费", "红包"], channels: ["微信"], lo: 50, hi: 500, income: true, weight: 1 },
];

const FRIENDS = ["小林", "阿哲", "Mia"] as const;
const EVENTS = [
  { label: "收到快递", category: "生活" },
  { label: "面试约到了", category: "事务" },
  { label: "组会确认分工", category: "学习工作" },
] as const;

/* ----------------------------------------------------- weighted pick helper */

function weightedPick<T extends { weight: number }>(rng: ReturnType<typeof makeRng>, arr: readonly T[]): T {
  const total = arr.reduce((a, b) => a + b.weight, 0);
  let r = rng.rand() * total;
  for (const x of arr) {
    r -= x.weight;
    if (r <= 0) return x;
  }
  return arr[arr.length - 1];
}

/* ------------------------------------------------------------ day generator */

function genDay(dateStr: string): DayResult {
  const rng = makeRng(dateStr);
  const min = (m: number) => secToHms(m * 60);

  // Sleep until wake; awake until bedtime (occasionally rolls to midnight).
  const wake = rng.int(7 * 60, 11 * 60);
  const bedtime = rng.chance(0.2) ? 1440 : rng.int(23 * 60, 24 * 60 - 5);

  const blocks: DayResult["blocks"] = [
    { start: "00:00:00", end: min(wake), label: "睡觉", category: "睡眠", detail: rng.chance(0.3) ? "睡过头了" : "", proj: "", background: false, inferred: false, confidence: "high", open_end: false, note: "", attachments: [] },
  ];

  let cursor = wake;
  while (cursor < bedtime - 10) {
    const act = weightedPick(rng, ACTS);
    const dur = rng.pick([20, 30, 45, 60, 60, 90, 120]);
    const end = Math.min(cursor + dur, bedtime);
    const inferred = rng.chance(0.08);
    blocks.push({
      start: min(cursor),
      end: min(end),
      label: act.label,
      category: act.category,
      detail: rng.pick(act.details),
      proj: act.proj !== undefined ? act.proj : "",
      background: false,
      inferred,
      confidence: inferred ? "low" : rng.chance(0.85) ? "high" : "medium",
      open_end: false,
      note: "",
      attachments: [],
    });
    // occasional concurrent background task
    if (rng.chance(0.08)) {
      const bg = weightedPick(rng, BACKGROUND_ACTS);
      blocks.push({ start: min(cursor), end: min(Math.min(cursor + 15, end)), label: bg.label, category: bg.category, detail: bg.details[0], proj: "", background: true, inferred: true, confidence: "low", open_end: false, note: "", attachments: [] });
    }
    cursor = end;
  }

  // Expenses: 1–5 independent records spread across the awake window.
  const expenses: DayResult["expenses"] = [];
  const nExp = rng.int(1, 5);
  for (let i = 0; i < nExp; i++) {
    const spec = weightedPick(rng, EXPENSES);
    const t = min(rng.int(wake, Math.min(bedtime, 1439)));
    expenses.push({
      time: t,
      amount: rng.money(spec.lo, spec.hi),
      item: rng.pick(spec.items),
      category: spec.category,
      sub: spec.sub,
      type: spec.income ? "收入" : "支出",
      channel: rng.pick(spec.channels),
    });
  }
  expenses.sort((a, b) => (a.time || "").localeCompare(b.time || ""));

  // Optional event + presence.
  const events: DayResult["events"] = [];
  if (rng.chance(0.25)) {
    const ev = rng.pick(EVENTS);
    events.push({ time: min(rng.int(wake, Math.min(bedtime, 1439))), label: ev.label, category: ev.category, note: "" });
  }

  const presence: DayResult["presence"] = [];
  if (rng.chance(0.18)) {
    const s = rng.int(13 * 60, 18 * 60);
    const e = Math.min(s + rng.int(90, 240), bedtime);
    presence.push({ person: rng.pick(FRIENDS), start: min(s), end: min(e), open_end: false, notes: [] });
  }

  const r2 = (n: number) => Math.round(n * 100) / 100;
  const result: DayResult = {
    date: dateStr,
    generated_at: `${dateStr}T08:00:00`,
    blocks,
    presence,
    events,
    expenses,
    daily_total: r2(expenses.filter((x) => x.type === "支出").reduce((a, b) => a + b.amount, 0)),
    daily_income: r2(expenses.filter((x) => x.type === "收入").reduce((a, b) => a + b.amount, 0)),
    open_end: false,
    warnings: [],
  };
  // Validate against the same schema the real pipeline produces.
  return DayResult.parse(result);
}

/* ---------------------------------------------------------------------- main */

function datesEndingAt(endDate: string, n: number): string[] {
  const [y, m, d] = endDate.split("-").map(Number);
  const end = Date.UTC(y, m - 1, d);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date(end - i * 86400000);
    out.push(dt.toISOString().slice(0, 10));
  }
  return out;
}

function main(): void {
  const dates = datesEndingAt(END_DATE, DAYS);
  let totalExp = 0;
  for (const date of dates) {
    const day = genDay(date);
    totalExp += day.daily_total;
    const [yy, mm] = [date.slice(0, 4), date.slice(0, 7)];
    const dir = join(DEMO_ROOT, yy, mm);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${date}.json`), JSON.stringify(day, null, 1), "utf-8");
  }
  console.log(`✓ generated ${dates.length} days (${dates[0]} → ${dates[dates.length - 1]})`);
  console.log(`  → ${DEMO_ROOT}`);
  console.log(`  total demo spend: ¥${Math.round(totalExp)}  ·  seed=${GLOBAL_SEED} (reproducible)`);
}

main();
