/**
 * parser.test.ts — end-to-end test of the deterministic core with a mocked LLM.
 *
 * Ported from the original `test_pipeline.py`. The LLM is replaced by a fixed
 * MOCK object, so this exercises the whole validation/normalization pipeline
 * (vocab snapping, project resolution, cross-day, coverage, merge) for free,
 * without ever calling a model.
 */
import { describe, expect, it } from "vitest";
import categories from "./fixtures/categories.json";
import {
  buildOutput,
  closeOpenBlocks,
  mergeWithExisting,
  parseEntries,
  summarize,
} from "../src/core/parser";
import type { LlmOutput, ParseConfig, Project } from "../src/core/schema";

const RAW_LOG = `3:09:48 测试obsidian转录功能
3:28:16 测试成功
3:36:45 测试辅助功能 双击轻点背面记录
3:42:23 挑凪煤炉立牌大盘 测试日记本
3:43:58 看特别好的那个卖家有没有上新
3:48:42 没上什么好东西,继续回去挑大盘
4:56:16 比价半天之后终于列完 list 但是感觉不是很理智打算先睡然后明天继续决定
10:43:00 醒了买东西
13:35:57 确认下完想买的在闲鱼上发完煤炉留言了 总计应该买了400,所以放弃了本来要给出租屋添置的除湿器
14:02:22 **25.89 tb typeC转dvi线** 研究老显示器怎么用,买了TypeC转DVi的街头
14:07:26 收拾完书桌想玩一会儿洛克王国
14:23:19 洗衣服
14:32:46 洗完衣服40分钟后好
14:52:24 组了10个窝
15:07:54 刷了一会儿独角兽,把商城里的天鹅裙买了。睡睡觉
16:20:52 醒了
17:05:09 从醒了到现在下去收了衣服晾了衣服然后上来把之前月经沾上了部分洗了一下
17:34:40 **24.53 闪购 越式酸辣牛肉粉晚饭** 刷了手机,然后看了一下一个人住可以怎么煮饭吃,最后点了个外卖
17:59:42 **52.5 黎明骏河屋国际 + 25.6 沐沐 凪Q版立牌set (国际15.6+国内10)** 做了一个记账的快捷手势,然后把沐沐代切煤和黎明骏河屋的国际给交了
18:18:19 **20 菜鸟裹裹寄件杭州到苍南(19kg)** 交了运回家的邮费,修改了记账快捷指令里面错误的地方,然后下楼拿了外卖开始吃晚饭
18:58:39 吃完了
19:36:46 刷手机刷完开始研究一个人要怎么煮饭
20:08:37 收藏了一个空气炸锅打算自提 ![[airfryer.png]]
生活
IMG_9057.jpeg
20:20:02 去楼下拿了快递结果发现是爸爸买的电吹风我自己那个买重了
20:25:36 退完挂明天下午和zhj一起的妇科号
20:40:39 挂好了明天下午2:30到3:00的门诊妇科内分泌
20:42:00 上洛克王国清一下日常
22:01:32 和zhj聊性知识+刷异色
22:12:27 刷了300球噼啪鸟什么也没出。去打王者了
22:28:54 9.2王昭君 win
22:51:58 王者荣耀 弈星 9.5赢
23:05:32 王者荣耀 女娲 4.8 win 再也不玩女娲了
23:26:03 王者荣耀 少司缘 6.1 lose
23:45:51 王者荣耀甄姬9.5 win。
`;

const H = { background: false, inferred: false, confidence: "high" as const };

const MOCK: LlmOutput = {
  blocks: [
    { start: "day_start", end: 2, src: 2, label: "学习", category: "学习工作", proj: "日志系统", detail: "测试obsidian转录与辅助功能", ...H },
    { start: 2, end: 6, src: 6, label: "刷周边", category: "网络娱乐", detail: "凪煤炉立牌大盘比价,列完list", ...H },
    { start: 6, end: 7, src: 6, label: "睡觉", category: "睡眠", ...H },
    { start: 7, end: 8, src: 8, label: "刷周边", category: "网络娱乐", detail: "闲鱼下单+煤炉留言,约400,放弃除湿器", ...H },
    { start: 8, end: 9, src: 9, label: "其他", category: "生活", proj: "显示器折腾", detail: "研究老显示器,买TypeC转DVI", ...H },
    { start: 0, end: 1, src: 1, label: "找工", category: "学习工作", proj: "神秘项目", ...H },
    { start: 1, end: 2, src: 2, label: "学习", category: "学习工作", proj: "", ...H },
    { start: 0, end: 1, src: 1, label: "工作", category: "学习工作", proj: "日志系统", ...H },
    { start: 9, end: 10, src: 10, label: "打扫", category: "生活", detail: "收拾书桌", ...H },
    { start: 10, end: 11, src: 10, label: "洛克王国", category: "网络娱乐", ...H },
    { start: 11, end: 13, src: 11, label: "洗衣晾衣", category: "生活", background: true, inferred: true, confidence: "low" },
    { start: 11, end: 13, src: 13, label: "洛克王国", category: "网络娱乐", detail: "组了10个窝", ...H },
    { start: 13, end: 14, src: 14, label: "洛克王国", category: "网络娱乐", detail: "刷独角兽,买天鹅裙", ...H },
    { start: 14, end: 15, src: 14, label: "午睡", category: "睡眠", ...H },
    { start: 15, end: 16, src: 16, label: "洗衣晾衣", category: "生活", detail: "收衣晾衣+清洗", ...H },
    { start: 16, end: 17, src: 17, label: "其他", category: "网络娱乐", detail: "刷手机,看一个人怎么煮饭,点外卖", ...H },
    { start: 17, end: 18, src: 18, label: "刷周边", category: "网络娱乐", detail: "交沐沐代切+骏河屋国际,做记账快捷手势", ...H },
    { start: 18, end: 19, src: 19, label: "吃饭", category: "生活", detail: "寄件+拿外卖吃晚饭", ...H },
    { start: 19, end: 20, src: 19, label: "吃饭", category: "生活", ...H },
    { start: 20, end: 21, src: 21, label: "刷视频", category: "网络娱乐", ...H },
    { start: 21, end: 22, src: 22, label: "其他", category: "生活", detail: "研究一个人怎么煮饭,收藏空气炸锅", ...H },
    { start: 22, end: 23, src: 23, label: "取物品", category: "生活", ...H },
    { start: 23, end: 25, src: 25, label: "看病", category: "事务", detail: "退号改约,挂好妇科内分泌", ...H },
    { start: 26, end: 27, src: 26, label: "洛克王国", category: "网络娱乐", detail: "清日常", background: false, inferred: true, confidence: "low" },
    { start: 26, end: 27, src: 27, label: "和zhj聊天", category: "社交", ...H },
    { start: 26, end: 27, src: 27, label: "洛克王国", category: "网络娱乐", detail: "刷异色", ...H },
    { start: 27, end: 28, src: 28, label: "洛克王国", category: "网络娱乐", detail: "刷300球噼啪鸟无果", ...H },
    { start: 28, end: 33, src: 33, label: "王者荣耀", category: "网络娱乐", detail: "5局排位 4胜1负", ...H },
    { start: 33, end: "day_end", src: 33, label: "睡觉", category: "睡眠", background: false, inferred: true, confidence: "low" },
    { start: 5, end: 5, src: 5, label: "零长度测试", category: "其他", ...H },
    { start: 3, end: 4, src: 3, label: "未知类目测试", category: "不存在的类目", ...H },
    { start: 4, end: 5, src: 4, label: "撸猫游戏", category: "网络娱乐", ...H },
  ],
  presence: [
    { person: "zhj", start: 26, end: "day_end", notes: [{ entry: 27, text: "聊了性知识" }, { entry: 99, text: "非法索引" }] },
    { person: "", start: 1, end: 2, notes: [] },
  ],
  events: [
    { entry: 25, label: "挂到妇科内分泌号", category: "事务" },
    { entry: 22, label: "收藏空气炸锅", category: "生活" },
    { entry: 99, label: "非法索引测试", category: "事务" },
  ],
  expenses: [
    { entry: 9, amount: 25.89, item: "TypeC转DVI线", category: "日常", sub: "生活用品", type: "支出", channel: "淘宝" },
    { entry: 17, amount: 24.53, item: "越式酸辣牛肉粉", category: "食物", sub: "晚餐", type: "支出", channel: "闪购" },
    { entry: 18, amount: 52.5, item: "黎明骏河屋国际(凪立牌)", category: "娱乐", sub: "官谷", type: "支出", channel: "骏河屋" },
    { entry: 18, amount: 25.6, item: "沐沐代切煤 凪Q版立牌set", category: "娱乐", sub: "不存在的二级", type: "支出", channel: "代切" },
    { entry: 19, amount: 20, item: "寄件杭州到苍南 19kg", category: "日常", sub: "寄件邮费", type: "瞎填的", channel: "菜鸟裹裹" },
  ],
};

const PROJECTS: Project[] = [
  { name: "LifeOS", label: "学习", aliases: ["日志系统"], status: "active" },
  // 旧坑 is archived → callers pass only active projects, so it's omitted here.
];

const CFG: ParseConfig = {
  time_categories: categories.time_categories,
  expense_categories: categories.expense_categories,
  projects: PROJECTS,
  fallback_category: "其他",
};

const { entries } = parseEntries(RAW_LOG);
const out = buildOutput("2026-06-11", entries, MOCK, CFG);

describe("buildOutput — totals & basics", () => {
  it("sums only 支出 into daily_total", () => {
    expect(out.daily_total).toBe(148.52);
    expect(out.daily_income).toBe(0);
  });
  it("marks the day open (trailing open block)", () => {
    expect(out.open_end).toBe(true);
  });
  it("drops zero-length blocks", () => {
    expect(out.blocks.map((b) => b.label)).not.toContain("零长度测试");
  });
  it("falls unknown category back to 其他", () => {
    const unk = out.blocks.find((b) => b.label === "未知类目测试")!;
    expect(unk.category).toBe("其他");
  });
  it("anchors day_start to 00:00:00 and resolves the open block", () => {
    const first = out.blocks[0];
    expect(first.start).toBe("00:00:00");
    expect(first.end).toBe("03:36:45");
    const open = out.blocks.find((b) => b.open_end)!;
    expect(open.start).toBe("23:45:51");
    expect(open.end).toBeNull();
  });
});

describe("attachments & background", () => {
  it("collects wiki-embed + bare-filename attachments from the source entry", () => {
    const withAtt = out.blocks.filter((b) => b.attachments.length);
    expect(withAtt.some((b) => b.attachments.includes("airfryer.png") && b.attachments.includes("IMG_9057.jpeg"))).toBe(true);
  });
  it("keeps the background washing-machine block at attention span only", () => {
    const bg = out.blocks.find((b) => b.background)!;
    expect(bg.start).toBe("14:23:19");
    expect(bg.end).toBe("14:52:24");
  });
});

describe("project resolution", () => {
  it("resolves alias 日志系统 → LifeOS without spurious label correction", () => {
    const w0 = out.blocks.find((b) => b.start === "00:00:00" && b.category === "学习工作")!;
    expect(w0.proj).toBe("LifeOS");
    expect(w0.label).toBe("学习");
  });
  it("falls an empty proj back to the label", () => {
    const fb = out.blocks.find((b) => b.start === "03:28:16")!;
    expect(fb.proj).toBe("学习");
  });
  it("warns about a wild (unregistered) proj", () => {
    expect(out.blocks.some((b) => b.proj === "神秘项目")).toBe(true);
    expect(out.warnings.some((w) => w.includes("未注册 proj"))).toBe(true);
  });
  it("corrects a label that disagrees with the registered project", () => {
    const fix = out.blocks.find((b) => b.proj === "LifeOS" && b.start === "03:09:48")!;
    expect(fix.label).toBe("学习");
    expect(out.warnings.some((w) => w.includes("不一致"))).toBe(true);
  });
  it("clears proj for non-project categories", () => {
    const disp = out.blocks.find((b) => b.detail.includes("显示器"))!;
    expect(disp.proj).toBe("");
    expect(out.blocks.filter((b) => b.label === "洛克王国").every((b) => b.proj === "")).toBe(true);
  });
});

describe("vocab snapping", () => {
  it("falls an out-of-vocab label back to 其他", () => {
    const vio = out.blocks.find((b) => b.start === "03:43:58")!;
    expect(vio.label).toBe("其他");
  });
  it("preserves fine-grained 洛克王国 blocks (no merge in the data layer)", () => {
    const rk = out.blocks.filter((b) => b.label === "洛克王国");
    expect(rk.length).toBe(6);
    expect(rk.some((b) => b.detail === "组了10个窝")).toBe(true);
  });
  it("falls an out-of-vocab expense sub back to 其他", () => {
    const mu = out.expenses.find((x) => x.item.includes("沐沐"))!;
    expect(mu.sub).toBe("其他");
  });
  it("coerces an illegal expense type to 支出", () => {
    const nj = out.expenses.find((x) => x.item.includes("寄件"))!;
    expect(nj.type).toBe("支出");
  });
});

describe("presence & events", () => {
  it("keeps only the named presence span, with valid notes", () => {
    expect(out.presence.length).toBe(1);
    const sp = out.presence[0];
    expect(sp.person).toBe("zhj");
    expect(sp.start).toBe("20:42:00");
    expect(sp.open_end).toBe(true);
    expect(sp.notes).toEqual([{ time: "22:01:32", text: "聊了性知识" }]);
  });
  it("drops events with an illegal entry index", () => {
    expect(out.events.length).toBe(2);
    expect(out.events[0].time).toBe("20:08:37");
  });
});

describe("cross-day close", () => {
  it("closes yesterday's open block to 24:00:00", () => {
    const { changed, result } = closeOpenBlocks(out);
    expect(changed).toBe(true);
    const closed = result.blocks.find((b) => b.start === "23:45:51")!;
    expect(closed.end).toBe("24:00:00");
    expect(closed.open_end).toBe(false);
    const psp = result.presence[0];
    expect(psp.end).toBe("24:00:00");
    expect(psp.open_end).toBe(false);
    expect(result.open_end).toBe(false);
  });
});

describe("watermark merge", () => {
  it("keeps pre-watermark history and takes post-watermark new items", () => {
    const existing = buildOutput("2026-06-11", entries, MOCK, CFG);
    const next = buildOutput("2026-06-11", entries, { ...MOCK, expenses: [] }, CFG);
    const merged = mergeWithExisting(next, existing, "18:00:00");
    // pre-watermark expenses survive even though `next` had none
    expect(merged.expenses.some((x) => x.time === "14:02:22")).toBe(true);
    expect(merged.daily_total).toBeGreaterThan(0);
  });
});

describe("summarize", () => {
  it("produces a one-glance daily summary", () => {
    const s = summarize(out);
    expect(s).toContain("2026-06-11");
    expect(s).toContain("支出 ¥148.52");
  });
});
