# 大文件重构 — 代码位置索引

> 生成时间：2026-08-20
> 完整列出所有 **>400 行** 的 107 个文件
> 分级：P0（立即）/ P1（计划）/ P2（观察）/ P3（测试/常量暂放）

---

## 目录

1. [P0 级 — >1500 行（6 个）](#p0-级--1500-行6-个)
2. [P1 级 — 800–1500 行（17 个）](#p1-级--8001500-行17-个)
3. [P2 级 — 500–800 行（43 个）](#p2-级--500800-行43-个)
4. [P3 级 — 400–500 行，测试/纯常量暂放（41 个）](#p3-级--400500-行测试纯常量暂放41-个)
5. [超警戒函数索引（>120 行函数清单）](#超警戒函数索引120-行函数清单)

---

## P0 级 — >1500 行（6 个）

### P0-01
| 项目 | 内容 |
|---|---|
| **文件** | [index.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/index.ts) |
| **有效行数** | 3055 |
| **类别** | 主进程入口（服务装配） |
| **警戒阈值** | 300 行（建议上限）→ 超标 **10 倍** |
| **主要问题** | 窗口/托盘/IPC注册/渠道登录/语音/录屏/网关 全部塞入口；20+ 条 IPC handler inline；初始化顺序无编排 |
| **拆分建议** | 按「装配模块」拆：`app-lifecycle.ts` + `windows/*`(3) + `tray/*`(2) + `ipc/*`(5) + `bootstrap/*`(3)；index.ts 仅保留 import + 一行 `bootstrapApp()` |
| **预计拆后文件数** | 14 个，index.ts ≤ 300 |

### P0-02
| 项目 | 内容 |
|---|---|
| **文件** | [SettingsPage.tsx](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/pages/SettingsPage/SettingsPage.tsx) |
| **有效行数** | 2404 |
| **类别** | 页面组件 `.tsx` |
| **警戒阈值** | 500 行 → 超标 **4.8 倍** |
| **主要问题** | 10 个分类面板 inline 渲染；模型配置 600+ 行本地状态 + 保存逻辑；18 个 `useState` 混杂 |
| **拆分建议** | 每个分类面板独立 `*Section.tsx`；模型配置抽 `useProviderSlots.ts` hook；常量/类型独立文件；已存在部分 components 继续补全 |
| **预计拆后文件数** | 18 个，SettingsPage.tsx ≤ 300 |

### P0-03
| 项目 | 内容 |
|---|---|
| **文件** | [agent-runtime-ipc.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/ipc/agent-runtime-ipc.ts) |
| **有效行数** | 2382 |
| **类别** | IPC Handler 层 |
| **警戒阈值** | 450 行 → 超标 **5.3 倍** |
| **主要问题** | 50+ 条 IPC handler 顺序堆砌；handler 内部包含完整业务逻辑；类型定义散落 |
| **拆分建议** | 按能力域 10 个文件：session / message / tool-permission / compact / agent / skill / memory / router / cron + index 聚合 |
| **预计拆后文件数** | 10 个，每个 ≤ 400 |

### P0-04
| 项目 | 内容 |
|---|---|
| **文件** | [system-prompt-builder.ts](file:///e:/my-project/open-source/lumii/packages/agent-runtime/src/prompt/system-prompt-builder.ts) |
| **有效行数** | 2005 |
| **类别** | 业务核心：Prompt 构建 |
| **警戒阈值** | 450 行 → 超标 **4.5 倍** |
| **主要问题** | 8+ 个 interface + 10+ section 构建函数 + 格式化工具混装；单个 `buildRoleSection` > 250 行 |
| **拆分建议** | `system-prompt.types.ts` + `sections/*.ts`（10 个）+ `formatters/*.ts`（3 个）；主入口只保留编排 |
| **预计拆后文件数** | 15 个，主入口 ≤ 300 |

### P0-05
| 项目 | 内容 |
|---|---|
| **文件** | [index.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/preload/index.ts) |
| **有效行数** | 1924 |
| **类别** | Preload 桥接脚本 |
| **警戒阈值** | 450 行 → 超标 **4.3 倍** |
| **主要问题** | 70+ 条 ElectronAPI 方法 inline 定义；3 套事件多路复用器；类型 import 混杂 |
| **拆分建议** | `ElectronAPI.d.ts` 抽出接口；`bridge/*.ts` 分 8 个能力域；`event-mux/*.ts` 分 3 个事件复用；index.ts 仅保留 `exposeInMainWorld` 聚合 |
| **预计拆后文件数** | 14 个，index.ts ≤ 200 |

### P0-06
| 项目 | 内容 |
|---|---|
| **文件** | [ChatPage.tsx](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/pages/ChatPage/ChatPage.tsx) |
| **有效行数** | 1755 |
| **类别** | 页面组件 `.tsx` |
| **警戒阈值** | 500 行 → 超标 **3.5 倍** |
| **主要问题** | 会话列表 + 消息渲染 + 输入框 + 工作空间面板 + 语音通话 + 版本控制 全部一个组件；30+ hooks |
| **拆分建议** | `hooks/` 分 5 个业务 hook；`layout/` 分 4 块布局；主组件只剩装配 + 少量状态 |
| **预计拆后文件数** | 12 个，ChatPage.tsx ≤ 300 |

---

## P1 级 — 800–1500 行（17 个）

### P1-01
| 项目 | 内容 |
|---|---|
| **文件** | [bridge-tool-registrar.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/agent-runtime/bridge-tool-registrar.ts) |
| **有效行数** | 1563 |
| **类别** | Agent Bridge（工具注册） |
| **建议上限** | 450 行（service 层） |
| **主要问题** | 30+ 个工具注册函数；工具 handler 包含完整业务逻辑（如图像生成 >200 行、技能调用 >150 行） |
| **拆分建议** | 按工具域分：`tools-core.ts`(todo_write/spawn_agent…) / `tools-browser.ts` / `tools-channel.ts` / `tools-voice.ts` / `tools-skill.ts` + index 聚合注册 |
| **验收** | 每个工具域文件 ≤ 450 行；工具 handler 仅编排，具体实现 delegate |

### P1-02
| 项目 | 内容 |
|---|---|
| **文件** | [bridge.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/agent-runtime/bridge.ts) |
| **有效行数** | 1465 |
| **类别** | Agent Bridge 主类 |
| **主要问题** | 单 class 40+ 方法；生命周期 + 实例池 + 权限 + 持久化 混杂 |
| **拆分建议** | 拆 `bridge-lifecycle.ts` / `bridge-instance-pool.ts` / `bridge-permissions.ts` + 主类保留 facade |

### P1-03
| 项目 | 内容 |
|---|---|
| **文件** | [event-handler.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/hooks/business/useAgentRuntime/event-handler.ts) |
| **有效行数** | 1409 |
| **类别** | Hooks 业务层 |
| **主要问题** | 40+ 事件类型 switch-case；每个事件处理 30–80 行；含 UI 状态更新、存储、副作用 |
| **拆分建议** | 按事件 domain 拆：`handle-tool-events.ts` / `handle-message-events.ts` / `handle-compact-events.ts` / `handle-runtime-events.ts` |

### P1-04
| 项目 | 内容 |
|---|---|
| **文件** | [model-manager.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/voice/model-manager.ts) |
| **有效行数** | 1370 |
| **类别** | 语音（模型管理） |
| **主要问题** | 模型下载 + 校验 + 索引 + 设备检测 + 加载状态机 混杂；单个下载流程 >300 行 |
| **拆分建议** | `voice/model-downloader.ts` / `voice/model-index.ts` / `voice/model-device-detector.ts` / `voice/model-loader-state.ts` |

### P1-05
| 项目 | 内容 |
|---|---|
| **文件** | [voice-service.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/voice/voice-service.ts) |
| **有效行数** | 1345 |
| **类别** | 语音服务主类 |
| **主要问题** | VAD + ASR + TTS 队列 + 状态机 + AgentRuntime 对接 全部一个类；单 `handleAsrResult` >180 行 |
| **拆分建议** | 已按模块分文件（vad-engine/asr-engine/tts-engine/state-machine），需进一步把 `VoiceCallService` 内大方法抽到 strategy：`voice-call-asr-handler.ts` / `voice-call-tts-scheduler.ts` |

### P1-06
| 项目 | 内容 |
|---|---|
| **文件** | [AgentsPage.tsx](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/pages/AgentsPage/AgentsPage.tsx) |
| **有效行数** | 1296 |
| **类别** | 页面组件 `.tsx` |
| **主要问题** | 3 种视图（Grid/Map/Feed）+ 2 个 wizard + 能力配置面板 inline；CAPABILITY_OPTIONS 常量 >150 行 |
| **拆分建议** | 抽 `AgentEditor.tsx`（含能力配置 300+ 行）/ `CapabilityConfigPanel.tsx`；常量抽 `AgentsPage.const.ts` |

### P1-07
| 项目 | 内容 |
|---|---|
| **文件** | [weixin-login-service.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/weixin-login-service.ts) |
| **有效行数** | 1272 |
| **类别** | 渠道服务（微信） |
| **主要问题** | 登录流程 + 二维码 + 会话存储 + 消息收发 + API 封装 全部一个类；单 `pollMessageLoop` >250 行 |
| **拆分建议** | `channel/weixin/weixin-login-flow.ts` / `weixin-session-store.ts` / `weixin-message-sender.ts` / `weixin-qrcode-handler.ts` |

### P1-08
| 项目 | 内容 |
|---|---|
| **文件** | [controller.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/app-ui-control/controller.ts) |
| **有效行数** | 1217 |
| **类别** | UI 控制服务 |
| **主要问题** | 截图 / OCR / 窗口操作 / DOM 点击 / 键盘输入 / 视觉定位 6 大块 inline；单 `screenshotImpl` >200 行 |
| **拆分建议** | `app-ui-control/screenshot-controller.ts` / `ocr-controller.ts` / `window-controller.ts` / `dom-interactor.ts` / `visual-locator.ts` |

### P1-09
| 项目 | 内容 |
|---|---|
| **文件** | [ChatInput/index.tsx](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/pages/ChatPage/components/ChatInput/index.tsx) |
| **有效行数** | 1187 |
| **类别** | 业务组件 `.tsx` |
| **主要问题** | 输入框 + 附件区 + 工具栏 + ComposerPlusMenu + 拖放 + 斜杠命令 混杂；`ComposerPlusMenu` 已独立但仍有 471 行 |
| **拆分建议** | 抽 `ChatInputToolbar.tsx` / `AttachmentDropZone.tsx` / `SlashCommandSuggestion.tsx`；核心输入框 ≤ 300 行 |

### P1-10
| 项目 | 内容 |
|---|---|
| **文件** | [useAgentRuntime.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/hooks/business/useAgentRuntime/useAgentRuntime.ts) |
| **有效行数** | 1156 |
| **类别** | Hooks 业务层 |
| **建议上限** | 300 行（hooks 层） |
| **主要问题** | 20+ actions + 初始化 + 生命周期 全部一个文件；依赖 5+ 内部 handler 文件仍聚合了大量逻辑 |
| **拆分建议** | 抽 `useAgentRuntimeActions.ts` / `useAgentRuntimeInit.ts` / `useAgentRuntimeLifecycle.ts`；主 hook 只做聚合返回 |

### P1-11
| 项目 | 内容 |
|---|---|
| **文件** | [skill-runtime.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/skill-runtime.ts) |
| **有效行数** | 1151 |
| **类别** | 技能运行时服务 |
| **主要问题** | 执行器调度 + 权限确认 dialog + 超时控制 + 导入导出 + 日志 混杂；类型定义 >150 行 inline |
| **拆分建议** | 类型抽 `skill-runtime.types.ts`；拆 `skill-execution-scheduler.ts` / `skill-permission-dialog.ts` / `skill-import-export.ts` |

### P1-12
| 项目 | 内容 |
|---|---|
| **文件** | [ToolCallCard/index.tsx](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/pages/ChatPage/components/ToolCallCard/index.tsx) |
| **有效行数** | 1101 |
| **类别** | 业务组件 `.tsx` |
| **主要问题** | 12+ 种工具类型的卡片渲染 inline（bash/file/web/skill/image/memory/speech/cron/dashboard…），每个 60–100 行 |
| **拆分建议** | `ToolCallCard/components/` 分 12 个 `*ToolCard.tsx`；抽 `tool-card-renderer.ts` 策略分发；主入口 ≤ 200 行 |

### P1-13
| 项目 | 内容 |
|---|---|
| **文件** | [agent-runtime-commands.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/shared/agent-runtime-commands.ts) |
| **有效行数** | 1087 |
| **类别** | 共享常量（协议命令） |
| **备注** | **属「纯常量/协议」可放宽到 1500 行，但建议按 domain 聚合导出** |
| **拆分建议** | 可暂缓；如需拆分：`commands/session-commands.ts` / `commands/tool-commands.ts` / `commands/agent-commands.ts` + index re-export |

### P1-14
| 项目 | 内容 |
|---|---|
| **文件** | [ChatMessage/index.tsx](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/pages/ChatPage/components/ChatMessage/index.tsx) |
| **有效行数** | 1045 |
| **类别** | 业务组件 `.tsx` |
| **主要问题** | 用户/助手/系统/tool-result 4 种消息样式 + markdown 渲染 + 代码块 + 引用块 + 思考区 混杂 |
| **拆分建议** | `ChatMessage/message-renderers/` 分 4 种 renderer；代码块抽 `CodeBlockRenderer.tsx`；思考区抽 `ReasoningBlock.tsx` |

### P1-15
| 项目 | 内容 |
|---|---|
| **文件** | [FilePreviewModal.tsx](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/components/FilePreviewModal/FilePreviewModal.tsx) |
| **有效行数** | 980 |
| **类别** | 通用组件 `.tsx` |
| **主要问题** | 8 种预览器（image/pdf/video/audio/code/text/3d/markdown）inline；每个预览器 80–150 行 |
| **拆分建议** | `FilePreviewModal/previewers/` 分 8 个 `*Previewer.tsx`；抽 `previewer-registry.ts` 策略模式 |

### P1-16
| 项目 | 内容 |
|---|---|
| **文件** | [qwen3-tts-client.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/voice/qwen3-tts-client.ts) |
| **有效行数** | 944 |
| **类别** | 语音（TTS 客户端） |
| **主要问题** | 模型加载 + CUDA graph 管理 + 合成管线 + 缓存 + 预热 混杂；单 `synthesizeStream` >220 行 |
| **拆分建议** | `voice/qwen3-tts-model-loader.ts` / `qwen3-cuda-graph.ts` / `qwen3-synth-pipeline.ts` |

### P1-17
| 项目 | 内容 |
|---|---|
| **文件** | [SkillsPage.tsx](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/pages/SkillsPage/SkillsPage.tsx) |
| **有效行数** | 942 |
| **类别** | 页面组件 `.tsx` |
| **主要问题** | 技能列表 + 搜索筛选 + 技能卡片 + 编辑器 + 导入导出向导 + 分类视图 混杂 |
| **拆分建议** | 抽 `SkillEditor.tsx`（300+ 行） / `SkillCard.tsx` / `SkillImportWizard.tsx` / `SkillsFilterBar.tsx` |

---

## P2 级 — 500–800 行（43 个）

按建议拆分优先级排序（标记 ★ 的是应优先和 P1 一起处理的）：

| # | 文件 | 行数 | 类别 | 主要问题 / 拆分建议 |
|---|---|---|---|---|
| P2-01 ★ | [screen-record-service.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/screen-record/screen-record-service.ts) | 929 | 录屏服务主类 | 录制流程 + 字幕烧录 + 配音 + 区域选择 + OSD 混杂；拆 `screen-record-capture.ts` / `subtitle-burner.ts` / `narrate-scheduler.ts` |
| P2-02 ★ | [PetOrchestrator.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/pet/orchestrator/PetOrchestrator.ts) | 873 | 桌宠编排器 | 状态机 + 动作策略 + 口型同步 + 事件路由；拆 `pet-state-machine.ts` / `pet-action-strategies.ts` / `pet-lip-sync-controller.ts` |
| P2-03 ★ | [conversation-repo.ts](file:///e:/my-project/open-source/lumii/packages/agent-runtime/src/storage/conversation-repo.ts) | 858 | 数据仓库 | 纯 SQL 访问可放宽；但 50+ 方法建议按 domain 拆 `session-query.ts` / `message-crud.ts` / `compact-repo.ts` |
| P2-04 ★ | [bridge-agent-instance-events.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/agent-runtime/bridge-agent-instance-events.ts) | 849 | Bridge 事件 | 20+ 事件转发 handler；按事件 domain 拆 tool/message/compact 三个文件 |
| P2-05 ★ | [bridge-instance-factory.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/agent-runtime/bridge-instance-factory.ts) | 790 | Bridge 实例工厂 | 配置注入 + Provider 路由 + LLM/Router/Tool/Memory/Skill 子系统装配；拆 `subsystem-assemblers/*.ts`（5 个） |
| P2-06 ★ | [cron-scheduler.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/agent-runtime/cron-scheduler.ts) | 775 | Cron 调度器 | 调度 + 触发 + 持久化 + 用户确认；拆 `cron-trigger.ts` / `cron-job-store.ts` / `cron-confirm-dialog.ts` |
| P2-07 | [agent-instance.ts](file:///e:/my-project/open-source/lumii/packages/agent-runtime/src/agent/agent-instance.ts) | 749 | Agent Runtime 核心 | 单复杂算法类可适度放宽；但 `runStep` >180 行，拆 `step-tool-call.ts` / `step-message-emit.ts` |
| P2-08 ★ | [system-service.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/system-service.ts) | 739 | 系统服务 | 系统信息 + 剪贴板 + 通知 + 文件选择器 + 进程管理；拆 `system-info-provider.ts` / `clipboard-service.ts` / `file-dialog-service.ts` |
| P2-09 | [controller.test.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/app-ui-control/controller.test.ts) | 739 | 测试 | 测试暂放，优先抽 fixture/mock，不强制拆分 |
| P2-10 ★ | [SessionFileList/index.tsx](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/pages/ChatPage/components/SessionFileList/index.tsx) | 720 | 业务组件 | 文件列表 + 缩略图 + 拖拽排序 + 预览；拆 `FileThumbnail.tsx` / `FileDndSortable.tsx` |
| P2-11 ★ | [skill-store.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/skill-store.ts) | 708 | 技能仓库 | CRUD + 索引 + 热更新钩子 + 解析器调用；类型抽 `skill-store.types.ts`；拆 `skill-indexer.ts` / `skill-hooks.ts` |
| P2-12 ★ | [useSkillStore.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/hooks/business/useSkillStore/useSkillStore.ts) | 687 | Hooks 业务 | 30+ actions；拆 `useSkillStoreActions.ts` / `useSkillStoreSelectors.ts` |
| P2-13 | [local-database.ts](file:///e:/my-project/open-source/lumii/packages/agent-runtime/src/storage/local-database.ts) | 681 | 数据库访问 | 纯 schema + migration 可放宽；migration 建议独立 `migrations/*.ts` |
| P2-14 ★ | [WorkspaceFilePanel/index.tsx](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/pages/ChatPage/components/WorkspaceFilePanel/index.tsx) | 669 | 业务组件 | 面板壳 + 文件树（490 行另一个文件）+ 标签页；主壳 ≤ 300，FileTree 已独立但仍 490 行 |
| P2-15 ★ | [WorkspaceVersionPanel.tsx](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/pages/ChatPage/components/WorkspaceVersionPanel/WorkspaceVersionPanel.tsx) | 667 | 业务组件 | 版本列表 + diff 视图 + 回滚/恢复向导；拆 `VersionDiffView.tsx` / `VersionRestoreWizard.tsx` |
| P2-16 ★ | [PetModeShell.tsx](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/pet/PetModeShell.tsx) | 650 | 桌宠壳组件 | 窗管 + 渲染器 + 控制面板 + 事件；拆 `PetRendererHost.tsx` / `PetWindowDecor.tsx` |
| P2-17 | [extension-relay.ts](file:///e:/my-project/open-source/lumii/packages/browser-control/src/browser/extension-relay.ts) | 650 | 浏览器扩展中继 | 纯协议通信类；方法较多但职责单一，建议按 message type 分 handler 文件 |
| P2-18 | [chrome.executables.ts](file:///e:/my-project/open-source/lumii/packages/browser-control/src/browser/chrome.executables.ts) | 646 | 浏览器可执行文件查找 | 平台相关大 switch，属「策略表」可放宽；建议抽 `chrome-paths-windows.ts` / `chrome-paths-macos.ts` 平台分文件 |
| P2-19 | [server-context.ts](file:///e:/my-project/open-source/lumii/packages/browser-control/src/browser/server-context.ts) | 641 | 浏览器服务上下文 | 会话管理 + 生命周期；单职责可暂放 |
| P2-20 ★ | [bridge-prompt-dispatcher.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/agent-runtime/bridge-prompt-dispatcher.ts) | 639 | Bridge Prompt 派发 | 路由 + 用户确认 + 会话上下文注入；拆 `prompt-router.ts` / `prompt-confirm-flow.ts` |
| P2-21 ★ | [bridge-app-ui-tools.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/agent-runtime/bridge-app-ui-tools.ts) | 626 | Bridge 工具 | 10+ 个 UI 控制工具实现；拆已和 controller 对齐分 screenshot/ocr/window/dom 文件 |
| P2-22 | [document-parser.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/vendor/document-parser.ts) | 615 | 第三方解析器 | vendor 标注的可暂放；或抽 `doc-parsers/pdf-parser.ts` / `doc-parsers/docx-parser.ts` |
| P2-23 ★ | [ScreenRecordPanel.tsx](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/components/ScreenRecord/ScreenRecordPanel.tsx) | 613 | 录屏面板组件 | 区域选择 + 设备选择 + 设置 + 录制控制；拆 `RegionSelector.tsx` / `DevicePicker.tsx` / `RecordingControls.tsx` |
| P2-24 | [Generate.ts](file:///e:/my-project/open-source/lumii/apps/windows/bundled-skills/设计与可视化/Art/Tools/Generate.ts) | 610 | 技能脚本 | 单技能工具；≥500 行建议抽子函数，不强制分文件 |
| P2-25 ★ | [VoiceProfilesPanel/index.tsx](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/pages/SettingsPage/components/VoiceProfilesPanel/index.tsx) | 609 | 设置子组件 | 10+ 个声音配置卡片；已在子目录，主文件 ≤ 300，拆 `VoiceProfileCard.tsx` / `VoiceProfileEditor.tsx` |
| P2-26 ★ | [ChatContainer/index.tsx](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/pages/ChatPage/components/ChatContainer/index.tsx) | 608 | 业务组件 | 消息滚动容器 + 懒加载 + 引用高亮 + 滚动锚；拆 `MessageLazyList.tsx` / `ScrollAnchor.tsx` |
| P2-27 | [Live2dPetRenderer.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/pet/renderer/live2d/Live2dPetRenderer.ts) | 591 | 渲染器 | 单复杂渲染类可适度放宽；拆 `live2d-model-loader.ts` / `live2d-expression-player.ts` |
| P2-28 | [pet-lab/main.ts](file:///e:/my-project/open-source/lumii/apps/windows/pet-lab/main.ts) | 585 | 调试沙盒 | 调试用，不强制拆分 |
| P2-29 | [cloak-browser-downloader.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/cloak-browser-downloader.ts) | 585 | 浏览器下载器 | 下载 + 校验 + 解压；单职责可暂放 |
| P2-30 | [pw-session.ts](file:///e:/my-project/open-source/lumii/packages/browser-control/src/browser/pw-session.ts) | 580 | Playwright 会话 | 会话包装类；方法较多但职责单一 |
| P2-31 | [gateway-stream.ts](file:///e:/my-project/open-source/lumii/packages/agent-runtime/src/llm/gateway-stream.ts) | 577 | LLM 流处理 | SSE + 事件解析；单职责可暂放 |
| P2-32 ★ | [PetControlDock.tsx](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/pet/components/PetControlDock.tsx) | 573 | 桌宠控制面板 | 10+ 个功能按钮 + 弹出菜单；拆 `PetDockButtons.tsx` / `PetDockMenu.tsx` |
| P2-33 ★ | [weixin-channel-adapter.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/channel/adapters/weixin-channel-adapter.ts) | 570 | 渠道适配器 | 入站消息路由 + 回执 + 错误映射；拆 `weixin-inbound-router.ts` / `weixin-outbound-mapper.ts` |
| P2-34 | [server.test.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/app-ui-control/server.test.ts) | 561 | 测试 | 测试暂放 |
| P2-35 ★ | [vcs-repo.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/workspace-vcs/vcs-repo.ts) | 548 | 版本控制仓库 | commit / diff / restore / branch 混杂；拆 `vcs-commit.ts` / `vcs-diff.ts` / `vcs-branch.ts` |
| P2-36 ★ | [local-companion-handler.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/agent-runtime/local-companion-handler.ts) | 547 | 本地伙伴处理器 | 问候 + 主动消息 + 事件触发；拆 `companion-greeter.ts` / `companion-event-reactors.ts` |
| P2-37 ★ | [RecordingSubtitleEditor.tsx](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/components/ScreenRecord/RecordingSubtitleEditor.tsx) | 539 | 字幕编辑器组件 | 时间轴 + 编辑区 + 导入导出；拆 `SubtitleTimeline.tsx` / `SubtitleTrackEditor.tsx` |
| P2-38 ★ | [server.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/app-ui-control/server.ts) | 533 | UI 控制服务端 | 命令路由 + WebSocket + 权限；拆 `command-router.ts` / `ws-server-layer.ts` |
| P2-39 | [agent.act.ts](file:///e:/my-project/open-source/lumii/packages/browser-control/src/browser/agent.act.ts) | 531 | 浏览器执行动作 | 动作分发器；按 action type 拆 handler |
| P2-40 ★ | [CodingDevAcpPanel.tsx](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/pages/SettingsPage/components/CodingDevAcpPanel/CodingDevAcpPanel.tsx) | 529 | 设置子组件 | ACP 安装 + 环境检测 + CLI；拆 `AcpInstaller.tsx` / `AcpEnvStatus.tsx` / `CliStatusTable.tsx` |
| P2-41 | [pw-tools-core.interactions.ts](file:///e:/my-project/open-source/lumii/packages/browser-control/src/browser/pw-tools-core.interactions.ts) | 517 | 浏览器工具 | 交互工具聚合；按能力拆 click/type/scroll/select 等子文件 |
| P2-42 | [screen-record.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/shared/screen-record.ts) | 504 | 共享常量/类型 | 纯协议可放宽到 1000 行，暂不拆 |
| P2-43 ★ | [bridge-screen-record-tools.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/agent-runtime/bridge-screen-record-tools.ts) | 502 | Bridge 工具 | 6 个录屏工具；拆 `screen-record-tool-impls.ts` 让 bridge 文件仅保留注册 |

---

## P3 级 — 400–500 行，测试/纯常量暂放（41 个）

> 说明：P3 级文件建议在改到的时候顺手拆分，不做集中排期。

| # | 文件 | 行数 | 类别 | 备注 / 建议 |
|---|---|---|---|---|
| P3-01 | [feishu-login-service.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/feishu-login-service.ts) | 497 | 渠道服务 | 和微信一样拆 login-flow + session-store + message-sender |
| P3-02 | [narrate-service.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/screen-record/narrate-service.ts) | 493 | 配音服务 | 单职责可暂放 |
| P3-03 | [right-codes-draw-client.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/agent-runtime/right-codes-draw-client.ts) | 489 | 绘图客户端 | 单职责，API 封装类 |
| P3-04 | [bridge-context-compactor.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/agent-runtime/bridge-context-compactor.ts) | 483 | Bridge 压缩 | 单职责可暂放；若继续增长则拆 `compact-trigger.ts` / `compact-progress.ts` |
| P3-05 | [bridge-prompt-composer.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/agent-runtime/bridge-prompt-composer.ts) | 478 | Bridge Prompt | 和 system-prompt-builder 对齐拆分 section |
| P3-06 | [subtitle-project.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/screen-record/subtitle-project.ts) | 477 | 字幕工程 | 纯数据访问类 |
| P3-07 | [agent-runtime-events.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/shared/agent-runtime-events.ts) | 476 | 共享事件类型 | 纯类型/常量，可放宽至 800 行 |
| P3-08 | [useVoiceCall.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/hooks/business/useVoiceCall/useVoiceCall.ts) | 476 | Hooks 业务 | 450 警戒值，建议拆 `useVoiceCallUi.ts` / `useVoiceCallRuntime.ts` |
| P3-09 | [ComposeThumbnail.ts](file:///e:/my-project/open-source/lumii/apps/windows/bundled-skills/设计与可视化/Art/Tools/ComposeThumbnail.ts) | 473 | 技能脚本 | 抽子函数即可 |
| P3-10 | [ComposerPlusMenu.tsx](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/pages/ChatPage/components/ChatInput/ComposerPlusMenu.tsx) | 471 | 业务组件 | 450 警戒，拆 8+ 种子菜单项 |
| P3-11 | [index.ts](file:///e:/my-project/open-source/lumii/packages/agent-runtime/src/index.ts) | 468 | 包入口 | 纯 re-export 可放宽；建议按 domain 分组 re-export |
| P3-12 | [micro-compact.ts](file:///e:/my-project/open-source/lumii/packages/agent-runtime/src/compact/strategies/micro-compact.ts) | 460 | 压缩策略 | 单算法类 |
| P3-13 | [MemoriesPage.tsx](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/pages/MemoriesPage/MemoriesPage.tsx) | 457 | 页面组件 | 400 行接近，顺手拆 |
| P3-14 | [SkillStoreView.tsx](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/components/business/SkillStoreView/SkillStoreView.tsx) | 455 | 业务组件 | 接近阈值 |
| P3-15 | [index.ts](file:///e:/my-project/open-source/lumii/packages/protocol/src/gateway-protocol/index.ts) | 450 | 协议包入口 | 纯类型 re-export，可放宽 |
| P3-16 | [tts-engine.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/voice/tts-engine.ts) | 449 | TTS 引擎 | 单职责可暂放 |
| P3-17 | [mcp-client.ts](file:///e:/my-project/open-source/lumii/packages/agent-runtime/src/tools/mcp/mcp-client.ts) | 448 | MCP 客户端 | 单职责 API 封装 |
| P3-18 | [slash-command-executor.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/pages/ChatPage/commands/slash-command-executor.ts) | 446 | 斜杠命令 | 按 command type 拆 handler 文件 |
| P3-19 | [rightapi-image-client.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/agent-runtime/rightapi-image-client.ts) | 443 | 图像客户端 | 单职责 |
| P3-20 | [StorageInfo.tsx](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/pages/SettingsPage/components/StorageInfo.tsx) | 441 | 设置子组件 | 400 行接近，拆 `StorageBreakdownChart.tsx` / `StorageCleanupPanel.tsx` |
| P3-21 | [PetFakeLipSync.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/pet/orchestrator/PetFakeLipSync.ts) | 438 | 口型同步算法 | 单算法类 |
| P3-22 | [coding-dev-acp-run.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/coding-dev-acp-run.ts) | 436 | ACP 运行 | 单职责脚本 |
| P3-23 | [event-converter.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/agent-runtime/event-converter.ts) | 436 | 事件转换器 | 按事件 domain 拆若干 mapper |
| P3-24 | [screen-record-service.test.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/screen-record/screen-record-service.test.ts) | 435 | 测试 | 测试暂放 |
| P3-25 | [transform-context.test.ts](file:///e:/my-project/open-source/lumii/packages/agent-runtime/src/compact/__tests__/transform-context.test.ts) | 434 | 测试 | 测试暂放 |
| P3-26 | [bridge-app-ui-tools.test.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/agent-runtime/bridge-app-ui-tools.test.ts) | 427 | 测试 | 测试暂放 |
| P3-27 | [security-utils.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/security-utils.ts) | 427 | 安全工具 | 纯工具接近 450 警戒，拆 `validators.ts` / `sanitizers.ts` / `path-security.ts` |
| P3-28 | [file-attachment-strategy.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/pages/ChatPage/utils/file-attachment-strategy.ts) | 424 | 工具策略 | 按文件类型拆 strategy 文件 |
| P3-29 | [cdp.ts](file:///e:/my-project/open-source/lumii/packages/browser-control/src/browser/cdp.ts) | 421 | CDP 封装 | 单职责 |
| P3-30 | [agent.storage.ts](file:///e:/my-project/open-source/lumii/packages/browser-control/src/browser/agent.storage.ts) | 421 | 浏览器存储 | 单职责 |
| P3-31 | [cron-e2e.test.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/agent-runtime/cron-e2e.test.ts) | 419 | 测试 | 测试暂放 |
| P3-32 | [useFiles.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/hooks/business/useFiles/useFiles.ts) | 414 | Hooks 业务 | 400 行出头，顺手拆 upload / download / list |
| P3-33 | [McpServersPanel/index.tsx](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/components/McpServersPanel/index.tsx) | 413 | 业务组件 | 接近阈值 |
| P3-34 | [gateway-client.ts](file:///e:/my-project/open-source/lumii/packages/client-sdk/src/gateway-client.ts) | 413 | SDK 客户端 | 单职责可暂放 |
| P3-35 | [act.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/app-ui-control/act.ts) | 413 | UI 动作执行 | 按 action 类型拆 handler |
| P3-36 | [agent-runtime-store.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/hooks/business/useAgentRuntime/agent-runtime-store.ts) | 412 | Store | 450 警戒，拆 `runtime-session-store.ts` / `runtime-tool-store.ts` |
| P3-37 | [ScreenRecordCapture.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/screen-record/ScreenRecordCapture.ts) | 407 | 录屏采集 | 单职责 |
| P3-38 | [SkillsContext.tsx](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/contexts/SkillsContext/SkillsContext.tsx) | 403 | Context | 400 行出头，拆 `skills-context-provider.tsx` / `skills-context-hooks.ts` |
| P3-39 | [bridge-context-compactor.test.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/agent-runtime/bridge-context-compactor.test.ts) | 273 | 测试 | （此条目行数有误，归入测试） |
| P3-40 | [PetOrchestrator.test.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/renderer/pet/orchestrator/PetOrchestrator.test.ts) | 259 | 测试 | 测试暂放 |
| P3-41 | [integration.test.ts](file:///e:/my-project/open-source/lumii/apps/windows/src/main/agent-runtime/router/integration.test.ts) | 251 | 测试 | 测试暂放 |

---

## 超警戒函数索引（>120 行函数清单）

> 抽样扫描 P0/P1 文件所得；**每个 >120 行函数必须拆子函数**，不管所在文件是否已拆分。

| 所在文件 | 函数名（推断） | 估算行数 | 问题 / 建议 |
|---|---|---|---|
| `src/main/index.ts` | `createMainWindow`（含所有事件绑定） | ~380 | 拆 `buildWindowOptions` / `registerWindowEvents` / `loadEntryUrl` |
| `src/main/index.ts` | `registerIpcHandlers`（inline 匿名） | ~620 | **必须拆分到 ipc/*.ts 各能力域** |
| `SettingsPage.tsx` | `handleSaveProviderSlot` | ~220 | 抽 `useProviderSlots.ts` hook |
| `SettingsPage.tsx` | `renderModelConfigSection`（JSX 内联） | ~420 | 独立 `ModelConfigSection.tsx` |
| `agent-runtime-ipc.ts` | `handleSendMessage` | ~180 | 拆 `validateRequest` / `dispatchToRuntime` / `wrapResponse` |
| `system-prompt-builder.ts` | `buildToolSection` | ~280 | 独立 `sections/tool-section.ts` |
| `system-prompt-builder.ts` | `buildSkillSection` | ~250 | 独立 `sections/skill-section.ts` + `formatters/skill-list-formatter.ts` |
| `preload/index.ts` | `exposeAllApis`（结构上的聚合） | ~800 | **必须按 bridge/*.ts 拆分** |
| `ChatPage.tsx` | `handleSend` | ~200 | 抽 `useChatInputHandler.ts` |
| `ChatPage.tsx` | `ChatPage` 函数组件本身 | ~1300 | 拆 layout + hooks |
| `bridge-tool-registrar.ts` | `registerImageGenerationTool` 的 handler | ~210 | delegate 到独立的 `image-gen-handler.ts` |
| `bridge-tool-registrar.ts` | `registerSkillInvokeTool` 的 handler | ~170 | delegate 到独立的 `skill-invoke-handler.ts` |
| `bridge.ts` | `constructor`（含所有子系统装配） | ~320 | 拆 `assembleSubsystems()` 私有方法或工厂文件 |
| `event-handler.ts` | `handleRuntimeEvent`（switch 总入口） | ~480 | 按 domain 分 4 个 handler 文件 |
| `model-manager.ts` | `downloadModel` | ~320 | 独立 `model-downloader.ts` 类 |
| `voice-service.ts` | `handleAsrResult` | ~180 | 独立 `voice-call-asr-handler.ts` |
| `voice-service.ts` | `scheduleTts`（队列 + 并发） | ~210 | 独立 `voice-call-tts-scheduler.ts` |
| `AgentsPage.tsx` | `renderCapabilityConfig` | ~300 | 独立 `CapabilityConfigPanel.tsx` |
| `weixin-login-service.ts` | `pollMessageLoop` | ~260 | 独立 `weixin-message-poller.ts` |
| `controller.ts` | `screenshotImpl`（主截图流程） | ~220 | 独立 `screenshot-controller.ts` |
| `ChatInput/index.tsx` | `handleDrop` + `processFile` | ~240 | 独立 `AttachmentDropZone.tsx` + `file-attachment-strategy.ts`（已存在，需对齐调用） |
| `ToolCallCard/index.tsx` | `renderToolCard`（大 switch） | ~650 | **策略模式 + 12 个独立组件** |
| `ChatMessage/index.tsx` | `renderMessageBody`（分支分发） | ~420 | **策略模式 + 4 种 renderer 组件** |
| `FilePreviewModal.tsx` | `renderPreviewer`（分支分发） | ~540 | **策略模式 + previewer-registry.ts** |
| `qwen3-tts-client.ts` | `synthesizeStream` | ~230 | 独立 `qwen3-synth-pipeline.ts` |

---

## 附：行数统计复现命令

在项目根目录执行：

```powershell
# 扫描并输出全量 JSON 到 .tmp_line_counts.json
Get-ChildItem -Path . -Recurse -Include *.ts,*.tsx | 
  Where-Object { $_.FullName -notmatch 'node_modules|\\dist\\|\\release\\|\\out\\|\\build\\' -and $_.Name -notmatch '\.d\.ts$' } |
  ForEach-Object {
    $lines = (Get-Content $_.FullName | Where-Object { $_ -match '\S' }).Count
    [PSCustomObject]@{ Lines = $lines; Path = $_.FullName; Name = $_.Name }
  } |
  Sort-Object Lines -Descending |
  ConvertTo-Json -Depth 3 |
  Set-Content -Path .tmp_line_counts.json -Encoding UTF8
```

查看分级统计：

```powershell
$data = Get-Content .tmp_line_counts.json -Raw | ConvertFrom-Json
Write-Host "Total: $($data.Count), >500: $(($data|?{$_.Lines -gt 500}).Count), >400: $(($data|?{$_.Lines -gt 400}).Count)"
```

---

**回到主报告：** [README.md](./README.md)
