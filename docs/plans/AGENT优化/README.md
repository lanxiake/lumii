# AGENT / 子 AGENT 优化 — 实施计划目录

设计来源：[`docs/design/AGENT优化/2026-08-26-hermes-moa-vs-lumii-对比与优化.md`](../../design/AGENT优化/2026-08-26-hermes-moa-vs-lumii-对比与优化.md)

| 文档 | 范围 | 说明 |
|------|------|------|
| [2026-08-26-agent-subagent-p0p1-implementation.md](./2026-08-26-agent-subagent-p0p1-implementation.md) | P0 + P1 | 子 Agent 协作代码实施计划 |
| [2026-08-28-tooling-prompt-refactor-implementation.md](./2026-08-28-tooling-prompt-refactor-implementation.md) | P0 / P1 / P2 | Tooling 提示词重构：修漂移、压冗余、注册表驱动分组 |
| [2026-09-13-prompt-style-experiment-implementation.md](./2026-09-13-prompt-style-experiment-implementation.md) | P0 / P1（P2 另开） | 提示词风格实验：全局两态风格、段元数据与计量、prompt_guide、移除旧 tier 详度调度 |
| [2026-09-13-prompt-style-experiment-p2-implementation.md](./2026-09-13-prompt-style-experiment-p2-implementation.md) | P2 | terse 极致覆盖 + 五块结构重排 + Router 静态过滤缓存修复 |
| [2026-09-15-prompt-style-minimal-mode-plan.md](./2026-09-15-prompt-style-minimal-mode-plan.md) | P3 | 极简档：工具定义载荷去描述（复杂工具保留）+ 提示词 MCP/Workspace 等收尾 |

**子 Agent 协作不在本阶段**：P2 worktree / orchestrator 嵌套、P3 MOA、跨进程 SQLite 委派恢复。

**Tooling 重构不在本阶段**：schema 按需加载、`ToolCategory` 语义重构、browser snapshot 能力补全。
