# Raw-log sample — the input side

This folder shows what Lifelog actually **reads**: plain-text daily notes, written
the way you'd naturally jot a day down. A week of them (`2026-06-08` →
`2026-06-14`) plus the `categories.json` taxonomy they're parsed against.

The week traces one **CS course project end-to-end** — a campus second-hand-book
marketplace (full-stack) — from motivation through each phase, alongside an
ordinary student routine (meals, gym, runs, games, shows). It doubles as a small
project-management trace: you can watch the work move design → backend → frontend
→ integration → deploy → report, one or two time-blocks at a time.

| Day | Project phase (under 学习工作 / 项目) |
|---|---|
| Mon | Motivation + 选题 + 原型/技术栈 + 仓库脚手架 |
| Tue | 数据库设计(ER 图/建表)+ 后端脚手架 + 注册登录接口 |
| Wed | 订单接口 + 单元测试 + 和同学到图书馆联调鉴权 |
| Thu | 前端列表/详情/发布表单页 + 路由串联 |
| Fri | 前后端联调,攻 CORS / 图片上传 bug(加班到午夜) |
| Sat | 跨夜收尾 → 部署上线(Vercel)+ 文档 |
| Sun | 写实验报告 + 做答辩 PPT + 收尾 |

The parser turns these into the structured JSON under `../.lifelog/daily/` that the
dashboards render. (The committed demo JSON is seed-generated; these notes show the
*format* the LLM parser consumes.)

## Capture conventions (all shown across the week)

| Convention | Looks like | Becomes |
|---|---|---|
| Timestamped line | `10:30:48 决定做一个二手书网站…` | a time block `[上一条, 本条]` or `[本条, 下一条]` by 回顾/前瞻 phrasing |
| Expense (bold) | `**15 食堂 番茄牛腩饭午饭**` | an expense: `金额 渠道 物品` |
| Compound expense | `**88 … + 35 …**` | two expense records |
| Background task | `>>洗衣机` … `<<洗衣机` | a `background` block (attention-time only) |
| Image / attachment | `![[booklist-ui.png]]` | added to that block's `attachments` |
| Presence (companion) | `和同学汇合` … `一起回去` (Wed) | a `presence` span; activities inside still classify by activity |
| Cross-midnight | `01:20 …搞到现在` (Sat) continues Fri's crunch | a `前一天 HH:MM:SS` block on the next day |
| Income | `**300 学校 助教兼职工资**` | an expense with `type: 收入` |
| Free / no spend | `自己煮了点面…省钱` | a block, no expense |

## How a line maps to the taxonomy

`categories.json` has two trees — `time_categories` (for blocks) and
`expense_categories` (for spending). A few examples from the week:

- `09:40:20 开始定大作业选题…` → time `学习工作 / 项目` (project-typed → `proj: 二手书网站`)
- `13:50:22 写算法课作业` → time `学习工作 / 作业`
- `17:40:33 去操场跑了个步` → time `健康 / 跑步`
- `09:00:33 …丢进洗衣机 >>洗衣机` → time `生活 / 洗衣晾衣` (background)
- `**16 一点点 葡萄冰茶**` → expense `食物 / 奶茶`, channel `一点点`
- `**52 网上书店 数据库系统概念教材**` → expense `学习 / 书籍`
- `**300 学校 助教兼职工资**` → expense `劳动 / 兼职`, `type: 收入`

Label vocabularies keep stats clean: every block of project work snaps to the
`项目` label under `学习工作`, so "project time" aggregates correctly across the
week regardless of how each step is worded — which is what makes the
phase-by-phase progress legible.
