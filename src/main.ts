/**
 * main.ts — Obsidian plugin entry (thin glue).
 *
 * Everything substantial lives in src/core (pure, tested), src/ui (the two
 * dashboards), and src/io (LLM + pipeline). This file wires them to Obsidian:
 * settings + settings tab, the two markdown code-block processors, and the
 * parse command.
 */
import { App, Editor, Modal, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { mount as mountExpense, type ExpenseConfig } from "./ui/expense-dashboard";
import { mount as mountCalendar, type TimeblockConfig } from "./ui/timeblock-calendar";
import { PROVIDERS, resolveProvider, type LlmSettings, type ProviderId } from "./io/llm-core";
import { backfill, incrementalParse, parseNote, type PipelineSettings, type Watermark } from "./io/pipeline";

interface LifelogSettings {
  dataRoot: string;
  /** Vault-relative root holding the daily notes (date → note resolution). */
  journalRoot: string;
  logHeading: string | null;
  fallbackCategory: string;
  /** Run an incremental catch-up when Obsidian opens the vault. */
  parseOnStartup: boolean;
  /** While-open auto-parse interval in minutes (0 = off). */
  parseIntervalMin: number;
  /** Incremental progress marker; advanced after each incremental run. */
  watermark: Watermark | null;
  llm: LlmSettings;
  expense: Omit<ExpenseConfig, "dataRoot" | "overrideRoot" | "catsPath">;
  calendar: Omit<TimeblockConfig, "dataRoot">;
}

const DEFAULT_SETTINGS: LifelogSettings = {
  dataRoot: ".lifelog/daily",
  journalRoot: "10 Journal",
  logHeading: "Raw Log",
  fallbackCategory: "其他",
  parseOnStartup: true,
  parseIntervalMin: 0,
  watermark: null,
  llm: { provider: "claude-cli", apiKey: "", model: "", baseUrl: "", claudeBin: "", timeoutSec: 300 },
  expense: {
    incomeCats: ["出物", "红包", "劳动", "转账", "请客"],
    accent: "#6c8eef",
    upColor: "#e0697f",
    downColor: "#3fb98a",
    fallbackColor: "#b5bac2",
    fallbackIcon: "📦",
    tableLimit: 400,
    cats: {
      食物: { color: "#e8a87c", icon: "🍜" },
      交通: { color: "#7fb3d5", icon: "🚇" },
      日常: { color: "#9ba7b8", icon: "🏠" },
      学习: { color: "#7fb38c", icon: "📚" },
      娱乐: { color: "#b79ced", icon: "🎮" },
      医疗: { color: "#e89ba8", icon: "💊" },
      请客: { color: "#c9a87c", icon: "🍽️" },
      转账: { color: "#a9b0b8", icon: "💸" },
      出物: { color: "#88c9a1", icon: "♻️" },
      红包: { color: "#e8c77c", icon: "🧧" },
      劳动: { color: "#7fc8c0", icon: "💼" },
      其他: { color: "#b5bac2", icon: "📦" },
    },
  },
  calendar: {
    colors: {
      睡眠: "#f0a8c2",
      网络娱乐: "#d3a3d6",
      线下娱乐: "#f2a892",
      兴趣技能: "#c0a5e2",
      购物: "#f2bd86",
      生活: "#9bd9b5",
      事务: "#aeb9c7",
      健康: "#8ed3c8",
      学习工作: "#9ec4ed",
      系统搭建: "#aaa4e8",
      社交: "#e6d188",
      其他: "#c0c4ca",
    },
    fallbackColor: "#c0c4ca",
    presenceColor: "#edc98a",
    blockOpacity: 0.32,
    hourPx: 46,
    minHourPx: 22,
    maxHourPx: 260,
    zoomStep: 10,
    scrollMaxVh: 62,
    autoFit: true,
    autoFitRatio: 0.052,
    mergeGapMin: 2,
  },
};

/** Parse `key: value` lines from a code-block body into a flat override map. */
function parseBlockSource(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of source.split("\n")) {
    const m = /^\s*([\w.-]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export default class LifelogPlugin extends Plugin {
  settings: LifelogSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();

    const dataRootOf = (src: Record<string, string>) => src.dataRoot || this.settings.dataRoot;

    this.registerMarkdownCodeBlockProcessor("lifelog-expense", (source, container) => {
      const o = parseBlockSource(source);
      const dataRoot = dataRootOf(o);
      void mountExpense(container, {
        app: this.app,
        config: {
          ...this.settings.expense,
          dataRoot,
          overrideRoot: `${dataRoot}/overrides`,
          catsPath: o.catsPath || `${dataRoot.replace(/\/daily$/, "")}/categories.json`,
        },
      });
    });

    this.registerMarkdownCodeBlockProcessor("lifelog-calendar", (source, container) => {
      const o = parseBlockSource(source);
      mountCalendar(container, {
        app: this.app,
        config: { ...this.settings.calendar, dataRoot: dataRootOf(o) },
      });
    });

    this.addCommand({
      id: "lifelog-parse-current-note",
      name: "Parse current note's log",
      callback: () => void this.parseCurrentNote(),
    });

    this.addCommand({
      id: "lifelog-incremental-parse",
      name: "Incremental parse (watermark → today)",
      callback: () => void this.runIncremental(true),
    });

    this.addCommand({
      id: "lifelog-backfill",
      name: "Backfill a date range / missing days…",
      callback: () => new BackfillModal(this.app, this).open(),
    });

    // Quick-capture: drop an `HH:MM:SS ` line at the end of the log and park the
    // cursor after it. Bind a hotkey in Obsidian → Settings → Hotkeys.
    this.addCommand({
      id: "lifelog-append-entry",
      name: "Append timestamped entry to log",
      editorCallback: (editor) => this.appendTimestampedEntry(editor),
    });

    this.addRibbonIcon("bot", "Lifelog: 解析当前笔记", () => void this.parseCurrentNote());

    this.addSettingTab(new LifelogSettingTab(this.app, this));

    // Catch-up on open (the on-demand replacement for the 04:00 launchd job) and,
    // optionally, on a while-open interval. Both go through the watermark, so they
    // only parse what changed and never double-count.
    if (this.settings.parseOnStartup) {
      this.app.workspace.onLayoutReady(() => void this.runIncremental(false));
    }
    if (this.settings.parseIntervalMin > 0) {
      this.registerInterval(window.setInterval(() => void this.runIncremental(false), this.settings.parseIntervalMin * 60_000));
    }
  }

  /** Build the IO-layer settings bundle from plugin settings. */
  private pipelineSettings(): PipelineSettings {
    return {
      dataRoot: this.settings.dataRoot,
      journalRoot: this.settings.journalRoot,
      logHeading: this.settings.logHeading,
      fallbackCategory: this.settings.fallbackCategory,
      llm: this.settings.llm,
    };
  }

  /** True when the active provider needs no API key (claude -p subprocess). */
  private providerNeedsKey(): boolean {
    return resolveProvider(this.settings.llm).kind !== "cli";
  }

  /** Incremental catch-up from the stored watermark; advances + persists it. */
  async runIncremental(verbose: boolean): Promise<void> {
    if (this.providerNeedsKey() && !this.settings.llm.apiKey) {
      if (verbose) new Notice("Lifelog: 请先在设置里填写 API key(或切换到 Claude CLI provider)");
      return;
    }
    const notice = verbose ? new Notice("Lifelog: 增量解析中…", 0) : null;
    try {
      const { results, failures, newWatermark } = await incrementalParse(this.app, this.pipelineSettings(), this.settings.watermark);
      if (newWatermark) {
        this.settings.watermark = newWatermark;
        await this.saveSettings();
      }
      notice?.hide();
      if (verbose || results.length || failures.length) {
        const tail = failures.length ? `,失败 ${failures.length} 天(${failures.map((f) => f.date).join(", ")})` : "";
        new Notice(`Lifelog: 增量解析完成 — ${results.length} 天${tail}`, failures.length ? 8000 : 4000);
      }
      if (failures.length) console.error("[lifelog] incremental failures", failures);
    } catch (e) {
      notice?.hide();
      if (verbose) new Notice(`Lifelog: 增量解析失败 — ${(e as Error).message}`, 8000);
      console.error("[lifelog] incremental parse failed", e);
    }
  }

  /** Backfill a range (or all journal days). Invoked from BackfillModal. */
  async runBackfill(opts: { from?: string; to?: string; skipExisting?: boolean }): Promise<void> {
    if (this.providerNeedsKey() && !this.settings.llm.apiKey) {
      new Notice("Lifelog: 请先在设置里填写 API key(或切换到 Claude CLI provider)");
      return;
    }
    const notice = new Notice("Lifelog: 回填中…", 0);
    try {
      const { results, failures, skipped } = await backfill(this.app, this.pipelineSettings(), opts);
      notice.hide();
      const tail = failures.length ? `,失败 ${failures.length}` : "";
      new Notice(`Lifelog: 回填完成 — 解析 ${results.length} 天,跳过 ${skipped.length}${tail}`, failures.length ? 8000 : 5000);
      if (failures.length) console.error("[lifelog] backfill failures", failures);
    } catch (e) {
      notice.hide();
      new Notice(`Lifelog: 回填失败 — ${(e as Error).message}`, 8000);
      console.error("[lifelog] backfill failed", e);
    }
  }

  async parseCurrentNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("Lifelog: 没有打开的笔记");
      return;
    }
    if (this.providerNeedsKey() && !this.settings.llm.apiKey) {
      new Notice("Lifelog: 请先在设置里填写 API key(或切换到 Claude CLI provider)");
      return;
    }
    const notice = new Notice(`Lifelog: 正在解析 ${file.basename}…`, 0);
    try {
      const r = await parseNote(this.app, file, this.pipelineSettings());
      notice.hide();
      new Notice(
        `Lifelog: ${r.date} 解析完成 — 支出 ¥${r.out.daily_total},${r.out.blocks.length} 个时间块` +
          `(token in/out ${r.usage.inputTokens}/${r.usage.outputTokens})`,
      );
    } catch (e) {
      notice.hide();
      new Notice(`Lifelog: 解析失败 — ${(e as Error).message}`, 8000);
      console.error("[lifelog] parse failed", e);
    }
  }

  /** Insert `HH:MM:SS ` at the end of the log section and place the cursor after it. */
  private appendTimestampedEntry(editor: Editor): void {
    const pad = (n: number) => String(n).padStart(2, "0");
    const now = new Date();
    const ts = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} `;

    const lines = editor.getValue().split("\n");
    let insertAt = lines.length; // default: end of document

    // If a log heading is configured and present, insert at the end of that section.
    const heading = this.settings.logHeading;
    if (heading) {
      let hi = -1;
      let level = 0;
      for (let i = 0; i < lines.length; i++) {
        const m = /^(#+)\s+(.*)$/.exec(lines[i].trim());
        if (m && m[2].trim() === heading) {
          hi = i;
          level = m[1].length;
          break;
        }
      }
      if (hi >= 0) {
        let end = lines.length;
        for (let i = hi + 1; i < lines.length; i++) {
          const m = /^(#+)\s/.exec(lines[i]);
          if (m && m[1].length <= level) {
            end = i;
            break;
          }
        }
        let j = end - 1;
        while (j > hi && lines[j].trim() === "") j--; // skip trailing blank lines
        insertAt = j + 1;
      }
    }

    if (insertAt >= lines.length) {
      const last = lines.length - 1;
      const needNL = lines[last] !== "";
      editor.replaceRange((needNL ? "\n" : "") + ts, { line: last, ch: lines[last].length });
      const curLine = needNL ? last + 1 : last;
      editor.setCursor({ line: curLine, ch: ts.length });
    } else {
      editor.replaceRange(ts + "\n", { line: insertAt, ch: 0 });
      editor.setCursor({ line: insertAt, ch: ts.length });
    }
    editor.focus();
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    this.settings.llm = Object.assign({}, DEFAULT_SETTINGS.llm, loaded.llm);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class LifelogSettingTab extends PluginSettingTab {
  plugin: LifelogPlugin;

  constructor(app: App, plugin: LifelogPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    containerEl.createEl("h3", { text: "数据 / Data" });

    new Setting(containerEl)
      .setName("Data root")
      .setDesc("解析结果与 demo 数据所在目录(相对 vault 根)。categories.json / projects.json 须放在它的上一层(去掉末尾 /daily)。")
      .addText((t) => t.setValue(s.dataRoot).setPlaceholder(".lifelog/daily").onChange(async (v) => { s.dataRoot = v.trim() || ".lifelog/daily"; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Journal root")
      .setDesc("日记所在根目录,用于「按日期定位笔记」(增量解析 / 回填)。结构默认 <root>/YYYY/YYYY-MM/…MM-DD…。")
      .addText((t) => t.setValue(s.journalRoot).setPlaceholder("10 Journal").onChange(async (v) => { s.journalRoot = v.trim() || "10 Journal"; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Log heading")
      .setDesc("日记里包含原始日志的小标题;留空表示解析整篇笔记。")
      .addText((t) => t.setValue(s.logHeading ?? "").setPlaceholder("Raw Log").onChange(async (v) => { s.logHeading = v.trim() || null; await this.plugin.saveSettings(); }));

    containerEl.createEl("h3", { text: "LLM 解析" });

    const preset = PROVIDERS[s.llm.provider];
    const isCli = resolveProvider(s.llm).kind === "cli";

    new Setting(containerEl)
      .setName("Provider")
      .setDesc("Claude CLI 走本地 claude -p(订阅计费,无需 API key,仅桌面端);其余走 HTTP API。")
      .addDropdown((d) => {
        for (const [id, p] of Object.entries(PROVIDERS)) d.addOption(id, p.label);
        d.setValue(s.llm.provider).onChange(async (v) => { s.llm.provider = v as ProviderId; await this.plugin.saveSettings(); this.display(); });
      });

    if (isCli) {
      new Setting(containerEl)
        .setName("Claude 二进制路径")
        .setDesc("留空则用 PATH 上的 `claude`;若 claude 不在 PATH 上,填它的绝对路径(如 ~/.local/bin/claude)。")
        .addText((t) => t.setValue(s.llm.claudeBin ?? "").setPlaceholder("claude").onChange(async (v) => { s.llm.claudeBin = v.trim(); await this.plugin.saveSettings(); }));

      new Setting(containerEl)
        .setName("超时 (秒)")
        .setDesc("单次 claude -p 调用的硬上限。")
        .addText((t) => t.setValue(String(s.llm.timeoutSec ?? 300)).setPlaceholder("300").onChange(async (v) => { const n = parseInt(v, 10); s.llm.timeoutSec = Number.isFinite(n) && n > 0 ? n : 300; await this.plugin.saveSettings(); }));
    } else {
      new Setting(containerEl)
        .setName("API key")
        .addText((t) => { t.setValue(s.llm.apiKey).setPlaceholder("sk-…").onChange(async (v) => { s.llm.apiKey = v.trim(); await this.plugin.saveSettings(); }); t.inputEl.type = "password"; });

      new Setting(containerEl)
        .setName("Base URL")
        .setDesc(`留空使用默认: ${preset.baseUrl || "(需填写)"}`)
        .addText((t) => t.setValue(s.llm.baseUrl).setPlaceholder(preset.baseUrl).onChange(async (v) => { s.llm.baseUrl = v.trim(); await this.plugin.saveSettings(); }));
    }

    new Setting(containerEl)
      .setName("Model")
      .setDesc(`留空使用默认: ${preset.model || "(需填写)"}`)
      .addText((t) => t.setValue(s.llm.model).setPlaceholder(preset.model).onChange(async (v) => { s.llm.model = v.trim(); await this.plugin.saveSettings(); }));

    containerEl.createEl("h3", { text: "自动解析 / Scheduling" });

    new Setting(containerEl)
      .setName("打开 vault 时增量解析")
      .setDesc("替代旧的 04:00 launchd:每次打开 Obsidian 时,从水位补到今天。")
      .addToggle((t) => t.setValue(s.parseOnStartup).onChange(async (v) => { s.parseOnStartup = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("定时增量解析 (分钟)")
      .setDesc("Obsidian 开着时每隔 N 分钟跑一次增量;0 = 关闭。改动需重载插件生效。")
      .addText((t) => t.setValue(String(s.parseIntervalMin)).setPlaceholder("0").onChange(async (v) => { const n = parseInt(v, 10); s.parseIntervalMin = Number.isFinite(n) && n > 0 ? n : 0; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("水位 / Watermark")
      .setDesc(s.watermark ? `已处理到 ${s.watermark.date} ${s.watermark.time}` : "尚无水位(下次增量将从昨天开始)")
      .addButton((b) => b.setButtonText("重置水位").onClick(async () => { s.watermark = null; await this.plugin.saveSettings(); this.display(); }));

    containerEl.createEl("h3", { text: "操作 / Actions" });

    new Setting(containerEl)
      .setName("解析当前笔记")
      .setDesc("用上面的 provider 解析当前打开的日记,结果写入 data root,并在 usage.jsonl 记一笔 token 用量。")
      .addButton((b) => b.setButtonText("解析当前笔记").setCta().onClick(() => void this.plugin.parseCurrentNote()));

    new Setting(containerEl)
      .setName("增量解析")
      .setDesc("从水位补到今天。")
      .addButton((b) => b.setButtonText("增量解析").onClick(() => void this.plugin.runIncremental(true)));

    new Setting(containerEl)
      .setName("回填")
      .setDesc("按日期范围 / 仅缺失日,全量重刷。")
      .addButton((b) => b.setButtonText("回填…").onClick(() => new BackfillModal(this.app, this.plugin).open()));
  }
}

/** Small modal collecting backfill bounds: from / to (optional) + skip-existing. */
class BackfillModal extends Modal {
  plugin: LifelogPlugin;
  from = "";
  to = "";
  skipExisting = true;

  constructor(app: App, plugin: LifelogPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "回填 / Backfill" });
    contentEl.createEl("p", { text: "留空 from/to = 不限。raw log 是唯一事实源,回填会全量重刷(覆盖 raw daily;override 文件不动)。", cls: "setting-item-description" });

    new Setting(contentEl)
      .setName("From (YYYY-MM-DD)")
      .addText((t) => t.setPlaceholder("不限").onChange((v) => (this.from = v.trim())));
    new Setting(contentEl)
      .setName("To (YYYY-MM-DD)")
      .addText((t) => t.setPlaceholder("不限").onChange((v) => (this.to = v.trim())));
    new Setting(contentEl)
      .setName("只补缺失")
      .setDesc("跳过已有 raw daily 的日期(等价 backfill.py --skip-existing)。")
      .addToggle((t) => t.setValue(this.skipExisting).onChange((v) => (this.skipExisting = v)));

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("开始回填")
        .setCta()
        .onClick(() => {
          const ymd = /^\d{4}-\d{2}-\d{2}$/;
          if (this.from && !ymd.test(this.from)) return void new Notice("From 日期格式应为 YYYY-MM-DD");
          if (this.to && !ymd.test(this.to)) return void new Notice("To 日期格式应为 YYYY-MM-DD");
          this.close();
          void this.plugin.runBackfill({ from: this.from || undefined, to: this.to || undefined, skipExisting: this.skipExisting });
        }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
