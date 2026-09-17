# 设计文档目录

本目录存放**设计文档**（决策"做什么、为什么这样做"）。实施计划在 [`../plans/`](../plans/)，实施总结在 [`../implementation/`](../implementation/)。命名规范见 [`../README.md`](../README.md)。

## 领域子目录

| 子目录 | 主题 |
| --- | --- |
| [`记忆设计/`](记忆设计/) | 记忆系统与 Wiki 知识库的设计正本（含 11 份开源项目参考解构） |
| [`自主进化Agent/`](自主进化Agent/README.md) | 自主进化 Agent：核心设计 1–11 篇 + P1 实施档案 + 前端可视化 |
| [`AGENT优化/`](AGENT优化/README.md) | Agent 协作与提示词优化的对比分析与方案 |
| [`数据同步功能/`](数据同步功能/) | 云同步三代方案的设计（v1 workspace → v2 精简多设备 → v3 轻量 JSONL） |
| [`专项AGENT/`](专项AGENT/) | 一等公民专项 Agent 的总体设计（v3.1） |
| [`性能优化/`](性能优化/) | 性能监控与调用耗时统计方案 |
| [`Linux客户端移植/`](Linux客户端移植/) | Linux 与无头部署调查分析 |

## 根目录文档

### 客户端界面

| 文档 | 说明 |
| --- | --- |
| [`2026-08-13-agent-app-ui-control-design.md`](2026-08-13-agent-app-ui-control-design.md) | Agent 应用 UI 自动化控制 |
| [`2026-08-15-cli-hub-external-software-design.md`](2026-08-15-cli-hub-external-software-design.md) | CLI Hub 外部软件接入 |
| [`2026-09-13-chat-sidebar-group-actions-design.md`](2026-09-13-chat-sidebar-group-actions-design.md) | 聊天侧栏分组操作收敛为单一菜单 |
| [`2026-09-13-experimental-features-ui-redesign.md`](2026-09-13-experimental-features-ui-redesign.md) | 实验性功能设置区改版 |

### 渠道与在场

| 文档 | 说明 |
| --- | --- |
| [`2026-08-14-channel-outbound-hub-design.md`](2026-08-14-channel-outbound-hub-design.md) | 渠道出站中枢 |
| [`2026-09-09-user-presence-channel-design.md`](2026-09-09-user-presence-channel-design.md) | 用户在场与渠道设计 |

### 录屏与教程

| 文档 | 说明 |
| --- | --- |
| [`2026-08-15-screen-record-design.md`](2026-08-15-screen-record-design.md) | 屏幕录制 |
| [`2026-08-15-screen-record-phase2-design.md`](2026-08-15-screen-record-phase2-design.md) | 录屏 Phase 2 |
| [`2026-08-15-screen-record-subtitle-editor-design.md`](2026-08-15-screen-record-subtitle-editor-design.md) | 字幕编辑器 |
| [`2026-08-16-screen-record-tutorial-pipeline-design.md`](2026-08-16-screen-record-tutorial-pipeline-design.md) | 教程流水线 |
| [`2026-08-16-agent-tutorial-recording-optimization-design.md`](2026-08-16-agent-tutorial-recording-optimization-design.md) | 教程录制优化 |

### 上下文与工程基建

| 文档 | 说明 |
| --- | --- |
| [`2026-08-18-context-compression-multi-layer-engine.md`](2026-08-18-context-compression-multi-layer-engine.md) | 上下文压缩多层化引擎（v2.0，逐行代码对比） |
| [`2026-08-21-typecheck-baseline-and-cron-design.md`](2026-08-21-typecheck-baseline-and-cron-design.md) | typecheck 基线 + cron 定时任务 |

## 相关约定

- 设计文档的必填章节（结论摘要、方案对比、核心设计、安全风险、分期与退出标准等）见 [`../wiki/05-implementation/01-开发流程与规范.md`](../wiki/05-implementation/01-开发流程与规范.md) §1.2。
- 部分早期设计文档位于 [`../plans/`](../plans/) 根目录（2026-08-04 ～ 08-10 期间设计与计划同放 plans）；2026-08-13 之后设计统一落在本目录。
