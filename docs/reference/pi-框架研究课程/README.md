# Pi 框架研究课程

对 [earendil-works/pi](https://github.com/earendil-works/pi)（前身 badlogic/pi-mono，作者 Mario Zechner / badlogic）的源码级研究课程。
共 9 篇研究文章 + 每篇配套的可运行实验代码（零依赖 Node，无需 API key）。

快照日期：2026-09-23（v0.87.1，6,505 commits，319 releases）。

## 你将搞清楚的问题

- 一个"反 Claude Code"的极简 coding agent，是怎么从 2025-08 的 4 人周项目长成 109k star 的 agent 平台的？
- 为什么 pi-ai 说"世界上只有 4 种 LLM API"？统一抽象的边界在哪里？
- agent loop、事件流、会话树、compaction 这些"coding agent 的隐形基础设施"，pi 的最小可用实现是什么？
- 为什么 pi 拒绝 MCP、plan mode、to-dos、sub-agents？这些取舍有数据支撑吗？
- 终端 UI 为什么会闪烁？pi-tui 的差分渲染 + CSI 2026 怎么解决？
- 2026 年 pi 为什么长出了 chord / protocol / server / telemetry / durable(Pico)？一个 CLI 走向"持久分布式运行时"的路径说明了什么？

## 目录

| # | 文章 | 核心内容 | 实验代码 |
|---|------|----------|----------|
| 01 | [起源、发展历程与设计哲学](articles/01-起源发展历程与设计哲学.md) | badlogic 的动机、时间线、提交考古、"不需要就不做" | git 历史挖掘脚本、仓库结构测绘 |
| 02 | [pi-ai：统一 LLM API](articles/02-pi-ai统一LLM-API.md) | 四种 API 收敛、provider 怪癖矩阵、事件流与 abort、跨模型 handoff | faux provider 协议服务器、事件流 recorder |
| 03 | [pi-agent-core：agent loop 与事件流](articles/03-agent-core-agent-loop.md) | Agent 状态机、AgentMessage 分层、工具执行与校验、steering | 从零手写 200 行 agent loop |
| 04 | [pi-coding-agent：harness 架构与极简主义论战](articles/04-coding-agent-harness与极简主义.md) | how-pi-works、最小系统提示词与工具集、no-MCP/no-plan-mode 论证、YOLO 与容器化 | 工具 schema token 对比器、系统提示词清点 |
| 05 | [会话与上下文工程](articles/05-会话树与上下文工程.md) | JSONL 会话树、分支/fork、compaction 与 branch summary、skills 渐进加载 | 会话树解析器 + ASCII 渲染、玩具 compactor |
| 06 | [pi-tui：终端 UI 引擎](articles/06-pi-tui差分渲染终端UI.md) | retained mode、差分渲染、CSI 2026 同步输出、编辑器与补全 | 迷你差分渲染器、终端事件探针 |
| 07 | [扩展系统：Extensions、SDK 与 RPC](articles/07-扩展系统-SDK-RPC.md) | ExtensionAPI、事件钩子、prompt 模板、SDK 与 RPC JSONL 协议、分发模型 | RPC 协议驱动 mock、扩展示例与 skill 包 |
| 08 | [平台化转向：protocol、server、telemetry 与 Chord](articles/08-平台化转向-chord-protocol-telemetry.md) | 2026 新包动机、facets/services、复制状态、厂商中立遥测 | 迷你 facet/service 容器、协议消息检查器 |
| 09 | [durable 运行时（Pico）与技术演进总结](articles/09-durable运行时Pico与演进总结.md) | harness.md 规范、entry tree/values/lanes、恢复与中断、演进路线图复盘 | 崩溃可恢复的 JSONL 事件存储 |

## 使用方式

1. 按序读文章；每篇末尾"实验"一节对应 `code/NN/`，`node xxx.mjs` 直接跑。
2. 想对照源码：本地克隆 `git clone --filter=blob:none https://github.com/earendil-works/pi`，文章中的路径都相对仓库根。
3. 实验全部零依赖（Node ≥ 20.6），不需要任何 API key；涉及真实 provider 的片段会单独标注。

## 免责

本课程为独立研究资料，与 Earendil Works 无关联。事实快照截至 2026-09-23，pi 迭代很快，以上游为准。
