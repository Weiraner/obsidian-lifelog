/**
 * parse-journal.ts — offline batch-parse of the demo journal raw logs.
 *
 * Runs the REAL pipeline (same pure core as the plugin: parser + prompt +
 * provider switch) over demo-vault/journal/*.md, calling an LLM, and writes the
 * resulting day JSON into demo-vault/.lifelog/daily/. This is the genuine
 * raw-log → structured-data path, just driven from Node instead of Obsidian.
 *
 * The API key is read from the environment — never hard-code it:
 *   DEEPSEEK_KEY=sk-... npm run parse:journal
 *   (or LLM_PROVIDER=anthropic ANTHROPIC_KEY=sk-ant-... npm run parse:journal)
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Categories, Project, type DayResult, type ParseConfig } from "../src/core/schema";
import { buildOutput, extractLogText, parseEntries, ValidationError } from "../src/core/parser";
import { buildPrompt } from "../src/core/prompt";
import { buildRequest, parseJsonLoose, parseResponse, type LlmSettings } from "../src/io/llm-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VAULT = join(ROOT, "demo-vault");
const JOURNAL = join(VAULT, "journal");
const CFGDIR = join(VAULT, ".lifelog");
const OUTBASE = join(CFGDIR, "daily");

const provider = (process.env.LLM_PROVIDER || "deepseek") as LlmSettings["provider"];
const apiKey = process.env.DEEPSEEK_KEY || process.env.ANTHROPIC_KEY || process.env.LLM_KEY || "";
if (!apiKey) {
  console.error("✗ 未提供 API key,请用环境变量:DEEPSEEK_KEY=... npm run parse:journal");
  process.exit(1);
}
const llm: LlmSettings = { provider, apiKey, model: process.env.LLM_MODEL || "", baseUrl: process.env.LLM_BASE_URL || "" };

const cats = Categories.parse(JSON.parse(readFileSync(join(CFGDIR, "categories.json"), "utf8")));
const projects = (JSON.parse(readFileSync(join(CFGDIR, "projects.json"), "utf8")) as unknown[])
  .map((p) => Project.parse(p))
  .filter((p) => p.status === "active");
const cfg: ParseConfig = {
  time_categories: cats.time_categories,
  expense_categories: cats.expense_categories,
  projects,
  fallback_category: "其他",
};

/** Short summary of yesterday's tail so the model can resolve cross-midnight blocks. */
function prevDayContext(prev: DayResult | null): string {
  if (!prev) return "(无前一天上下文)";
  const sameDay = prev.blocks.filter((b) => !b.open_end && typeof b.end === "string" && /^\d{1,2}:\d{2}:\d{2}$/.test(b.end));
  const last = sameDay.length ? sameDay.reduce((a, b) => ((b.end as string) > (a.end as string) ? b : a)) : null;
  const lines = [`前一天 = ${prev.date} (已解析)`];
  if (last) lines.push(`前一天最后一个块: end=${last.end}, label=${JSON.stringify(last.label)}, category=${JSON.stringify(last.category)}, open_end=${prev.open_end}`);
  else lines.push("前一天无可用块尾信息");
  lines.push('判断: 若今天第一条 entry 是回顾型且与前一天块 end 之间有间隙,生成块时 start 用 "前一天 HH:MM:SS" 指向前一天块 end。');
  return lines.join("\n");
}

async function callLLM(prompt: string): Promise<string> {
  const req = buildRequest(prompt, llm);
  const res = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return parseResponse(provider, await res.json()).text;
}

async function main(): Promise<void> {
  const files = readdirSync(JOURNAL)
    .filter((f) => f.endsWith(".md") && /\d{4}-\d{2}-\d{2}/.test(f))
    .sort();
  console.log(`用 ${provider} 解析 ${files.length} 篇日志…\n`);

  let prev: DayResult | null = null;
  for (const f of files) {
    const date = f.match(/(\d{4}-\d{2}-\d{2})/)![1];
    const text = extractLogText(readFileSync(join(JOURNAL, f), "utf8"), "Raw Log");
    const { entries } = parseEntries(text);
    const basePrompt = buildPrompt(cfg, entries, { prevDayContext: prevDayContext(prev) });

    let day: DayResult | null = null;
    let lastErr = "";
    for (let attempt = 1; attempt <= 2 && !day; attempt++) {
      const prompt = attempt === 1 ? basePrompt : `${basePrompt}\n\n## 上次输出的问题(请修正后重新输出完整 JSON)\n${lastErr}`;
      try {
        const out = await callLLM(prompt);
        day = buildOutput(date, entries, parseJsonLoose(out), cfg);
      } catch (e) {
        lastErr = (e as Error).message;
        if (e instanceof ValidationError || lastErr.includes("JSON")) continue;
        throw e; // network/HTTP error — stop
      }
    }
    if (!day) throw new Error(`${date} 两次尝试都失败: ${lastErr}`);

    const dir = join(OUTBASE, date.slice(0, 4), date.slice(0, 7));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${date}.json`), JSON.stringify(day, null, 1));
    console.log(`✓ ${date}  支出¥${day.daily_total} 收入¥${day.daily_income}  ${day.blocks.length} 块 / ${day.expenses.length} 笔  warnings=${day.warnings.length}`);
    prev = day;
  }
  console.log("\n完成。这 7 天的 JSON 已由 LLM 真实生成,覆盖了 seed 在 06-08~06-14 的版本。");
}

void main();
