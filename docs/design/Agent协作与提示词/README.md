# Agent 协作与提示词 · 设计

> 原名 `AGENT优化/`，2026-09-17 改名——它实际的内容是「子 Agent 协作 + 提示词优化」，与 [`../自主进化Agent/`](../自主进化Agent/)、[`../专项Agent/`](../专项Agent/) 并列时原名太泛，容易混。

子 Agent 协作、提示词优化与 Bash 工具进化的设计。实施计划见 [`../../plans/Agent协作与提示词/`](../../plans/Agent协作与提示词/)。

## 子 Agent 协作

对照外部架构（Hermes-Agent MOA）与 Lumii 现有设计的分析，按代际排列：

| 文档 | 说明 |
| --- | --- |
| [`2026-08-26-hermes-moa-对比分析.md`](2026-08-26-hermes-moa-对比分析.md) | ① 对照分析草稿：Hermes MOA 四层架构解构 |
| [`2026-08-26-lumii-agent-优化方案.md`](2026-08-26-lumii-agent-优化方案.md) | ② 优化方案草案：配置面草案、成功标准、整合矩阵、不建议照搬的部分 |
| [`2026-08-26-hermes-moa-vs-lumii-对比与优化.md`](2026-08-26-hermes-moa-vs-lumii-对比与优化.md) | ③ **整合定稿**（v1.0）：覆盖 ①② 主体（四层协作对照、差距清单、分阶段方案与非目标）。**先读此篇**；①② 保留作代际存档 |

**对照源**：`E:\open-source-project\hermes-agent\docs\MOA-Agent-Architecture-Guide.md`（v1.1，外部路径）

**Lumii 主要锚点**：`packages/agent-runtime/src/agent/{orchestrator,subagent-broker,subagent-summary}.ts`、`tools/built-in/spawn-agent-tool.ts`、`apps/windows/src/main/agent-runtime/{bridge-lifecycle,subagent-delivery,bridge-utils}.ts`

## 提示词优化

| 文档 | 说明 |
| --- | --- |
| [`2026-09-13-提示词风格实验设计.md`](2026-09-13-提示词风格实验设计.md) | 全局两态风格（简要/详细）、段注册表与渐进加载、`prompt_guide` 展开、移除旧 tier 详度调度 |

## 工具进化

| 文档 | 说明 |
| --- | --- |
| [`2026-09-08-Bash命令工具进化设计.md`](2026-09-08-Bash命令工具进化设计.md) | Bash 命令工具进化闭环：M1 采集挖掘 / M2 草拟审批注册 / M3 每日调度（**已实现**） |
