# 03. 架构设计

## 简介

架构设计是软件工程中决定系统长期可维护性与演进能力的关键环节。本章节深入剖析 Lumii 的系统架构，从分层结构、模块边界、核心设计决策（ADR）到关键技术选型的权衡过程，完整呈现大型 Electron + TypeScript 桌面应用的架构蓝图。章节重点解释「为什么这样设计」而非仅仅「设计成什么样」，记录了架构师在面对性能、可扩展性、开发效率等多维度约束时的取舍思路。

Lumii 的架构涉及 Electron 主进程与渲染进程的双进程模型、Agent Runtime 通用逻辑与平台专属逻辑的隔离、纯 TypeScript 核心库（pet-core）的无依赖设计、向量数据库与关系型存储的混合使用、MCP 协议网关等多个复杂子系统。本章节通过架构图、模块依赖分析、数据流追踪等方式，帮助读者建立系统级的全局视野，为后续深入模块设计与编码实现奠定架构认知基础。

## 文档索引

| 文件名 | 说明 | 状态 |
|--------|------|------|
| [01-整体架构设计.md](./01-整体架构设计.md) | 四层架构图、各层职责、数据流向时序图、六大架构设计原则 | ✅ 已创建 |
| [02-项目结构与模块划分.md](./02-项目结构与模块划分.md) | 根目录结构、三层进程目录树、组件三类分工、agent-runtime 子模块全景、依赖关系图 | ✅ 已创建 |
| [04-双连接架构说明.md](./04-双连接架构说明.md) | UI/Node 双连接定义、使用场景状态机、连接协调器职责、双Token认证、设备配对流程 | ✅ 已创建 |

## 现有源文档交叉引用

- 双重连接架构：[`../standards/dual-connection-architecture.md`](../../standards/dual-connection-architecture.md) — 官方规范中的架构模式说明
- 项目结构规范：[`../standards/project-structure.md`](../../standards/project-structure.md) — 目录与模块划分的官方标准
- 自主进化 Agent 核心设计：[`../design/自主进化Agent/1-核心设计理念.md`](../../design/自主进化Agent/1-核心设计理念.md) — AI Agent 子系统的架构设计起点
- 多设备数据同步策略：[`../../analysis/2026-09-07-multi-device-data-sync-strategy.md`](../../analysis/2026-09-07-multi-device-data-sync-strategy.md) — 同步子系统的架构选型分析
- Hermes MOA 对比分析：[`../design/AGENT优化/2026-08-26-hermes-moa-对比分析.md`](../../design/AGENT优化/2026-08-26-hermes-moa-对比分析.md) — Agent 架构的对比研究
