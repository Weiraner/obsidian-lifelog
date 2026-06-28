/**
 * prompt.ts — the LLM contract.
 *
 * The model is a *semantic* classifier only: it splits the day into activities
 * and classifies them, referencing intervals by entry index so it can never
 * hallucinate a wall-clock time. Everything else (time math, validation) is
 * done in parser.ts. Keeping the template here as a versioned constant means the
 * prompt is reviewable in diffs like any other code.
 *
 * This embedded constant is the generic, shareable default. A user can keep a
 * private, more detailed template (with personal worked examples) outside the
 * repo as `<configDir>/prompt_template.txt`; the pipeline reads it and passes it
 * to buildPrompt() as `ctx.template`, which then overrides this default. That way
 * the personal prompt never ships inside the bundle.
 */
import type { Entry, ParseConfig, Project, Taxonomy } from "./schema";

export const PROMPT_TEMPLATE = `你是个人日志解析器。把带时间戳的日志条目解析成「时间块」和「费用记录」,只输出 JSON。

## 时间类目(category 必须从中选择)
{time_categories}

## 费用类目(category 必须从中选择)
{expense_categories}

## 活跃项目清单(按 label 分组;proj 必须归一到正式名称,别名按清单映射)
{projects}

## 前一天上下文(用于跨日块判断)
{prev_day_context}

## 增量解析水位(关键)
{watermark_instruction}

## 输入
JSON 数组,每条 {"i": 索引, "t": "HH:MM:SS", "c": "内容"}。时间戳是记录时刻。

## 条目类型判断(依据中文体标记)
- 回顾型:描述刚结束的事(「X完了」「X了一下」「做了X」)→ 内容占据区间 [上一条, 本条]
- 前瞻型:宣告即将开始(「开始X」「要X了」「打算X」「去X」)→ 内容占据区间 [本条, 下一条]
- 混合型:前半回顾 + 后半前瞻 → 在本条时间戳同时关闭旧块、打开新块

## 时间块规则
1. 区间(start / end)允许的写法,**只能用下面 4 种**,优先级越往后越例外:
   (a) 条目索引(默认): {"start": 2, "end": 3} 表示条目2的时间戳到条目3的时间戳。绝大多数块用这种。
   (b) 边界 sentinel: "day_start" (当天 00:00) 只能用在 start; "day_end" (开放块) 只能用在 end。
   (c) 字面时间字符串 "HH:MM:SS": 仅当应用「时长回推规则」(见 7c) 或条目内文出现「内嵌时间戳」(见 7d)才使用。
   (d) 跨日边界: "前一天 HH:MM:SS" 只能出现在 start —— 表示该活动开始于昨天,延续到今天。详见 7e。
2. 第一条时间戳之前就在进行的活动(典型:睡眠)→ "start": "day_start"
3. 最后一条是前瞻型(如「去睡了」)→ "end": "day_end"
4. 并行活动(「A+B」「边A边B」)→ 拆成两个同区间的块
5. 后台任务标记:「>>名字」开始、「<<名字」结束 → 生成 "background": true 的块。
5b. 注意力时长 vs 真实持续:时间块记录「注意力投入时间」,不是物理持续时间。set-and-forget 任务
   (洗衣机/烤箱/煮饭)块只覆盖你在场操作的几分钟,mark background+inferred;持续注意力活动正常 span。
5c. 粗体条目中的金额是 expenses,不影响块时长判断。
6. 冲突消解:前瞻型计划 A 但下一条回顾型是无关 B → 以回顾为准,A 块保留但 inferred+low;A 是 B 一部分则合并。
7. 长间隔(>2小时)且上下文表明在睡 → 生成睡眠块。
7b. 粒度:每条 entry 的区间各自成块,绝不合并连续多条;渲染层会视觉折叠相邻同名块。
7c. 时长回推:回顾型内文出现明确时长(「X分钟」)且 < 距上条间隔 → 拆两段,边界写字面 "HH:MM:SS"(自己算)。
7d. 内嵌时间戳:内文里手写的 "*22:40*" 是显式边界,当字面时间字符串用。
7e. 跨日块(只记前一天延续到今天的):用 "start": "前一天 HH:MM:SS";开始日那边不要生成「→后一天」块。
8. 每个块带 "src": 推导出该块的那条条目的索引。
9. category 必须从「时间类目」表逐字选;费用类目绝不能用作时间块 category。
9b. label:类目列了候选清单则逐字照抄(不加后缀);未列清单的类目 label 自拟 2~10 字。
10. presence(同伴区间):汇合→span 开始,分开→span 结束;span 内活动照常成块,聊天话题进 notes。
11. proj:标注「需额外输出 proj」的类目每块输出 proj(归一到正式名);泛泛的填 "";其他类目一律 ""。
12. detail:一句短语写具体内容,提炼而非照抄;无可提炼写 ""。

## 点事件规则
瞬间完成的一次性动作(下单/挂号/收快递)若非区间主体 → 输出到 events 挂在该条目时间戳上。
有费用的瞬间动作只记 expenses。

## 费用规则
1. 只有 **粗体** 包裹的是费用,格式「金额 渠道 物品」,单位人民币。
2. 复合「A + B」拆多条;括号内明细不重复记账。
3. category 填一级,sub 填二级(从词表选,都不贴切选"其他")。
4. type 填 "支出"/"收入":明确收到钱(回款/退款/红包)才收入,默认支出。
5. channel 是平台/渠道,识别不出填 null。
6. 每条带 "entry": 来源条目索引。

## 输出
只输出一个 JSON 对象,不要 markdown 围栏,不要解释:
{
 "blocks": [
  {"start": <索引|"day_start"|"HH:MM:SS"|"前一天 HH:MM:SS">,
   "end":   <索引|"day_end"|"HH:MM:SS">,
   "src": <索引>,
   "label": "...", "category": "...", "detail": "...", "proj": "",
   "background": false, "inferred": false, "confidence": "high"}
 ],
 "expenses": [
  {"entry": <索引>, "amount": 25.89, "item": "...", "category": "...",
   "sub": "...", "type": "支出", "channel": "..."}
 ],
 "events": [
  {"entry": <索引>, "label": "挂到妇科号", "category": "健康"}
 ],
 "presence": [
  {"person": "zhj", "start": <索引|"day_start">, "end": <索引|"day_end">,
   "notes": [{"entry": <索引>, "text": "聊了…的话题"}]}
 ]
}

## 待解析条目
{entries_json}`;

function fmtTaxonomy(tax: Taxonomy): string {
  const lines: string[] = [];
  for (const [name, v] of Object.entries(tax)) {
    if (typeof v === "string") {
      lines.push(`- ${name}: ${v}`);
      continue;
    }
    let line = `- ${name}: ${v.hint || ""}`;
    const labels = v.labels || [];
    if (labels.length) {
      line += `\n  其下细分必须从词表中逐字选择(原样照抄,不要增删字): ${labels.join(" / ")}`;
      const hints = v.label_hints || {};
      for (const lb of labels) if (lb in hints) line += `\n    · ${lb}: ${hints[lb]}`;
    }
    if (v.proj) line += "\n  此类目的块需额外输出 proj";
    lines.push(line);
  }
  return lines.join("\n");
}

function fmtProjects(projs: Project[]): string {
  const byLabel = new Map<string, Project[]>();
  for (const p of projs) {
    const k = p.label || "(未归属)";
    if (!byLabel.has(k)) byLabel.set(k, []);
    byLabel.get(k)!.push(p);
  }
  const lines = [...byLabel.entries()].map(
    ([lbl, ps]) =>
      `- ${lbl}: ` +
      ps.map((p) => p.name + (p.aliases?.length ? `(别名: ${p.aliases.join("、")})` : "")).join(";"),
  );
  return lines.join("\n") || "(当前无活跃项目)";
}

/** Tell the model how much of the day a previous incremental run already covered. */
export function buildWatermarkInstruction(entries: Entry[], watermarkTime: string | null): string {
  if (!watermarkTime) return "本日为全新解析 — 所有 entries 都需要生成对应 blocks / events / expenses。";
  const firstNew = entries.find((e) => e.t > watermarkTime)?.i ?? entries.length;
  if (firstNew === 0) {
    return `水位 t=${watermarkTime}, 但所有 entries 的 t 都 > 水位 —— 等同全新解析,为所有 entries 生成输出。`;
  }
  if (firstNew >= entries.length) {
    return `水位 t=${watermarkTime}, 所有 entries 都 <= 水位 —— 上次已处理完,本次输出空数组即可。`;
  }
  return (
    `水位 t=${watermarkTime}: entries 索引 0 ~ ${firstNew - 1} 已在之前的运行中处理(t <= ${watermarkTime}),` +
    `作为**上下文**使用,但**不要**为它们生成 blocks / events / expenses。从索引 ${firstNew} (t > ${watermarkTime}) 开始生成。` +
    `\n注意: 第一个块的 start 应 >= 水位,可用字面 "HH:MM:SS" 钉在水位上衔接旧数据;不要回退到水位之前。`
  );
}

export interface PromptContext {
  prevDayContext?: string;
  watermarkTime?: string | null;
  /** Override the embedded PROMPT_TEMPLATE (e.g. a private template read from disk). */
  template?: string;
}

export function buildPrompt(cfg: ParseConfig, entries: Entry[], ctx: PromptContext = {}): string {
  const payload = entries.map((e) => ({ i: e.i, t: e.t, c: e.c }));
  return (ctx.template || PROMPT_TEMPLATE)
    .replace("{time_categories}", fmtTaxonomy(cfg.time_categories))
    .replace("{expense_categories}", fmtTaxonomy(cfg.expense_categories))
    .replace("{projects}", fmtProjects(cfg.projects))
    .replace("{prev_day_context}", ctx.prevDayContext || "(无前一天上下文)")
    .replace("{watermark_instruction}", buildWatermarkInstruction(entries, ctx.watermarkTime ?? null))
    .replace("{entries_json}", JSON.stringify(payload, null, 1));
}
