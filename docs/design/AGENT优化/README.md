# AGENT / 子 AGENT 优化

本目录存放对照外部架构（Hermes-Agent MOA）与 Lumii 现有 Agent/子 Agent 设计的分析与优化方案。

| 文档 | 说明 |
|------|------|
| [2026-08-26-hermes-moa-vs-lumii-对比与优化.md](./2026-08-26-hermes-moa-vs-lumii-对比与优化.md) | 四层协作对照、差距清单、分阶段优化方案与非目标 |
| [P0+P1 实施计划](../../plans/AGENT优化/2026-08-26-agent-subagent-p0p1-implementation.md) | 异步投递 / 深度并发 / 生命周期 / stale / 摘要护栏代码计划 |

**实施状态（2026-08-26）：** P0/P1 计划已输出；分支 `feat/agent-subagent-p0p1` 已落地 P0（异步完成投递、深度=1、并发帽、提示词诚实化）与 P1（生命周期 API、stale、摘要护栏、allowedTools 校验、IPC `agent:subagent:completed`）。不含 worktree / MOA / 嵌套深度>1（P2+）。

**对照源**：`E:\open-source-project\hermes-agent\docs\MOA-Agent-Architecture-Guide.md`（v1.1）

**Lumii 主要锚点**：

- `packages/agent-runtime/src/agent/orchestrator.ts`
- `packages/agent-runtime/src/agent/subagent-broker.ts`
- `packages/agent-runtime/src/agent/subagent-summary.ts`
- `packages/agent-runtime/src/tools/built-in/spawn-agent-tool.ts`
- `packages/agent-runtime/src/agent/builtin/definitions.ts`
- `apps/windows/src/main/agent-runtime/bridge-lifecycle.ts`
- `apps/windows/src/main/agent-runtime/subagent-delivery.ts`
- `apps/windows/src/main/agent-runtime/bridge-utils.ts`（`CHILD_AGENT_DISALLOWED_TOOLS`）
- `packages/agent-runtime/src/prompt/sections/agent-collaboration-section.ts`
