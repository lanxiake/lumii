# 实施计划目录

本目录存放**实施计划**与**交付记录**。设计文档在 [`../design/`](../design/)，实施总结在 [`../implementation/`](../implementation/)。文档产出规范见 [`../README.md`](../README.md)。

## 领域子目录

按主题成组的多阶段工作，各自有 `README.md` 作索引：

| 子目录 | 主题 | 状态 |
| --- | --- | --- |
| [`专项Agent/`](专项Agent/README.md) | 一等公民专项 Agent：运行时贯通、code-dev 闭环、团队转正、队长制、委托可见性、项目/渠道路由、记忆积累 | 进行中（最活跃） |
| [`记忆重构/`](记忆重构/README.md) | 记忆 P0、Wiki P0→P3、主题层级、知识图谱、Vault、智能资料库 P1–P7、库级迁移 | 已完成 |
| [`AGENT优化/`](AGENT优化/README.md) | 子 Agent 协作、Tooling 提示词重构、提示词风格实验 P1–P3 | 部分进行中 |
| [`AGENT自我进化/`](AGENT自我进化/README.md) | 自主进化 Agent 的 P0–P3 实施 + 心跳 + 主动式规划 | P0–P2 完成，P3 部分 |
| [`客户端优化/`](客户端优化/README.md) | renderer 纵向切片优化（样式地基、组件收敛、Wiki 样式、ChatPage 结构、数据层、虚拟化） | 6 片全部完成 |
| [`数据同步功能/`](数据同步功能/README.md) | 云同步三代方案（workspace → 精简多设备 → 轻量 JSONL） | v3 实施中 |
| [`代码重构瘦身/`](代码重构瘦身/README.md) | 全仓重构：清理死代码、立门禁、抽象收敛、拆大文件（含已完成的 Gateway 遗留代码分析） | 批次 0/1 完成，2/3 未开始 |
| [`大文件重构分析处理/`](大文件重构分析处理/README.md) | >400 行文件的分级索引与拆分方案（与上者同主题，互为前后代） | 部分完成 |
| [`性能优化/`](性能优化/) | 性能监控与调用耗时统计（含实现契约约束） | 已实施 |
| [`客户端解耦/`](客户端解耦/README.md) | 让 `agent-runtime` 脱离 Electron 宿主复用（为移动端/macOS 铺路） | 已立项，暂缓启动 |

## 根目录文档（按主题）

### 语音与 TTS

| 文档 | 说明 |
| --- | --- |
| [`2026-08-07-qwen3-tts-voice-clone-design.md`](2026-08-07-qwen3-tts-voice-clone-design.md) + [`-implementation.md`](2026-08-07-qwen3-tts-implementation.md) | Qwen3-TTS 声纹克隆 |
| [`2026-08-07-splash-and-voice-settings-design.md`](2026-08-07-splash-and-voice-settings-design.md) | 启动页与语音设置 |
| [`2026-08-08-voice-clone-mic-record-design.md`](2026-08-08-voice-clone-mic-record-design.md) + [`-implementation.md`](2026-08-08-voice-clone-mic-record-implementation.md) | 麦克风录制声纹样本 |
| [`2026-08-08-voice-settings-asr-uninstall-design.md`](2026-08-08-voice-settings-asr-uninstall-design.md) + [`-implementation.md`](2026-08-08-voice-settings-asr-uninstall-implementation.md) | ASR 模型卸载 |
| [`2026-08-08-qwen3-tts-cuda-graph-perf-notes.md`](2026-08-08-qwen3-tts-cuda-graph-perf-notes.md) | CUDA Graph 性能复盘（非计划类，学习笔记） |

### 录屏与教程流水线

| 文档 | 说明 |
| --- | --- |
| [`2026-08-15-screen-record-implementation.md`](2026-08-15-screen-record-implementation.md) | 录屏模块 |
| [`2026-08-15-screen-record-phase2-implementation.md`](2026-08-15-screen-record-phase2-implementation.md) | 录屏 Phase 2 |
| [`2026-08-15-screen-record-subtitle-editor-implementation.md`](2026-08-15-screen-record-subtitle-editor-implementation.md) | 字幕编辑器 |
| [`2026-08-16-agent-tutorial-recording-optimization-implementation.md`](2026-08-16-agent-tutorial-recording-optimization-implementation.md) | 教程录制优化 |
| [`2026-08-16-screen-record-tutorial-pipeline-implementation.md`](2026-08-16-screen-record-tutorial-pipeline-implementation.md) | 教程流水线 |

### 上下文压缩与模型成本

| 文档 | 说明 |
| --- | --- |
| [`2026-08-18-context-compression-phase1-implementation.md`](2026-08-18-context-compression-phase1-implementation.md) ～ [`phase3`](2026-08-18-context-compression-phase3-implementation.md) | 三层压缩引擎的三期实施（设计见 [`../design/2026-08-18-context-compression-multi-layer-engine.md`](../design/2026-08-18-context-compression-multi-layer-engine.md)） |
| [`2026-08-23-small-model-context-budget.md`](2026-08-23-small-model-context-budget.md) | 小模型上下文预算 |
| [`2026-09-15-memory-extraction-and-prompt-cost-implementation.md`](2026-09-15-memory-extraction-and-prompt-cost-implementation.md) | 记忆提取与提示词成本 |

### 客户端 UI 与工作台

| 文档 | 说明 |
| --- | --- |
| [`2026-08-04-lumii-logo-slots-workspace.md`](2026-08-04-lumii-logo-slots-workspace.md) + [`-design.md`](2026-08-04-lumii-logo-slots-workspace-design.md) | Logo 位与工作区 |
| [`2026-08-05-ui-tech-refresh-client-implementation.md`](2026-08-05-ui-tech-refresh-client-implementation.md) | UI 技术栈刷新 |
| [`2026-08-06-composer-plus-menu-design.md`](2026-08-06-composer-plus-menu-design.md) + [`-implementation.md`](2026-08-06-composer-plus-menu-implementation.md) | Composer Plus 菜单 |
| [`2026-08-06-workspace-workbench-design.md`](2026-08-06-workspace-workbench-design.md) + [`-implementation.md`](2026-08-06-workspace-workbench-implementation.md) | 工作区工作台 |
| [`2026-08-08-chat-timeline-file-changes-design.md`](2026-08-08-chat-timeline-file-changes-design.md) + [`-implementation.md`](2026-08-08-chat-timeline-file-changes-implementation.md) + [`-handoff.md`](2026-08-08-chat-timeline-file-changes-handoff.md) | 对话时间线文件变更 |
| [`2026-08-08-multimedia-preview-streaming-design.md`](2026-08-08-multimedia-preview-streaming-design.md) | 多媒体预览与流式 |
| [`2026-09-06-session-list-ui-design.md`](2026-09-06-session-list-ui-design.md) + [`-implementation.md`](2026-09-06-session-list-ui-implementation.md) | 会话列表 UI |
| [`2026-09-13-experimental-features-ui-redesign.md`](2026-09-13-experimental-features-ui-redesign.md) | 实验性功能 UI 改版 |

### 渠道、CLI 与路由

| 文档 | 说明 |
| --- | --- |
| [`2026-08-04-acp-channels-design.md`](2026-08-04-acp-channels-design.md) | ACP 渠道设计 |
| [`2026-08-14-channel-outbound-hub-implementation.md`](2026-08-14-channel-outbound-hub-implementation.md) | 渠道出站中枢 |
| [`2026-08-15-cli-unified-control-plane-implementation.md`](2026-08-15-cli-unified-control-plane-implementation.md) | CLI 统一控制面 |
| [`2026-08-19-stats-channel-diagnostics-design.md`](2026-08-19-stats-channel-diagnostics-design.md) | 统计与渠道诊断（设计与实施计划合并成篇） |
| [`2026-09-10-user-presence-channel-implementation.md`](2026-09-10-user-presence-channel-implementation.md) | 用户在场与渠道（设计见 [`../design/2026-09-09-user-presence-channel-design.md`](../design/2026-09-09-user-presence-channel-design.md)） |

### Agent 能力与工程基建

| 文档 | 说明 |
| --- | --- |
| [`2026-08-10-project-git-integration-design.md`](2026-08-10-project-git-integration-design.md) + [`-implementation.md`](2026-08-10-project-git-integration-implementation.md) | 项目 Git 集成 |
| [`2026-08-14-agent-app-ui-control-implementation.md`](2026-08-14-agent-app-ui-control-implementation.md) | Agent 应用 UI 自动化 |
| [`2026-08-21-typecheck-baseline-and-cron-implementation.md`](2026-08-21-typecheck-baseline-and-cron-implementation.md) | typecheck 基线 + cron（设计见 [`../design/2026-08-21-typecheck-baseline-and-cron-design.md`](../design/2026-08-21-typecheck-baseline-and-cron-design.md)） |
| [`2026-09-06-autonomous-proactive-planning-design.md`](2026-09-06-autonomous-proactive-planning-design.md) + [`-implementation.md`](2026-09-06-autonomous-proactive-planning-implementation.md) | 主动式规划 |
| [`2026-09-08-bash-命令工具进化-design.md`](2026-09-08-bash-命令工具进化-design.md) | Bash 命令工具进化（状态：已实现 M1/M2/M3） |

## 维护须知

- 新增领域子目录时，在本文件「领域子目录」表中登记一行，并在该子目录内建 `README.md`。
- 计划文档完成后，在文首更新状态行（已完成 / 部分完成 / 已结案），便于后来者判断是否还需要读。
- 已被取代的早期草稿应删除并在新文档中注明「本计划已并入/取代 XXX」，不要留下两份内容重叠的计划。
