# 灵栖 Lumii 大文件重构分析报告

> 核对时间：2026-08-21
> 核对分支：`main`
> 核对提交：`222fbf554faa7ec8c132366548f6eee2cbca3a2c`
> 统计范围：`apps/windows` + `packages/*` 下所有 `.ts` / `.tsx`（排除 `.d.ts`、`node_modules`、构建产物）
> 行数统计口径：**排除纯空行**，保留注释与代码
> 说明：本报告按当前分支重新核对；Gateway 遗留代码已在当前提交删除。

---

## 一、总体统计

| 指标 | 数值 |
|---|---|
| 扫描文件总数 | 1088 |
| >400 行文件数（建议考虑拆分） | 104 |
| >500 行文件数（观察指标） | 65 |
| 最大有效行数 | 2980（`apps/windows/src/main/index.ts`） |

> 文件数量只用于定位风险，不作为“必须拆分”的充分条件。测试、协议类型、纯算法、vendor 和调试沙盒按职责单独判断。

---

## 二、分级标准与优先级

### P0 — 立即重构（>1500 行，严重影响 AI 上下文检索与 Code Review）

共 **6 个**文件，均属「巨型单体」，存在严重职责混杂：

| 优先级 | 文件 | 行数 | 类别 | 主要问题 |
|---|---|---|---|---|
| P0 | `apps/windows/src/main/index.ts` | 2980 | 主进程入口 | 生命周期、窗口、服务初始化、渠道装配和多组 IPC 注册集中在入口 |
| P0 | `apps/windows/src/renderer/pages/SettingsPage/SettingsPage.tsx` | 2447 | 页面组件 | 10 个分类面板、模型配置和多组本地状态集中在一个组件 |
| P0 | `apps/windows/src/main/ipc/agent-runtime-ipc.ts` | 2382 | IPC 层 | 单一 `agent-runtime:command` 通道承载大量 typed command 分支，公共状态和事件转发混杂 |
| P0 | `packages/agent-runtime/src/prompt/system-prompt-builder.ts` | 1909 | Prompt 构建 | 类型定义、多个纯 section 构建函数和最终编排集中在一个文件 |
| P0 | `apps/windows/src/preload/index.ts` | 1913 | Preload 桥 | ElectronAPI 类型、多个 capability API、事件监听和多个全局暴露对象集中在一个文件 |
| P0 | `apps/windows/src/renderer/pages/ChatPage/ChatPage.tsx` | 1755 | 页面组件 | 会话列表 + 消息渲染 + 输入框 + 工作空间面板 + 语音通话 + 版本控制 全部在一个组件 |

### P1 — 计划内重构（800–1500 行，单文件已承担 3+ 职责）

共 **17 个**文件：

| 文件 | 行数 | 类别 | 建议拆分方向 |
|---|---|---|---|
| `bridge-tool-registrar.ts` | 1488 | Agent Bridge | 已有 browser/app-ui/screen-record 等注册模块；只抽仍混在 registrar 中的 integration/client command 逻辑 |
| `bridge.ts` | 1483 | Agent Bridge | 已有 lifecycle/instance factory/registrar 等协作者；保留 facade，暂不重复拆已有职责 |
| `event-handler.ts` (useAgentRuntime) | 1409 | Hooks 业务 | 按事件类型抽：`handle-tool.ts` / `handle-message.ts` / `handle-compact.ts` |
| `model-manager.ts` (voice) | 1370 | 语音服务 | 拆下载器、模型索引、设备检测、模型加载状态 |
| `voice-service.ts` | 1345 | 语音服务 | 拆 VAD 对接、ASR 对接、TTS 队列、通话状态机 |
| `AgentsPage.tsx` | 1296 | 页面组件 | 抽 `AgentEditor.tsx` / `AgentCapabilityConfig.tsx` / `views/*.tsx` 已在目录 |
| `weixin-login-service.ts` | 1272 | 渠道服务 | 拆登录流程、会话存储、消息收发、二维码处理 |
| `controller.ts` (app-ui-control) | 1217 | UI 控制 | 截图 / OCR / 窗口操作 / DOM 操作 分模块 |
| `ChatInput/index.tsx` | 1187 | 业务组件 | 拆附件处理、ComposerPlusMenu、工具栏、输入框核心 |
| `useAgentRuntime.ts` | 1156 | Hooks 业务 | 拆 actions / selectors / init / lifecycle，store 已单独文件 |
| `skill-runtime.ts` | 1151 | 技能运行时 | 拆执行器调度、权限确认、超时控制、导入导出、日志 |
| `ToolCallCard/index.tsx` | 1101 | 业务组件 | 已有 `toolTaxonomy` 和多个内部展示组件；按真实职责抽取，不预设 12 个策略组件 |
| `agent-runtime-commands.ts` | 1087 | 共享协议类型 | 属于 command 协议契约，默认保留；只有类型依赖明显形成边界时才按 domain 拆分并保留统一导出 |
| `ChatMessage/index.tsx` | 1045 | 业务组件 | 按 `buildRenderUnits`、Markdown、思考区等实际边界拆分，不引入未经验证的 renderer 策略层 |
| `FilePreviewModal.tsx` | 980 | 业务组件 | 已有 `getPreviewRoute` 与 PDF/Excel/PPTX 组件；只抽独立预览实现，不新增 registry 抽象 |
| `qwen3-tts-client.ts` | 944 | 语音服务 | 拆模型加载、合成管线、CUDA graph 管理、缓存 |
| `SkillsPage.tsx` | 942 | 页面组件 | 抽技能卡片、编辑器、搜索筛选、分类视图 |

### P2 — 观察清单（500–800 行，单职责或纯算法可暂缓）

共 **42 个**文件，详见 [code-location-index.md](#)。其中重点关注：

- **职责可拆分的**：`screen-record-service.ts`(929)、`bridge-agent-instance-events.ts`(849)、`cron-scheduler.ts`(775)、`skill-store.ts`(708)
- **纯算法/纯状态可放宽的**：`conversation-repo.ts`(858)、`local-database.ts`(681)、`PetOrchestrator.ts`(873) — 可暂不拆但需控制增量

---

## 三、TOP 10 超标文件深度分析与拆分方案

### 1. `apps/windows/src/main/index.ts` — 2980 有效行（P0）

**当前职责混杂（一个文件做了 12+ 件事）：**
1. 全局异常保护 / EPIPE 处理
2. 应用生命周期（ready / window-all-closed / before-quit / will-quit / quit）
3. 主窗口创建（3 种窗口：主窗口 / 宠物窗口 / 调试面板）
4. 系统托盘管理（菜单 + 事件）
5. 本地 Agent Runtime、浏览器和 ACP 等服务装配
6. 多组普通 IPC handler 注册（Agent Runtime IPC 已有独立模块）
7. 渠道登录服务（微信/企微/飞书）初始化
8. 语音模块初始化（VoiceModelManager / VoiceCallService）
9. 录屏模块初始化 + IPC 注册
10. Agent Runtime Bridge 初始化 + 注入
11. ACP 后端 / Coding Dev 环境检测
12. 启动时种子任务（bundled-skills-seeder / cron-seed）

**拆分方案（复用已有模块，逐个迁移注册函数）：**

```
src/main/
├─ index.ts                          # 保留 composition root 和严格初始化顺序
├─ app-lifecycle.ts                  # app.on('ready'/'quit' 等)
├─ windows/
│   ├─ main-window-factory.ts        # 仅在现有 createWindow 边界稳定后再抽
│   └─ window-lifecycle-hooks.ts     # 仅抽与主窗口无共享状态的回调
├─ tray/
│   ├─ tray-factory.ts               # 托盘创建
│   └─ tray-menu.ts                  # 托盘菜单模板 + handler
├─ ipc/
│   ├─ system-ipc.ts                 # 仅迁移普通系统/文件 IPC
│   ├─ provider-ipc.ts               # provider 配置相关
│   └─ coding-dev-ipc.ts             # Coding Dev 相关
└─ bootstrap/
    ├─ seed-on-startup.ts            # 仅抽无状态种子任务
    └─ error-protection.ts           # 仅抽独立的错误保护
```

**验收标准：** 保持 `installAgentRuntimeCommandIpc()` 早于窗口加载、配置初始化早于依赖配置的服务、种子任务早于 watcher；每次只迁移一个注册域。行数是软指标，不为达到阈值引入全局 service locator 或重复 facade。

---

### 2. `SettingsPage.tsx` — 2447 有效行（P0）

**当前结构：** 一个 `SettingsPage` 组件内用 `switch(activeCategory)` 渲染 10 个分类，每个分类 150–400 行 JSX + 本地状态 + 保存逻辑。

**拆分方案（优先复用目录内已有 components）：**

```
SettingsPage/
├─ SettingsPage.tsx                   # 分类导航 + 路由分发
├─ SettingsPage.types.ts              # 所有 Settings 相关类型
├─ SettingsPage.const.ts              # CATEGORIES / 默认值
├─ hooks/
│   ├─ useProviderSlots.ts            # 模型配置本地状态 + 保存
│   ├─ useVoiceSettings.ts            # 语音配置本地状态 + 保存
│   └─ （只有出现重复状态逻辑时再增加共享 hook）
└─ components/
    ├─ GeneralSection.tsx             # 通用设置（通知/启动/字体…）
    ├─ WorkspaceSection.tsx           # 工作空间设置
    ├─ ModelConfigSection.tsx         # 模型配置（核心！原文件 600+ 行）
    ├─ VoiceSection.tsx               # 语音设置聚合（已抽 VoiceModelsPanel/ProfilesPanel/AsrLiveTestPanel）
    ├─ ChannelsSection.tsx            # 渠道设置（已抽）
    ├─ CodingDevSection.tsx           # ACP 设置（已抽 CodingDevAcpPanel）
    ├─ PetSection.tsx                 # 宠物设置
    ├─ UsageSection.tsx               # 用量统计（已抽 UsagePanel）
    ├─ PrivacySection.tsx             # 隐私+数据管理（已抽 SecurityLogViewer/StorageInfo）
    └─ AboutSection.tsx               # 关于+更新（已抽 UpdaterView）
```

**验收标准：** 分类渲染和保存逻辑边界清晰；先抽 `renderXXXSettings` 和已有面板，保持 `activeCategory`、保存状态和 IPC 调用时机不变。行数仅作观察指标。

---

### 3. `agent-runtime-ipc.ts` — 2382 有效行（P0）

**当前问题：** 只有一个 `agent-runtime:command` IPC 通道，但 command handler、共享 bridge 引用、事件推送和多个领域分支集中在同一文件。

**拆分方案：** 保留一个 IPC 注册入口，按 command domain 拆分 `handleCommand` 的实现：

```
ipc/
├─ agent-runtime-ipc.ts              # 保留通道注册、共享状态和兼容导出
└─ agent-runtime-commands/
    ├─ conversation-commands.ts      # conversation/message/session command
    ├─ agent-commands.ts              # agent instance/definition command
    ├─ memory-commands.ts             # memory/storage command
    ├─ tool-commands.ts               # tool/permission/MCP command
    └─ scheduler-commands.ts          # cron/compact command
```

**验收标准：** `agent-runtime:command` 名称、command 类型、返回值、NOT_READY 行为和错误传播不变；保留 `handleCommand`、`pushAgentRuntimeEvent` 等现有调用方契约。不要把一个 IPC 通道改成多个通道。

---

### 4. `system-prompt-builder.ts` — 1909 有效行（P0）

**拆分方案（先建立输出快照，再抽纯函数）：**

```
packages/agent-runtime/src/prompt/
├─ system-prompt-builder.ts           # buildSystemPrompt 主入口 + 编排
├─ system-prompt.types.ts             # SkillInfo / CustomAgentInfo / ActivationHint 等接口
├─ sections/
│   ├─ skills-section.ts              # 对应现有 buildSkillsSection
│   ├─ runtime-section.ts              # 对应现有 buildRuntimeSection
│   ├─ memory-section.ts              # 对应现有 buildMemorySection
│   ├─ workspace-section.ts           # 对应现有 buildWorkspaceSection
│   └─ remaining-sections.ts           # 仅在边界清晰时继续拆分
└─ prompt.types.ts                     # 只有类型依赖形成清晰边界时才抽
```

**验收标准：** 保持 static/dynamic prompt 分层、section 顺序、标签、缓存边界和空 section 行为；用 golden/snapshot 测试比较拆分前后结果。行数不是强制目标。

---

### 5. `preload/index.ts` — 1913 有效行（P0）✅ 已完成（1406 行，详见 code-location-index.md P0-05）

实际拆分未采用下方嵌套目录方案，改为扁平化放在 `preload/api/*.ts`（13 个模块），类型声明保留在 `index.ts`（无需求不新建 `electron-api.types.ts`）。`electronAPI` 对象已全部改为 `xxx: xxxApi` 委托引用。

**原拆分方案（设计草稿，未采用嵌套目录）：** 按现有 `electronAPI` 对象结构分组，保持暴露对象和多个全局 service 名称不变：

```
preload/
├─ index.ts                           # contextBridge.exposeInMainWorld 聚合
├─ electron-api.types.ts              # ElectronAPI 及其 capability 类型
├─ bridge/
│   ├─ runtime-api.ts                 # Agent Runtime 方法 (~30 项)
│   ├─ window-api.ts                  # 窗口/托盘/主进程控制
│   ├─ file-api.ts                    # 文件/工作空间/对话框
│   ├─ channel-api.ts                 # channelService 相关能力
│   ├─ voice-api.ts                   # 语音 TTS/ASR/VAD
│   ├─ screen-record-api.ts           # 录屏
│   ├─ pet-api.ts                     # 宠物（已抽）
│   ├─ system-api.ts                  # 系统信息/通知/剪贴板
│   ├─ skills-api.ts                  # 技能/商店能力
│   └─ app-api.ts                     # app/updater/vcs 等能力
└─ event-mux/
    └─ listeners.ts                   # 仅在共享监听逻辑确实重复时抽取
```

**验收标准：** 保持 `electronAPI` 属性结构、IPC channel、事件取消函数行为以及 `weixinService`/`wecomService`/`feishuService`/`channelService` 的全局暴露。类型文件移动后同步 `renderer/global.d.ts` 和测试 mock。

---

### 6. `ChatPage.tsx` — 1755 行（P0）

**拆分方案：**

```
ChatPage/
├─ ChatPage.tsx                       # 布局 + 状态编排
├─ ChatPage.types.ts
├─ hooks/
│   ├─ useChatPageState.ts            # 本地状态聚合（zoom、auto-approve、toast…）
│   ├─ useChatInputHandler.ts         # 发送消息/文件/图片/斜杠命令
│   ├─ useSessionLifecycle.ts         # 会话切换/创建/清空 hook
│   ├─ useWorkspacePanels.ts          # 文件面板 + 版本面板显隐
│   └─ useVoiceCallPanel.ts           # 语音通话面板控制
└─ layout/
    ├─ ChatSidebarArea.tsx            # 侧栏 + 状态
    ├─ ChatMainArea.tsx               # 消息容器 + 输入框
    ├─ WorkspacePanels.tsx            # 文件/版本/工作台面板组合
    └─ FloatingOverlays.tsx           # Toast / Modal / AskUser / ConfirmDialog / InterruptBanner
```

**验收标准：** ChatPage 只保留页面编排和必要共享状态；复用现有 ChatSidebar、ChatContainer、ChatInput、workspace 组件。拆分前后保持发送、会话切换、面板显隐、语音通话和版本控制行为不变，行数只作观察指标。

---

## 四、重构通用约束（防止 AI 生成代码再次膨胀）

### 4.1 MR 门禁规则
- 大文件行数只作为 review 信号，不作为所有文件的硬错误。
- 必须说明拆分后的职责边界、公共 API 和初始化/状态顺序是否保持不变。
- 协议类型、纯算法、测试、vendor、生成代码和调试沙盒按职责评估，不为降低行数制造空壳文件。
- 如需启用 `max-lines`，只配置一条实际规则，并通过路径覆盖为协议类型、测试和 vendor 设置例外；当前仓库尚未安装 `eslint-plugin-max-lines`。

### 4.2 函数粒度约束
- 单函数 > 120 行作为 review 信号；只有职责混杂、难以测试或存在稳定子边界时才拆分，不为达到数字机械切函数。
- 复杂分支只有在分支行为可独立、且确实存在扩展点时才使用策略/映射；类型穷举 switch、状态转换和共享上下文逻辑不要机械改写。
- React 组件渲染函数 JSX 嵌套 > 3 层：抽子组件。

### 4.3 导入导出规范
- **禁止默认导出业务组件/服务**（React.lazy 等场景例外），一律命名导出。
- 类型抽到 `*.types.ts`，禁止在业务文件里放 20+ 行 `interface/type`。
- 常量抽到 `*.const.ts`，禁止散落组件内。
- **禁止循环 import**：拆分后跑 `pnpm typecheck`；如引入循环依赖检查工具，必须先加入仓库 devDependency 和 CI 固定版本。

### 4.4 反模式识别（AI 生成代码高频踩坑）
1. **"堆肉式"组件**：一个组件文件 1000 行，全是 `useState` + `handleXXX` + JSX，没有子组件拆分。
2. **"洋葱式" IPC**：一条 IPC handler 写 100+ 行，包含权限、业务、持久化、回包。
3. **"上帝模块"**：一个 class 塞 30+ 方法，所有依赖都通过 `this.xxx` 访问。
4. **"复制粘贴"类型**：同一个 interface 在 3+ 个文件里重复定义，没有抽到 shared。

---

## 五、重构执行路线图

### 阶段 1：P0 清欠（按小提交推进，不预设工期）

| 顺序 | 任务 | 协作范围（示例） | 产出 |
|---|---|---|---|
| 1 | 建立基线 | 全体 | 运行实际 workspace typecheck/test，记录 IPC、Preload、Prompt 和初始化契约 |
| 2 | 纯函数和低风险 UI 抽取 | Agent Runtime / 前端 | 先抽 Prompt section、Settings/ChatPage 的真实职责边界 |
| 3 | `agent-runtime-ipc.ts` | 主进程 + Agent Runtime | 保留单通道，按 command domain 拆 dispatcher |
| 4 | `preload/index.ts` | 主进程 / 前端 | 保持 electronAPI 和全局 service 兼容 |
| 5 | `src/main/index.ts` | 主进程 | 最后迁移初始化和 IPC 注册，逐域验证顺序 |
| 6 | 回归 | 全体 | typecheck、workspace test、契约测试和关键路径手动回归 |

### 阶段 2：P1 推进（按需，穿插在日常迭代）
- 每个 feature 分支顺手拆分 1–2 个 P1 文件，不做集中大改。
- 原则：**改到哪个大文件，就把那个文件顺手拆了**，不要积累。

### 阶段 3：按实际需要增加门禁
- 先稳定职责边界和测试，再决定是否引入 max-lines。
- CI 至少运行现有 workspace typecheck 和各 package 已有 test script。
- 循环依赖检查工具只有在固定依赖版本后才加入 CI。

---

## 六、重构校验清单（每项必过）

- [ ] `pnpm typecheck` 全 workspace 零报错
- [ ] `pnpm --filter lumii-windows typecheck`
- [ ] `pnpm --filter lumii-windows test`
- [ ] `pnpm --filter @mtbot/agent-runtime typecheck`
- [ ] `pnpm --filter @mtbot/agent-runtime test`
- [ ] 行数变化已解释，没有为了降低行数制造空壳文件
- [ ] IPC、Preload API、Prompt 输出和初始化顺序契约保持不变
- [ ] 类型集中在 `*.types.ts`，无跨文件重复 interface
- [ ] 拆分前后关键行为一致：发消息、调工具、语音通话、录屏、渠道发信、文件预览和设置保存均完成回归
- [ ] 文件命名：从文件名即可判断职责（如 `bridge-tool-registrar.ts` ✅，`utils.ts` ❌ 聚合太泛）

---

## 七、详细文件索引

所有当前 104 个 >400 行文件的分级、问题诊断、具体拆分建议见：

👉 **[code-location-index.md](./code-location-index.md)**
