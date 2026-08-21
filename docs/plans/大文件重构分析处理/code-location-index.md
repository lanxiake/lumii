# 大文件重构 — 代码位置索引

> 核对时间：2026-08-21
> 核对分支：`main`
> 核对提交：`222fbf554faa7ec8c132366548f6eee2cbca3a2c`
> 完整列出当前分支所有 **>400 行** 的 104 个文件（有效行数：非空物理行）
> 分级：P0（立即）/ P1（计划）/ P2（观察）/ P3（测试/常量暂放）

---

## 目录

1. [P0 级 — >1500 行（6 个）](#p0-级--1500-行6-个)
2. [P1 级 — 800–1500 行（17 个）](#p1-级--8001500-行17-个)
3. [P2 级 — 500–800 行（42 个）](#p2-级--500800-行42-个)
4. [P3 级 — 400–500 行，测试/纯常量暂放（39 个）](#p3-级--400500-行测试纯常量暂放39-个)
5. [超警戒函数索引（>120 行函数清单）](#超警戒函数索引120-行函数清单)

---

## P0 级 — >1500 行（6 个）

### P0-01
| 项目 | 内容 |
|---|---|
| **文件** | [index.ts](../../../apps/windows/src/main/index.ts) |
| **有效行数** | 2980 |
| **类别** | 主进程入口（服务装配） |
| **警戒阈值** | 300 行（观察信号，不作为硬门禁） |
| **主要问题** | 窗口、托盘、普通 IPC、渠道、语音、录屏及服务初始化仍集中在入口；Agent Runtime command IPC 已有独立模块；初始化顺序是功能契约 |
| **拆分建议** | 先按现有目录边界提取 `window` / `tray` / `ipc` / `coding-dev` 等模块，入口保留 composition root；仅在真实重复或依赖边界清晰时增加 bootstrap 文件 |
| **预计拆后文件数** | 不预设文件数量；以初始化顺序、依赖方向和行为测试为准 |

### P0-02
| 项目 | 内容 |
|---|---|
| **文件** | [SettingsPage.tsx](../../../apps/windows/src/renderer/pages/SettingsPage/SettingsPage.tsx) |
| **有效行数** | 2447 |
| **类别** | 页面组件 `.tsx` |
| **警戒阈值** | 500 行（观察信号，不作为硬门禁） |
| **主要问题** | 多个分类渲染函数、模型配置状态与保存逻辑集中在页面；但 Channels、Coding Dev ACP、Voice、Usage、Security、Storage 等子组件已经存在 |
| **拆分建议** | 优先复用现有子组件；仅把仍内联且有独立状态/副作用边界的分类提取为 `*Section.tsx`，模型配置 hook 需先确认状态是否被多个视图共享 |
| **预计拆后文件数** | 不预设文件数量；保留页面路由和分类切换行为不变 |

### P0-03
| 项目 | 内容 |
|---|---|
| **文件** | [agent-runtime-ipc.ts](../../../apps/windows/src/main/ipc/agent-runtime-ipc.ts) |
| **有效行数** | 2382 |
| **类别** | IPC Handler 层 |
| **警戒阈值** | 450 行（观察信号，不作为硬门禁） |
| **主要问题** | 当前通过单一 `agent-runtime:command` channel 接收类型化命令，再由 command handler 分发；共享状态、结果封装和兼容导出仍集中 |
| **拆分建议** | 保留单一 channel 与共享注册模块；按现有命令域拆 `conversation` / `agent` / `memory` / `tool` / `scheduler` handler，使用显式 dispatcher 聚合，不改协议和错误语义 |
| **预计拆后文件数** | 按实际命令域确定，不预设 10 个文件或单文件行数 |

### P0-04
| 项目 | 内容 |
|---|---|
| **文件** | [system-prompt-builder.ts](../../../packages/agent-runtime/src/prompt/system-prompt-builder.ts) |
| **有效行数** | 1909 |
| **类别** | 业务核心：Prompt 构建 |
| **警戒阈值** | 450 行（观察信号，不作为硬门禁） |
| **主要问题** | 多个 prompt section、格式化逻辑和类型集中在一个 builder；实际入口包含 `buildProgressiveLoadingSection`、`buildSkillsSection` 等明确 section 边界 |
| **拆分建议** | 先为已核实的 skills、runtime、memory、workspace 等 section 建立纯函数模块；保留主入口负责顺序编排，只有确有共享类型时才抽 `prompt.types.ts` |
| **预计拆后文件数** | 按 section 边界渐进拆分，不预设文件数量；先用快照/顺序测试保护输出 |

### P0-05
| 项目 | 内容 |
|---|---|
| **文件** | [index.ts](../../../apps/windows/src/preload/index.ts) |
| **有效行数** | 1913 |
| **类别** | Preload 桥接脚本 |
| **警戒阈值** | 450 行（观察信号，不作为硬门禁） |
| **主要问题** | ElectronAPI 类型、实现对象、事件监听和外部服务暴露仍集中在 preload；已有 `pet-api.ts` 等能力模块可复用 |
| **拆分建议** | 按现有 API 能力提取 `file` / `channel` / `skills` / `app` 等模块；保留 index 聚合和 `exposeInMainWorld`，不预先拆固定数量的 event-mux |
| **预计拆后文件数** | 按重复度和 API 边界确定；必须保持 `electronAPI`、全局服务和 `global.d.ts` 类型契约 |

### P0-06
| 项目 | 内容 |
|---|---|
| **文件** | [ChatPage.tsx](../../../apps/windows/src/renderer/pages/ChatPage/ChatPage.tsx) |
| **有效行数** | 1755 |
| **类别** | 页面组件 `.tsx` |
| **警戒阈值** | 500 行 → 超标 **3.5 倍** |
| **主要问题** | 会话列表 + 消息渲染 + 输入框 + 工作空间面板 + 语音通话 + 版本控制 全部一个组件；30+ hooks |
| **拆分建议** | 复用现有 ChatSidebar、ChatContainer、ChatInput、WorkspaceFilePanel、WorkspaceVersionPanel 等组件；优先提取真实的 hook/副作用边界，主组件保留页面编排 |
| **预计拆后文件数** | 不预设文件数量；以发送、会话、面板、语音和版本控制行为测试为准 |

---

## P1 级 — 800–1500 行（17 个）

### P1-01
| 项目 | 内容 |
|---|---|
| **文件** | [bridge-tool-registrar.ts](../../../apps/windows/src/main/agent-runtime/bridge-tool-registrar.ts) |
| **有效行数** | 1488 |
| **类别** | Agent Bridge（工具注册） |
| **建议上限** | 450 行（service 层） |
| **主要问题** | 工具注册、参数适配和部分具体实现集中；需先区分注册层与已有 bridge/tool 实现的职责边界 |
| **拆分建议** | 按实际工具域提取注册函数，复用现有 `bridge-*` 和工具实现；保留一个显式 registrar 聚合入口，不为每个工具预建抽象层 |
| **验收** | 工具名称、参数校验、权限、异常和返回值不变；注册顺序及 Agent Runtime 可见工具集合保持一致 |

### P1-02
| 项目 | 内容 |
|---|---|
| **文件** | [bridge.ts](../../../apps/windows/src/main/agent-runtime/bridge.ts) |
| **有效行数** | 1483 |
| **类别** | Agent Bridge 主类 |
| **主要问题** | 单 class 负责 bridge 协调，但生命周期、实例创建、工具注册、prompt 派发和状态模块已经拆到相邻文件 |
| **拆分建议** | 不重复创建 facade、pool 或 factory；仅在现有模块边界仍有真实重复时提取协调逻辑，主类继续作为组合入口 |

### P1-03
| 项目 | 内容 |
|---|---|
| **文件** | [event-handler.ts](../../../apps/windows/src/renderer/hooks/business/useAgentRuntime/event-handler.ts) |
| **有效行数** | 1409 |
| **类别** | Hooks 业务层 |
| **主要问题** | 事件分发同时更新 UI 状态、存储和副作用；switch 本身是类型穷举边界，不应为追求文件数机械改成 registry |
| **拆分建议** | 先保持显式穷举 dispatcher；仅把纯粹且稳定的 domain handler 提取到 `tool` / `message` / `compact` 等文件，并通过原有上下文注入副作用 |

### P1-04
| 项目 | 内容 |
|---|---|
| **文件** | [model-manager.ts](../../../apps/windows/src/main/voice/model-manager.ts) |
| **有效行数** | 1370 |
| **类别** | 语音（模型管理） |
| **主要问题** | 模型下载 + 校验 + 索引 + 设备检测 + 加载状态机 混杂；单个下载流程 >300 行 |
| **拆分建议** | `voice/model-downloader.ts` / `voice/model-index.ts` / `voice/model-device-detector.ts` / `voice/model-loader-state.ts` |

### P1-05
| 项目 | 内容 |
|---|---|
| **文件** | [voice-service.ts](../../../apps/windows/src/main/voice/voice-service.ts) |
| **有效行数** | 1345 |
| **类别** | 语音服务主类 |
| **主要问题** | VAD + ASR + TTS 队列 + 状态机 + AgentRuntime 对接 全部一个类；单 `handleAsrResult` >180 行 |
| **拆分建议** | 先沿已有 `vad-engine` / `asr-engine` / `tts-engine` / state machine 边界检查重复；只有跨职责方法仍明显过长时才提取 handler，避免重复包装已有服务 |

### P1-06
| 项目 | 内容 |
|---|---|
| **文件** | [AgentsPage.tsx](../../../apps/windows/src/renderer/pages/AgentsPage/AgentsPage.tsx) |
| **有效行数** | 1296 |
| **类别** | 页面组件 `.tsx` |
| **主要问题** | 3 种视图（Grid/Map/Feed）+ 2 个 wizard + 能力配置面板 inline；CAPABILITY_OPTIONS 常量 >150 行 |
| **拆分建议** | 抽 `AgentEditor.tsx`（含能力配置 300+ 行）/ `CapabilityConfigPanel.tsx`；常量抽 `AgentsPage.const.ts` |

### P1-07
| 项目 | 内容 |
|---|---|
| **文件** | [weixin-login-service.ts](../../../apps/windows/src/main/weixin-login-service.ts) |
| **有效行数** | 1272 |
| **类别** | 渠道服务（微信） |
| **主要问题** | 登录流程、二维码、会话存储、消息收发和 API 封装集中在一个类；应按实际职责边界拆分，不能按推断函数名设计 |
| **拆分建议** | `channel/weixin/weixin-login-flow.ts` / `weixin-session-store.ts` / `weixin-message-sender.ts` / `weixin-qrcode-handler.ts` |

### P1-08
| 项目 | 内容 |
|---|---|
| **文件** | [controller.ts](../../../apps/windows/src/main/app-ui-control/controller.ts) |
| **有效行数** | 1217 |
| **类别** | UI 控制服务 |
| **主要问题** | 截图、OCR、窗口操作、DOM 点击、键盘输入和视觉定位集中在一个控制器；应以实际 `screenshot` 入口及其调用边界设计拆分 |
| **拆分建议** | `app-ui-control/screenshot-controller.ts` / `ocr-controller.ts` / `window-controller.ts` / `dom-interactor.ts` / `visual-locator.ts` |

### P1-09
| 项目 | 内容 |
|---|---|
| **文件** | [ChatInput/index.tsx](../../../apps/windows/src/renderer/pages/ChatPage/components/ChatInput/index.tsx) |
| **有效行数** | 1187 |
| **类别** | 业务组件 `.tsx` |
| **主要问题** | 输入框 + 附件区 + 工具栏 + ComposerPlusMenu + 拖放 + 斜杠命令 混杂；`ComposerPlusMenu` 已独立但仍有 471 行 |
| **拆分建议** | 复用已有 `ComposerPlusMenu` 和 `file-attachment-strategy`；仅抽有独立状态/事件边界的附件、工具栏或命令建议逻辑，行数只作观察指标 |

### P1-10
| 项目 | 内容 |
|---|---|
| **文件** | [useAgentRuntime.ts](../../../apps/windows/src/renderer/hooks/business/useAgentRuntime/useAgentRuntime.ts) |
| **有效行数** | 1156 |
| **类别** | Hooks 业务层 |
| **建议上限** | 300 行（hooks 层） |
| **主要问题** | 20+ actions + 初始化 + 生命周期 全部一个文件；依赖 5+ 内部 handler 文件仍聚合了大量逻辑 |
| **拆分建议** | 抽 `useAgentRuntimeActions.ts` / `useAgentRuntimeInit.ts` / `useAgentRuntimeLifecycle.ts`；主 hook 只做聚合返回 |

### P1-11
| 项目 | 内容 |
|---|---|
| **文件** | [skill-runtime.ts](../../../apps/windows/src/main/skill-runtime.ts) |
| **有效行数** | 1151 |
| **类别** | 技能运行时服务 |
| **主要问题** | 执行器调度 + 权限确认 dialog + 超时控制 + 导入导出 + 日志 混杂；类型定义 >150 行 inline |
| **拆分建议** | 类型抽 `skill-runtime.types.ts`；拆 `skill-execution-scheduler.ts` / `skill-permission-dialog.ts` / `skill-import-export.ts` |

### P1-12
| 项目 | 内容 |
|---|---|
| **文件** | [ToolCallCard/index.tsx](../../../apps/windows/src/renderer/pages/ChatPage/components/ToolCallCard/index.tsx) |
| **有效行数** | 1101 |
| **类别** | 业务组件 `.tsx` |
| **主要问题** | 12+ 种工具类型的卡片渲染 inline（bash/file/web/skill/image/memory/speech/cron/dashboard…），每个 60–100 行 |
| **拆分建议** | 复用现有 `toolTaxonomy` 和已存在的 helper/component；只把有独立 UI 状态或稳定工具族边界的卡片提取，保留显式分类分发，不为每种工具预建策略注册表 |

### P1-13
| 项目 | 内容 |
|---|---|
| **文件** | [agent-runtime-commands.ts](../../../apps/windows/src/shared/agent-runtime-commands.ts) |
| **有效行数** | 1087 |
| **类别** | 共享常量（协议命令） |
| **备注** | **属「纯常量/协议」可放宽到 1500 行，但建议按 domain 聚合导出** |
| **拆分建议** | 当前文件是共享命令协议/常量，暂不为降低行数拆分；只有命令类型已形成稳定 domain 且调用方可按域导入时才增加分组 re-export |

### P1-14
| 项目 | 内容 |
|---|---|
| **文件** | [ChatMessage/index.tsx](../../../apps/windows/src/renderer/pages/ChatPage/components/ChatMessage/index.tsx) |
| **有效行数** | 1045 |
| **类别** | 业务组件 `.tsx` |
| **主要问题** | 用户/助手/系统/tool-result 4 种消息样式 + markdown 渲染 + 代码块 + 引用块 + 思考区 混杂 |
| **拆分建议** | 以现有 `buildRenderUnits` 为边界提取纯渲染单元或独立组件；保持消息分组、markdown、代码块、引用和思考区的顺序与状态，不预先创建 renderer registry |

### P1-15
| 项目 | 内容 |
|---|---|
| **文件** | [FilePreviewModal.tsx](../../../apps/windows/src/renderer/components/FilePreviewModal/FilePreviewModal.tsx) |
| **有效行数** | 980 |
| **类别** | 通用组件 `.tsx` |
| **主要问题** | 8 种预览器（image/pdf/video/audio/code/text/3d/markdown）inline；每个预览器 80–150 行 |
| **拆分建议** | 复用已有 `getPreviewRoute`、PdfJs/Excel/Pptx 等 previewer；仅将独立预览器提取到现有目录，保留当前路由匹配和兜底行为，暂不增加 registry |

### P1-16
| 项目 | 内容 |
|---|---|
| **文件** | [qwen3-tts-client.ts](../../../apps/windows/src/main/voice/qwen3-tts-client.ts) |
| **有效行数** | 944 |
| **类别** | 语音（TTS 客户端） |
| **主要问题** | 模型加载 + CUDA graph 管理 + 合成管线 + 缓存 + 预热 混杂；单 `synthesizeStream` >220 行 |
| **拆分建议** | `voice/qwen3-tts-model-loader.ts` / `qwen3-cuda-graph.ts` / `qwen3-synth-pipeline.ts` |

### P1-17
| 项目 | 内容 |
|---|---|
| **文件** | [SkillsPage.tsx](../../../apps/windows/src/renderer/pages/SkillsPage/SkillsPage.tsx) |
| **有效行数** | 942 |
| **类别** | 页面组件 `.tsx` |
| **主要问题** | 技能列表 + 搜索筛选 + 技能卡片 + 编辑器 + 导入导出向导 + 分类视图 混杂 |
| **拆分建议** | 抽 `SkillEditor.tsx`（300+ 行） / `SkillCard.tsx` / `SkillImportWizard.tsx` / `SkillsFilterBar.tsx` |

---

## P2 级 — 500–800 行（42 个）

按建议拆分优先级排序（标记 ★ 的是应优先和 P1 一起处理的）：

| # | 文件 | 行数 | 类别 | 主要问题 / 拆分建议 |
|---|---|---|---|---|
| P2-01 ★ | [screen-record-service.ts](../../../apps/windows/src/main/screen-record/screen-record-service.ts) | 929 | 录屏服务主类 | 录制流程 + 字幕烧录 + 配音 + 区域选择 + OSD 混杂；拆 `screen-record-capture.ts` / `subtitle-burner.ts` / `narrate-scheduler.ts` |
| P2-02 ★ | [PetOrchestrator.ts](../../../apps/windows/src/renderer/pet/orchestrator/PetOrchestrator.ts) | 873 | 桌宠编排器 | 状态机 + 动作策略 + 口型同步 + 事件路由；拆 `pet-state-machine.ts` / `pet-action-strategies.ts` / `pet-lip-sync-controller.ts` |
| P2-03 ★ | [conversation-repo.ts](../../../packages/agent-runtime/src/storage/conversation-repo.ts) | 858 | 数据仓库 | 纯 SQL 访问可放宽；但 50+ 方法建议按 domain 拆 `session-query.ts` / `message-crud.ts` / `compact-repo.ts` |
| P2-04 ★ | [bridge-agent-instance-events.ts](../../../apps/windows/src/main/agent-runtime/bridge-agent-instance-events.ts) | 849 | Bridge 事件 | 20+ 事件转发 handler；按事件 domain 拆 tool/message/compact 三个文件 |
| P2-05 ★ | [bridge-instance-factory.ts](../../../apps/windows/src/main/agent-runtime/bridge-instance-factory.ts) | 740 | Bridge 实例工厂 | 已是独立装配边界；先保持 factory 与现有 bridge assembler 协作，仅在某个子系统形成稳定依赖边界时提取，避免预建 5 个 assembler |
| P2-06 ★ | [cron-scheduler.ts](../../../apps/windows/src/main/agent-runtime/cron-scheduler.ts) | 775 | Cron 调度器 | 调度 + 触发 + 持久化 + 用户确认；拆 `cron-trigger.ts` / `cron-job-store.ts` / `cron-confirm-dialog.ts` |
| P2-07 | [agent-instance.ts](../../../packages/agent-runtime/src/agent/agent-instance.ts) | 749 | Agent Runtime 核心 | 单复杂算法类可适度放宽；但 `runStep` >180 行，拆 `step-tool-call.ts` / `step-message-emit.ts` |
| P2-08 ★ | [system-service.ts](../../../apps/windows/src/main/system-service.ts) | 739 | 系统服务 | 系统信息 + 剪贴板 + 通知 + 文件选择器 + 进程管理；拆 `system-info-provider.ts` / `clipboard-service.ts` / `file-dialog-service.ts` |
| P2-09 | [controller.test.ts](../../../apps/windows/src/main/app-ui-control/controller.test.ts) | 739 | 测试 | 测试暂放，优先抽 fixture/mock，不强制拆分 |
| P2-10 ★ | [SessionFileList/index.tsx](../../../apps/windows/src/renderer/pages/ChatPage/components/SessionFileList/index.tsx) | 720 | 业务组件 | 文件列表 + 缩略图 + 拖拽排序 + 预览；拆 `FileThumbnail.tsx` / `FileDndSortable.tsx` |
| P2-11 ★ | [skill-store.ts](../../../apps/windows/src/main/skill-store.ts) | 708 | 技能仓库 | CRUD + 索引 + 热更新钩子 + 解析器调用；类型抽 `skill-store.types.ts`；拆 `skill-indexer.ts` / `skill-hooks.ts` |
| P2-12 ★ | [useSkillStore.ts](../../../apps/windows/src/renderer/hooks/business/useSkillStore/useSkillStore.ts) | 687 | Hooks 业务 | 30+ actions；拆 `useSkillStoreActions.ts` / `useSkillStoreSelectors.ts` |
| P2-13 | [local-database.ts](../../../packages/agent-runtime/src/storage/local-database.ts) | 681 | 数据库访问 | 纯 schema + migration 可放宽；migration 建议独立 `migrations/*.ts` |
| P2-14 ★ | [WorkspaceFilePanel/index.tsx](../../../apps/windows/src/renderer/pages/ChatPage/components/WorkspaceFilePanel/index.tsx) | 669 | 业务组件 | 面板壳 + 文件树（490 行另一个文件）+ 标签页；主壳 ≤ 300，FileTree 已独立但仍 490 行 |
| P2-15 ★ | [WorkspaceVersionPanel.tsx](../../../apps/windows/src/renderer/pages/ChatPage/components/WorkspaceVersionPanel/WorkspaceVersionPanel.tsx) | 667 | 业务组件 | 版本列表 + diff 视图 + 回滚/恢复向导；拆 `VersionDiffView.tsx` / `VersionRestoreWizard.tsx` |
| P2-16 ★ | [PetModeShell.tsx](../../../apps/windows/src/renderer/pet/PetModeShell.tsx) | 650 | 桌宠壳组件 | 窗管 + 渲染器 + 控制面板 + 事件；拆 `PetRendererHost.tsx` / `PetWindowDecor.tsx` |
| P2-17 | [extension-relay.ts](../../../packages/browser-control/src/browser/extension-relay.ts) | 650 | 浏览器扩展中继 | 纯协议通信类；方法较多但职责单一，建议按 message type 分 handler 文件 |
| P2-18 | [chrome.executables.ts](../../../packages/browser-control/src/browser/chrome.executables.ts) | 646 | 浏览器可执行文件查找 | 平台相关大 switch，属「策略表」可放宽；建议抽 `chrome-paths-windows.ts` / `chrome-paths-macos.ts` 平台分文件 |
| P2-19 | [server-context.ts](../../../packages/browser-control/src/browser/server-context.ts) | 641 | 浏览器服务上下文 | 会话管理 + 生命周期；单职责可暂放 |
| P2-20 ★ | [bridge-prompt-dispatcher.ts](../../../apps/windows/src/main/agent-runtime/bridge-prompt-dispatcher.ts) | 639 | Bridge Prompt 派发 | 路由 + 用户确认 + 会话上下文注入；拆 `prompt-router.ts` / `prompt-confirm-flow.ts` |
| P2-21 ★ | [bridge-app-ui-tools.ts](../../../apps/windows/src/main/agent-runtime/bridge-app-ui-tools.ts) | 626 | Bridge 工具 | 10+ 个 UI 控制工具实现；拆已和 controller 对齐分 screenshot/ocr/window/dom 文件 |
| P2-22 | [document-parser.ts](../../../apps/windows/src/main/vendor/document-parser.ts) | 615 | 第三方解析器 | vendor 标注的可暂放；或抽 `doc-parsers/pdf-parser.ts` / `doc-parsers/docx-parser.ts` |
| P2-23 ★ | [ScreenRecordPanel.tsx](../../../apps/windows/src/renderer/components/ScreenRecord/ScreenRecordPanel.tsx) | 613 | 录屏面板组件 | 区域选择 + 设备选择 + 设置 + 录制控制；拆 `RegionSelector.tsx` / `DevicePicker.tsx` / `RecordingControls.tsx` |
| P2-24 | [Generate.ts](../../../apps/windows/bundled-skills/设计与可视化/Art/Tools/Generate.ts) | 610 | 技能脚本 | 单技能工具；≥500 行建议抽子函数，不强制分文件 |
| P2-25 ★ | [VoiceProfilesPanel/index.tsx](../../../apps/windows/src/renderer/pages/SettingsPage/components/VoiceProfilesPanel/index.tsx) | 609 | 设置子组件 | 10+ 个声音配置卡片；已在子目录，主文件 ≤ 300，拆 `VoiceProfileCard.tsx` / `VoiceProfileEditor.tsx` |
| P2-26 ★ | [ChatContainer/index.tsx](../../../apps/windows/src/renderer/pages/ChatPage/components/ChatContainer/index.tsx) | 608 | 业务组件 | 消息滚动容器 + 懒加载 + 引用高亮 + 滚动锚；拆 `MessageLazyList.tsx` / `ScrollAnchor.tsx` |
| P2-27 | [Live2dPetRenderer.ts](../../../apps/windows/src/renderer/pet/renderer/live2d/Live2dPetRenderer.ts) | 591 | 渲染器 | 单复杂渲染类可适度放宽；拆 `live2d-model-loader.ts` / `live2d-expression-player.ts` |
| P2-28 | [pet-lab/main.ts](../../../apps/windows/pet-lab/main.ts) | 585 | 调试沙盒 | 调试用，不强制拆分 |
| P2-29 | [cloak-browser-downloader.ts](../../../apps/windows/src/main/cloak-browser-downloader.ts) | 585 | 浏览器下载器 | 下载 + 校验 + 解压；单职责可暂放 |
| P2-30 | [pw-session.ts](../../../packages/browser-control/src/browser/pw-session.ts) | 580 | Playwright 会话 | 会话包装类；方法较多但职责单一 |
| P2-32 ★ | [PetControlDock.tsx](../../../apps/windows/src/renderer/pet/components/PetControlDock.tsx) | 573 | 桌宠控制面板 | 10+ 个功能按钮 + 弹出菜单；拆 `PetDockButtons.tsx` / `PetDockMenu.tsx` |
| P2-33 ★ | [weixin-channel-adapter.ts](../../../apps/windows/src/main/channel/adapters/weixin-channel-adapter.ts) | 570 | 渠道适配器 | 入站消息路由 + 回执 + 错误映射；拆 `weixin-inbound-router.ts` / `weixin-outbound-mapper.ts` |
| P2-34 | [server.test.ts](../../../apps/windows/src/main/app-ui-control/server.test.ts) | 561 | 测试 | 测试暂放 |
| P2-35 ★ | [vcs-repo.ts](../../../apps/windows/src/main/workspace-vcs/vcs-repo.ts) | 548 | 版本控制仓库 | commit / diff / restore / branch 混杂；拆 `vcs-commit.ts` / `vcs-diff.ts` / `vcs-branch.ts` |
| P2-36 ★ | [local-companion-handler.ts](../../../apps/windows/src/main/agent-runtime/local-companion-handler.ts) | 547 | 本地伙伴处理器 | 问候 + 主动消息 + 事件触发；拆 `companion-greeter.ts` / `companion-event-reactors.ts` |
| P2-37 ★ | [RecordingSubtitleEditor.tsx](../../../apps/windows/src/renderer/components/ScreenRecord/RecordingSubtitleEditor.tsx) | 539 | 字幕编辑器组件 | 时间轴 + 编辑区 + 导入导出；拆 `SubtitleTimeline.tsx` / `SubtitleTrackEditor.tsx` |
| P2-38 ★ | [server.ts](../../../apps/windows/src/main/app-ui-control/server.ts) | 533 | UI 控制服务端 | 命令路由 + WebSocket + 权限；拆 `command-router.ts` / `ws-server-layer.ts` |
| P2-39 | [agent.act.ts](../../../packages/browser-control/src/browser/agent.act.ts) | 531 | 浏览器执行动作 | 动作分发器；按 action type 拆 handler |
| P2-40 ★ | [CodingDevAcpPanel.tsx](../../../apps/windows/src/renderer/pages/SettingsPage/components/CodingDevAcpPanel/CodingDevAcpPanel.tsx) | 529 | 设置子组件 | ACP 安装 + 环境检测 + CLI；拆 `AcpInstaller.tsx` / `AcpEnvStatus.tsx` / `CliStatusTable.tsx` |
| P2-41 | [pw-tools-core.interactions.ts](../../../packages/browser-control/src/browser/pw-tools-core.interactions.ts) | 517 | 浏览器工具 | 交互工具聚合；按能力拆 click/type/scroll/select 等子文件 |
| P2-42 | [screen-record.ts](../../../apps/windows/src/shared/screen-record.ts) | 504 | 共享常量/类型 | 纯协议可放宽到 1000 行，暂不拆 |
| P2-43 ★ | [bridge-screen-record-tools.ts](../../../apps/windows/src/main/agent-runtime/bridge-screen-record-tools.ts) | 502 | Bridge 工具 | 6 个录屏工具；拆 `screen-record-tool-impls.ts` 让 bridge 文件仅保留注册 |

---

## P3 级 — 400–500 行，测试/纯常量暂放（39 个）

> 说明：P3 级文件建议在改到的时候顺手拆分，不做集中排期。

| # | 文件 | 行数 | 类别 | 备注 / 建议 |
|---|---|---|---|---|
| P3-01 | [feishu-login-service.ts](../../../apps/windows/src/main/feishu-login-service.ts) | 497 | 渠道服务 | 和微信一样拆 login-flow + session-store + message-sender |
| P3-02 | [narrate-service.ts](../../../apps/windows/src/main/screen-record/narrate-service.ts) | 493 | 配音服务 | 单职责可暂放 |
| P3-03 | [right-codes-draw-client.ts](../../../apps/windows/src/main/agent-runtime/right-codes-draw-client.ts) | 489 | 绘图客户端 | 单职责，API 封装类 |
| P3-04 | [bridge-context-compactor.ts](../../../apps/windows/src/main/agent-runtime/bridge-context-compactor.ts) | 482 | Bridge 压缩 | 单职责可暂放；若继续增长则拆 `compact-trigger.ts` / `compact-progress.ts` |
| P3-05 | [bridge-prompt-composer.ts](../../../apps/windows/src/main/agent-runtime/bridge-prompt-composer.ts) | 478 | Bridge Prompt | 和 system-prompt-builder 对齐拆分 section |
| P3-06 | [subtitle-project.ts](../../../apps/windows/src/main/screen-record/subtitle-project.ts) | 477 | 字幕工程 | 纯数据访问类 |
| P3-07 | [agent-runtime-events.ts](../../../apps/windows/src/shared/agent-runtime-events.ts) | 477 | 共享事件类型 | 纯类型/常量，可放宽至 800 行 |
| P3-08 | [useVoiceCall.ts](../../../apps/windows/src/renderer/hooks/business/useVoiceCall/useVoiceCall.ts) | 476 | Hooks 业务 | 450 警戒值，建议拆 `useVoiceCallUi.ts` / `useVoiceCallRuntime.ts` |
| P3-09 | [ComposeThumbnail.ts](../../../apps/windows/bundled-skills/设计与可视化/Art/Tools/ComposeThumbnail.ts) | 473 | 技能脚本 | 抽子函数即可 |
| P3-10 | [ComposerPlusMenu.tsx](../../../apps/windows/src/renderer/pages/ChatPage/components/ChatInput/ComposerPlusMenu.tsx) | 471 | 业务组件 | 450 警戒，拆 8+ 种子菜单项 |
| P3-11 | [index.ts](../../../packages/agent-runtime/src/index.ts) | 454 | 包入口 | 纯 re-export 可放宽；建议按 domain 分组 re-export |
| P3-12 | [micro-compact.ts](../../../packages/agent-runtime/src/compact/strategies/micro-compact.ts) | 460 | 压缩策略 | 单算法类 |
| P3-13 | [MemoriesPage.tsx](../../../apps/windows/src/renderer/pages/MemoriesPage/MemoriesPage.tsx) | 457 | 页面组件 | 400 行接近，顺手拆 |
| P3-14 | [SkillStoreView.tsx](../../../apps/windows/src/renderer/components/business/SkillStoreView/SkillStoreView.tsx) | 455 | 业务组件 | 接近阈值 |
| P3-16 | [tts-engine.ts](../../../apps/windows/src/main/voice/tts-engine.ts) | 449 | TTS 引擎 | 单职责可暂放 |
| P3-17 | [mcp-client.ts](../../../packages/agent-runtime/src/tools/mcp/mcp-client.ts) | 448 | MCP 客户端 | 单职责 API 封装 |
| P3-18 | [slash-command-executor.ts](../../../apps/windows/src/renderer/pages/ChatPage/commands/slash-command-executor.ts) | 446 | 斜杠命令 | 按 command type 拆 handler 文件 |
| P3-19 | [rightapi-image-client.ts](../../../apps/windows/src/main/agent-runtime/rightapi-image-client.ts) | 443 | 图像客户端 | 单职责 |
| P3-20 | [StorageInfo.tsx](../../../apps/windows/src/renderer/pages/SettingsPage/components/StorageInfo.tsx) | 441 | 设置子组件 | 400 行接近，拆 `StorageBreakdownChart.tsx` / `StorageCleanupPanel.tsx` |
| P3-21 | [PetFakeLipSync.ts](../../../apps/windows/src/renderer/pet/orchestrator/PetFakeLipSync.ts) | 438 | 口型同步算法 | 单算法类 |
| P3-22 | [coding-dev-acp-run.ts](../../../apps/windows/src/main/coding-dev-acp-run.ts) | 436 | ACP 运行 | 单职责脚本 |
| P3-23 | [event-converter.ts](../../../apps/windows/src/main/agent-runtime/event-converter.ts) | 436 | 事件转换器 | 按事件 domain 拆若干 mapper |
| P3-24 | [screen-record-service.test.ts](../../../apps/windows/src/main/screen-record/screen-record-service.test.ts) | 435 | 测试 | 测试暂放 |
| P3-25 | [transform-context.test.ts](../../../packages/agent-runtime/src/compact/__tests__/transform-context.test.ts) | 434 | 测试 | 测试暂放 |
| P3-26 | [bridge-app-ui-tools.test.ts](../../../apps/windows/src/main/agent-runtime/bridge-app-ui-tools.test.ts) | 427 | 测试 | 测试暂放 |
| P3-27 | [security-utils.ts](../../../apps/windows/src/main/security-utils.ts) | 427 | 安全工具 | 纯工具接近 450 警戒，拆 `validators.ts` / `sanitizers.ts` / `path-security.ts` |
| P3-28 | [file-attachment-strategy.ts](../../../apps/windows/src/renderer/pages/ChatPage/utils/file-attachment-strategy.ts) | 424 | 工具策略 | 按文件类型拆 strategy 文件 |
| P3-29 | [cdp.ts](../../../packages/browser-control/src/browser/cdp.ts) | 421 | CDP 封装 | 单职责 |
| P3-30 | [agent.storage.ts](../../../packages/browser-control/src/browser/agent.storage.ts) | 421 | 浏览器存储 | 单职责 |
| P3-31 | [cron-e2e.test.ts](../../../apps/windows/src/main/agent-runtime/cron-e2e.test.ts) | 419 | 测试 | 测试暂放 |
| P3-32 | [useFiles.ts](../../../apps/windows/src/renderer/hooks/business/useFiles/useFiles.ts) | 414 | Hooks 业务 | 400 行出头，顺手拆 upload / download / list |
| P3-33 | [McpServersPanel/index.tsx](../../../apps/windows/src/renderer/components/McpServersPanel/index.tsx) | 413 | 业务组件 | 接近阈值 |
| P3-35 | [act.ts](../../../apps/windows/src/main/app-ui-control/act.ts) | 413 | UI 动作执行 | 按 action 类型拆 handler |
| P3-36 | [agent-runtime-store.ts](../../../apps/windows/src/renderer/hooks/business/useAgentRuntime/agent-runtime-store.ts) | 412 | Store | 450 警戒，拆 `runtime-session-store.ts` / `runtime-tool-store.ts` |
| P3-37 | [ScreenRecordCapture.ts](../../../apps/windows/src/renderer/screen-record/ScreenRecordCapture.ts) | 407 | 录屏采集 | 单职责 |
| P3-38 | [SkillsContext.tsx](../../../apps/windows/src/renderer/contexts/SkillsContext/SkillsContext.tsx) | 403 | Context | 400 行出头，拆 `skills-context-provider.tsx` / `skills-context-hooks.ts` |
| P3-39 | [FileTree.tsx](../../../apps/windows/src/renderer/pages/ChatPage/components/WorkspaceFilePanel/FileTree.tsx) | 490 | 业务组件 | 已是文件树独立组件；先保持树节点、拖拽和预览行为，只有状态/数据边界稳定时再拆 |
| P3-40 | [pet-window-manager.ts](../../../apps/windows/src/main/pet/pet-window-manager.ts) | 481 | 桌宠窗口管理 | 单一窗口生命周期职责，暂不为行数拆分；重构时保护窗口创建、隐藏、销毁和事件行为 |
| P3-41 | [coding-dev-cli-install.ts](../../../apps/windows/src/main/coding-dev-cli-install.ts) | 431 | ACP 安装 | CLI 安装与检测脚本；先保持安装命令、路径和错误行为，只有出现第二种实现时再抽策略 |

---

## 超警戒函数索引（>120 行函数清单）

> 以下仅列出本次核对时已确认的函数/组件边界；函数长度是复核信号，不是“超过即必须套设计模式”的硬规则。

| 所在文件 | 已确认函数/组件边界 | 估算行数 | 问题 / 建议 |
|---|---|---|---|
| `apps/windows/src/main/index.ts` | `createWindow` | 已确认 | 先刻画窗口选项、事件和加载顺序，再按现有依赖边界提取 |
| `apps/windows/src/main/index.ts` | `setupIpcHandlers` / `setupApiIpcHandlers` | 已确认 | 普通 IPC 与 API IPC 分模块时保持注册顺序和 channel 契约 |
| `SettingsPage.tsx` | `handleSaveProvider` / `renderModelConfigSettings` | 已确认 | 仅在状态边界真实独立时提取 hook/section |
| `agent-runtime-ipc.ts` | `installAgentRuntimeCommandIpc` / `handleCommand` | 已确认 | 保持单一 `agent-runtime:command` channel、命令类型、错误和结果语义 |
| `system-prompt-builder.ts` | `buildProgressiveLoadingSection` / `buildSkillsSection` | 已确认 | 按实际 section 提取纯函数，保护输出顺序、标签、缓存和空值行为 |
| `preload/index.ts` | `electronAPI` 实现对象及 `exposeInMainWorld` 调用 | 已确认 | 按能力模块提取，保持 API shape、channel 和全局服务暴露 |
| `ChatPage.tsx` | `handleSend` / `ChatPage` 组件 | 已确认 | 复用已有 ChatSidebar、ChatContainer、ChatInput 和 workspace 组件，先提 hooks/副作用 |
| `event-handler.ts` | `handleRuntimeEvent` | 已确认 | 保持类型穷举 dispatcher；只提取稳定、纯粹的 domain handler |
| `voice-service.ts` | `processTtsQueue` | 已确认 | 先复用已有 voice engine/state machine；仅在职责边界清晰时提取 |
| `controller.ts` | `screenshot` | 已确认 | 与 OCR、窗口、DOM、视觉定位边界对齐，保持工具返回和错误映射 |
| `ChatMessage/index.tsx` | `buildRenderUnits` | 已确认 | 以现有渲染单元为边界提取，保持消息顺序和状态 |
| `FilePreviewModal.tsx` | `getPreviewRoute` | 已确认 | 复用现有 PdfJs/Excel/Pptx previewer，保持路由匹配和兜底 |
| `qwen3-tts-client.ts` | `synthesizeStream` | 已确认 | 先保护流式输出、缓存、预热和错误行为，再决定是否拆管线 |

---

## 附：行数统计复现命令

在当前 worktree 根目录执行。命令只读取 Git 已跟踪的 TypeScript 文件，因此不会把其他 worktree、依赖或构建产物计入统计：

```powershell
# 统计非空物理行；排除声明文件
$files = git -c core.quotepath=false ls-files -- '*.ts' '*.tsx' |
  Where-Object { $_ -notmatch '\.d\.ts$' }
$data = foreach ($path in $files) {
  $lines = (Get-Content -LiteralPath $path -Encoding UTF8 | Where-Object { $_ -match '\S' }).Count
  [PSCustomObject]@{ Lines = $lines; Path = $path }
}
$data | Sort-Object Lines -Descending | Format-Table -AutoSize
Write-Host "Commit: $(git rev-parse --short HEAD)"
Write-Host "Files: $($data.Count), >500: $(($data | Where-Object Lines -gt 500).Count), >400: $(($data | Where-Object Lines -gt 400).Count)"
```

---

**回到主报告：** [README.md](./README.md)
