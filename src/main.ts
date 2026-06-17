/**
 * main.ts — Obsidian plugin entry (thin glue).
 *
 * Everything substantial lives in src/core (pure, tested), src/ui (the two
 * dashboards), and src/io (LLM + pipeline). This file wires them to Obsidian:
 * settings + settings tab, the two markdown code-block processors, and the
 * parse command.
 */
import { App, Editor, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { mount as mountExpense, type ExpenseConfig } from "./ui/expense-dashboard";
import { mount as mountCalendar, type TimeblockConfig } from "./ui/timeblock-calendar";
import { PROVIDERS, type LlmSettings, type ProviderId } from "./io/llm-core";
import { parseNote, type PipelineSettings } from "./io/pipeline";

interface LifelogSettings {
  dataRoot: string;
  logHeading: string | null;
  fallbackCategory: string;
  llm: LlmSettings;
  expense: Omit<ExpenseConfig, "dataRoot" | "overrideRoot" | "catsPath">;
  calendar: Omit<TimeblockConfig, "dataRoot">;
}

const DEFAULT_SETTINGS: LifelogSettings = {
  dataRoot: ".lifelog/daily",
  logHeading: "Raw Log",
  fallbackCategory: "其他",
  llm: { provider: "anthropic", apiKey: "", model: "", baseUrl: "" },
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

    // Quick-capture: drop an `HH:MM:SS ` line at the end of the log and park the
    // cursor after it. Bind a hotkey in Obsidian → Settings → Hotkeys.
    this.addCommand({
      id: "lifelog-append-entry",
      name: "Append timestamped entry to log",
      editorCallback: (editor) => this.appendTimestampedEntry(editor),
    });

    this.addRibbonIcon("bot", "Lifelog: 解析当前笔记", () => void this.parseCurrentNote());

    this.addSettingTab(new LifelogSettingTab(this.app, this));
  }

  async parseCurrentNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("Lifelog: 没有打开的笔记");
      return;
    }
    if (!this.settings.llm.apiKey) {
      new Notice("Lifelog: 请先在设置里填写 API key");
      return;
    }
    const notice = new Notice(`Lifelog: 正在解析 ${file.basename}…`, 0);
    try {
      const pipelineSettings: PipelineSettings = {
        dataRoot: this.settings.dataRoot,
        logHeading: this.settings.logHeading,
        fallbackCategory: this.settings.fallbackCategory,
        llm: this.settings.llm,
      };
      const r = await parseNote(this.app, file, pipelineSettings);
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
      .setDesc("解析结果与 demo 数据所在目录(相对 vault 根)。")
      .addText((t) => t.setValue(s.dataRoot).setPlaceholder(".lifelog/daily").onChange(async (v) => { s.dataRoot = v.trim() || ".lifelog/daily"; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Log heading")
      .setDesc("日记里包含原始日志的小标题;留空表示解析整篇笔记。")
      .addText((t) => t.setValue(s.logHeading ?? "").setPlaceholder("Raw Log").onChange(async (v) => { s.logHeading = v.trim() || null; await this.plugin.saveSettings(); }));

    containerEl.createEl("h3", { text: "LLM 解析" });

    new Setting(containerEl)
      .setName("Provider")
      .setDesc("Claude 走原生 Messages API;其余走 OpenAI 兼容接口。")
      .addDropdown((d) => {
        for (const [id, p] of Object.entries(PROVIDERS)) d.addOption(id, p.label);
        d.setValue(s.llm.provider).onChange(async (v) => { s.llm.provider = v as ProviderId; await this.plugin.saveSettings(); this.display(); });
      });

    const preset = PROVIDERS[s.llm.provider];
    new Setting(containerEl)
      .setName("API key")
      .addText((t) => { t.setValue(s.llm.apiKey).setPlaceholder("sk-…").onChange(async (v) => { s.llm.apiKey = v.trim(); await this.plugin.saveSettings(); }); t.inputEl.type = "password"; });

    new Setting(containerEl)
      .setName("Model")
      .setDesc(`留空使用默认: ${preset.model || "(需填写)"}`)
      .addText((t) => t.setValue(s.llm.model).setPlaceholder(preset.model).onChange(async (v) => { s.llm.model = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Base URL")
      .setDesc(`留空使用默认: ${preset.baseUrl || "(需填写)"}`)
      .addText((t) => t.setValue(s.llm.baseUrl).setPlaceholder(preset.baseUrl).onChange(async (v) => { s.llm.baseUrl = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("手动解析当前笔记")
      .setDesc("用上面的 provider 解析当前打开的日记,结果写入 data root,并在 usage.jsonl 记一笔 token 用量。")
      .addButton((b) =>
        b
          .setButtonText("解析当前笔记")
          .setCta()
          .onClick(() => void this.plugin.parseCurrentNote()),
      );
  }
}
