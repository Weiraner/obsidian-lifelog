/**
 * pipeline.ts — the side-effecting glue that turns a daily note into a
 * structured day JSON. The Obsidian counterpart of the original `parse_log.py`
 * run(): read note → buildPrompt → LLM → buildOutput → write file. The pure
 * engine (parser/prompt) and the network call (llm) are imported; this file
 * owns the IO.
 */
import { App, TFile } from "obsidian";
import { Categories, Project, type DayResult, type ParseConfig } from "../core/schema";
import { buildOutput, extractLogText, parseEntries } from "../core/parser";
import { buildPrompt } from "../core/prompt";
import { callLLM } from "./llm";
import { parseJsonLoose, type LlmSettings, type LlmUsage } from "./llm-core";

export interface PipelineSettings {
  dataRoot: string;
  logHeading: string | null;
  fallbackCategory: string;
  llm: LlmSettings;
}

export interface PipelineResult {
  date: string;
  out: DayResult;
  usage: LlmUsage;
  outPath: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Directory that holds categories.json / projects.json (dataRoot's parent-ish). */
function configDir(dataRoot: string): string {
  return dataRoot.endsWith("/daily") ? dataRoot.slice(0, -"/daily".length) : dataRoot;
}

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

  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
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

/** Parse the given daily note into a structured day JSON and write it to disk. */
export async function parseNote(app: App, file: TFile, settings: PipelineSettings): Promise<PipelineResult> {
  const content = await app.vault.read(file);
  const text = extractLogText(content, settings.logHeading);
  const { entries } = parseEntries(text);
  if (!entries.length) throw new Error(`${file.basename} 中没有可解析的时间戳条目`);

  const cfg = await loadConfig(app, settings);
  const date = resolveDate(app, file);

  const prompt = buildPrompt(cfg, entries);
  const result = await callLLM(prompt, settings.llm);
  const llmOut = parseJsonLoose(result.text);
  const out = buildOutput(date, entries, llmOut, cfg);

  const [yy, ym] = [date.slice(0, 4), date.slice(0, 7)];
  const dir = `${settings.dataRoot}/${yy}/${ym}`;
  await ensureDir(app, dir);
  const outPath = `${dir}/${date}.json`;
  await app.vault.adapter.write(outPath, JSON.stringify(out, null, 1));

  // Append one usage-ledger line per call — faithful to the original
  // usage_log.jsonl. Aggregate later, e.g. with jq, for cost/token reports.
  const ledgerDir = configDir(settings.dataRoot);
  await ensureDir(app, ledgerDir);
  const ledgerLine =
    JSON.stringify({
      ts: new Date().toISOString(),
      date,
      provider: settings.llm.provider,
      model: result.usage.model,
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
    }) + "\n";
  try {
    await app.vault.adapter.append(`${ledgerDir}/usage.jsonl`, ledgerLine);
  } catch (e) {
    console.warn("[lifelog] usage ledger append failed", e);
  }

  return { date, out, usage: result.usage, outPath };
}
