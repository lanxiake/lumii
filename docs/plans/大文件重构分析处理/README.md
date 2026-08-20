# 灵栖 Lumii 大文件重构分析报告

> 生成时间：2026-08-20
> 统计范围：`apps/windows` + `packages/*` 下所有 `.ts` / `.tsx`（排除 `.d.ts`、`node_modules`、构建产物）
> 行数统计口径：**排除纯空行**，保留注释与代码

---

## 一、总体统计

| 指标 | 数值 |
|---|---|
| 扫描文件总数 | 1131 |
| >400 行文件数（建议考虑拆分） | 107 |
| >500 行文件数（警戒阈值，必须拆分） | 66 |
| 最大文件行数 | 3055（`src/main/index.ts`） |

### 按文件类别分布（>500 行警戒阈值）

| 类别 | 文件数 | 典型文件 |
|---|---|---|
| 业务组件 `.tsx` | 25 | `SettingsPage.tsx`、`ChatPage.tsx`、`AgentsPage.tsx` |
| 主进程服务 `.ts` | 18 | `index.ts`、`voice-service.ts`、`skill-runtime.ts` |
| Agent Runtime 桥接/核心 | 10 | `bridge-tool-registrar.ts`、`bridge.ts`、`system-prompt-builder.ts` |
| Hooks / Store / Context | 6 | `useAgentRuntime.ts`、`useSkillStore.ts`、`agent-runtime-store.ts` |
| 共享常量 / 类型 / 协议 | 4 | `agent-runtime-commands.ts`、`agent-runtime-events.ts` |
| 浏览器自动化 / 工具库 | 3 | `extension-relay.ts`、`pw-session.ts` |
| 测试文件 `.test.ts(x)` | 6 | （测试文件建议优先抽取 fixture，不强制业务线拆分） |

---

## 二、分级标准与优先级

### P0 — 立即重构（>1500 行，严重影响 AI 上下文检索与 Code Review）

共 **6 个**文件，均属「巨型单体」，存在严重职责混杂：

| 优先级 | 文件 | 行数 | 类别 | 主要问题 |
|---|---|---|---|---|
| P0 | `apps/windows/src/main/index.ts` | 3055 | 主进程入口 | 窗口/托盘/IPC注册/渠道登录/语音/录屏/网关 全部塞入口 |
| P0 | `apps/windows/src/renderer/pages/SettingsPage/SettingsPage.tsx` | 2404 | 页面组件 | 10 个分类面板 + 模型配置/语音/渠道/宠物/隐私 全部在一个文件 |
| P0 | `apps/windows/src/main/ipc/agent-runtime-ipc.ts` | 2382 | IPC 层 | 50+ 条 IPC handler 混装，未按能力域分组 |
| P0 | `packages/agent-runtime/src/prompt/system-prompt-builder.ts` | 2005 | Prompt 构建 | 类型定义 + 10+ section 构建器 + 格式化工具 混杂 |
| P0 | `apps/windows/src/preload/index.ts` | 1924 | Preload 桥 | 70+ 条 ElectronAPI 方法 + 事件多路复用 + 类型引用混杂 |
| P0 | `apps/windows/src/renderer/pages/ChatPage/ChatPage.tsx` | 1755 | 页面组件 | 会话列表 + 消息渲染 + 输入框 + 工作空间面板 + 语音通话 + 版本控制 全部在一个组件 |

### P1 — 计划内重构（800–1500 行，单文件已承担 3+ 职责）

共 **17 个**文件：

| 文件 | 行数 | 类别 | 建议拆分方向 |
|---|---|---|---|
| `bridge-tool-registrar.ts` | 1563 | Agent Bridge | 按工具域抽：`tools-core.ts` / `tools-browser.ts` / `tools-channel.ts` / `tools-voice.ts` |
| `bridge.ts` | 1465 | Agent Bridge | 拆生命周期、事件、配置三部分，保留主类聚合 |
| `event-handler.ts` (useAgentRuntime) | 1409 | Hooks 业务 | 按事件类型抽：`handle-tool.ts` / `handle-message.ts` / `handle-compact.ts` |
| `model-manager.ts` (voice) | 1370 | 语音服务 | 拆下载器、模型索引、设备检测、模型加载状态 |
| `voice-service.ts` | 1345 | 语音服务 | 拆 VAD 对接、ASR 对接、TTS 队列、通话状态机 |
| `AgentsPage.tsx` | 1296 | 页面组件 | 抽 `AgentEditor.tsx` / `AgentCapabilityConfig.tsx` / `views/*.tsx` 已在目录 |
| `weixin-login-service.ts` | 1272 | 渠道服务 | 拆登录流程、会话存储、消息收发、二维码处理 |
| `controller.ts` (app-ui-control) | 1217 | UI 控制 | 截图 / OCR / 窗口操作 / DOM 操作 分模块 |
| `ChatInput/index.tsx` | 1187 | 业务组件 | 拆附件处理、ComposerPlusMenu、工具栏、输入框核心 |
| `useAgentRuntime.ts` | 1156 | Hooks 业务 | 拆 actions / selectors / init / lifecycle，store 已单独文件 |
| `skill-runtime.ts` | 1151 | 技能运行时 | 拆执行器调度、权限确认、超时控制、导入导出、日志 |
| `ToolCallCard/index.tsx` | 1101 | 业务组件 | 拆 10+ 种工具卡片子组件（bash / file / web / skill / image…） |
| `agent-runtime-commands.ts` | 1087 | 共享常量 | 纯协议/常量可放宽，但可按 domain 分文件聚合导出 |
| `ChatMessage/index.tsx` | 1045 | 业务组件 | 拆渲染策略（用户/助手/系统/tool）、富文本渲染、引用块 |
| `FilePreviewModal.tsx` | 980 | 业务组件 | 拆 8+ 种预览器（image/pdf/video/audio/code/text/3d/markdown） |
| `qwen3-tts-client.ts` | 944 | 语音服务 | 拆模型加载、合成管线、CUDA graph 管理、缓存 |
| `SkillsPage.tsx` | 942 | 页面组件 | 抽技能卡片、编辑器、搜索筛选、分类视图 |

### P2 — 观察清单（500–800 行，单职责或纯算法可暂缓）

共 **43 个**文件，详见 [code-location-index.md](#)。其中重点关注：

- **职责可拆分的**：`screen-record-service.ts`(929)、`bridge-agent-instance-events.ts`(849)、`bridge-instance-factory.ts`(790)、`cron-scheduler.ts`(775)、`skill-store.ts`(708)
- **纯算法/纯状态可放宽的**：`conversation-repo.ts`(858)、`local-database.ts`(681)、`PetOrchestrator.ts`(873) — 可暂不拆但需控制增量

---

## 三、TOP 10 超标文件深度分析与拆分方案

### 1. `apps/windows/src/main/index.ts` — 3055 行（P0）

**当前职责混杂（一个文件做了 12+ 件事）：**
1. 全局异常保护 / EPIPE 处理
2. 应用生命周期（ready / window-all-closed / before-quit / will-quit / quit）
3. 主窗口创建（3 种窗口：主窗口 / 宠物窗口 / 调试面板）
4. 系统托盘管理（菜单 + 事件）
5. Gateway WebSocket 连接管理
6. IPC Handler 注册（20+ 条 inline 写在 index）
7. 渠道登录服务（微信/企微/飞书）初始化
8. 语音模块初始化（VoiceModelManager / VoiceCallService）
9. 录屏模块初始化 + IPC 注册
10. Agent Runtime Bridge 初始化 + 注入
11. ACP 后端 / Coding Dev 环境检测
12. 启动时种子任务（bundled-skills-seeder / cron-seed）

**拆分方案（目录内新建子模块，index.ts 仅保留装配）：**

```
src/main/
├─ index.ts                          # 精简至 <200 行，纯装配
├─ app-lifecycle.ts                  # app.on('ready'/'quit' 等)
├─ windows/
│   ├─ main-window-factory.ts        # 主窗口创建
│   ├─ pet-window-factory.ts         # 宠物窗口
│   └─ window-lifecycle-hooks.ts     # 窗口关闭/聚焦/最小化事件
├─ tray/
│   ├─ tray-factory.ts               # 托盘创建
│   └─ tray-menu.ts                  # 托盘菜单模板 + handler
├─ ipc/
│   ├─ system-ipc.ts                 # 通用 IPC（剪贴板/路径/文件选择器…）
│   ├─ provider-ipc.ts               # provider 配置相关
│   ├─ agents-ipc.ts                 # agents repo 相关
│   ├─ channel-ipc.ts                # 渠道相关（已部分抽出）
│   └─ voice-ipc.ts                  # 语音（已抽出）
└─ bootstrap/
    ├─ bootstrap-services.ts         # 初始化顺序编排
    ├─ seed-on-startup.ts            # bundled-skills / cron 种子
    └─ error-protection.ts           # EPIPE / uncaughtException
```

**验收标准：** index.ts ≤ 300 行，无 inline IPC handler，所有服务初始化走 `bootstrap-services.ts` 编排。

---

### 2. `SettingsPage.tsx` — 2404 行（P0）

**当前结构：** 一个 `SettingsPage` 组件内用 `switch(activeCategory)` 渲染 10 个分类，每个分类 150–400 行 JSX + 本地状态 + 保存逻辑。

**拆分方案（目录内已存在部分 components，只需继续抽）：**

```
SettingsPage/
├─ SettingsPage.tsx                   # ≤200 行：分类导航 + 路由分发
├─ SettingsPage.types.ts              # 所有 Settings 相关类型
├─ SettingsPage.const.ts              # CATEGORIES / 默认值
├─ hooks/
│   ├─ useProviderSlots.ts            # 模型配置本地状态 + 保存
│   ├─ useVoiceSettings.ts            # 语音配置本地状态 + 保存
│   └─ useSettingsForm.ts             # 通用表单校验/草稿
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

**验收标准：** SettingsPage.tsx ≤ 300 行，所有分类面板 ≤ 400 行；模型配置相关状态 hook 独立。

---

### 3. `agent-runtime-ipc.ts` — 2382 行（P0）

**当前问题：** 50+ 条 IPC handler 按「写的顺序」堆砌，无分组命名约定。

**拆分方案：** 按能力域分文件，`agent-runtime-ipc/index.ts` 统一 `registerAllIpc()` 聚合：

```
ipc/agent-runtime-ipc/
├─ index.ts                          # ≤100 行：聚合注册
├─ session-ipc.ts                    # 会话 CRUD（create/list/delete/clear）
├─ message-ipc.ts                    # 消息发送/重发/停止/撤销
├─ tool-permission-ipc.ts            # 工具权限审批（allow/deny/auto-approve）
├─ context-compact-ipc.ts            # 上下文压缩相关
├─ agent-ipc.ts                      # Agent 定义管理（fork/update/delete）
├─ skill-ipc.ts                      # 技能（invoke/list/search/reload）
├─ memory-ipc.ts                     # 记忆（search/read/write/manage）
├─ router-ipc.ts                     # Pre-LLM Router 相关
└─ cron-ipc.ts                       # Cron 任务（已部分在 cron-scheduler）
```

**验收标准：** 原文件删除；每个子文件 ≤ 400 行；类型定义抽到 `types.ts`。

---

### 4. `system-prompt-builder.ts` — 2005 行（P0）

**拆分方案：**

```
packages/agent-runtime/src/prompt/
├─ system-prompt-builder.ts           # ≤300 行：buildSystemPrompt 主入口 + 编排
├─ system-prompt.types.ts             # SkillInfo / CustomAgentInfo / ActivationHint 等接口
├─ sections/
│   ├─ role-section.ts                # 身份/人格/灵魂设定
│   ├─ tool-section.ts                # 工具说明 + 安全约束
│   ├─ skill-section.ts               # 技能描述 + 激活提示
│   ├─ agent-team-section.ts          # 多 Agent 协作
│   ├─ memory-section.ts              # 记忆上下文 + 指引
│   ├─ conversation-section.ts        # 历史消息注入
│   ├─ workspace-section.ts           # 工作空间状态 + Git
│   ├─ diagnostic-section.ts          # 日志路径 + CLI + 系统状态（5s 缓存）
│   └─ format-rules-section.ts        # 响应格式规则（JSON/thinking/tool-call）
└─ formatters/
    ├─ skill-list-formatter.ts
    ├─ activation-hint-formatter.ts
    └─ tool-schema-formatter.ts
```

**验收标准：** 主入口 ≤ 300 行，每个 section ≤ 250 行；类型与实现分离。

---

### 5. `preload/index.ts` — 1924 行（P0）

**拆分方案：** 按能力域分组 API：

```
preload/
├─ index.ts                           # ≤200 行：contextBridge.exposeInMainWorld 聚合
├─ ElectronAPI.d.ts                   # 抽出 ElectronAPI 接口汇总（800 行上限）
├─ bridge/
│   ├─ runtime-api.ts                 # Agent Runtime 方法 (~30 项)
│   ├─ window-api.ts                  # 窗口/托盘/主进程控制
│   ├─ media-api.ts                   # 本地媒体协议/文件
│   ├─ channel-api.ts                 # 渠道（微信/企微/飞书）
│   ├─ voice-api.ts                   # 语音 TTS/ASR/VAD
│   ├─ screen-record-api.ts           # 录屏
│   ├─ pet-api.ts                     # 宠物（已抽）
│   └─ system-api.ts                  # 系统信息/通知/剪贴板
└─ event-mux/
    ├─ voice-event-mux.ts             # voice:event 多路复用（现有 voiceEventSubscribers）
    ├─ screen-record-event-mux.ts     # screen-record 事件多路复用
    └─ runtime-event-mux.ts           # AgentRuntime 事件统一订阅
```

**验收标准：** preload/index.ts ≤ 200 行，`ElectronAPI` 接口独立 `.d.ts`（≤800 行）。

---

### 6. `ChatPage.tsx` — 1755 行（P0）

**拆分方案：**

```
ChatPage/
├─ ChatPage.tsx                       # ≤300 行：布局 + 状态编排
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

**验收标准：** ChatPage.tsx ≤ 300 行；组件内无 50 行以上的内联回调，均抽为 hook 或子组件。

---

## 四、重构通用约束（防止 AI 生成代码再次膨胀）

### 4.1 MR 门禁规则
- **任何新增 / 修改的 `.ts/.tsx` 文件超过 500 行，一律打回**，要求拆分后再合入。
- **例外审批需附理由**：纯常量映射表（如 `agent-runtime-commands.ts`）、自动生成代码、第三方绑定。
- 推荐 ESLint 插件：`eslint-plugin-max-lines`，规则设置：
  ```json
  "max-lines/max-lines": ["warn", { "max": 400, "skipBlankLines": true, "skipComments": false }]
  "max-lines/max-lines": ["error", { "max": 500, "skipBlankLines": true }]
  ```

### 4.2 函数粒度约束
- 单函数 > 120 行打回，必须拆子函数。
- 复杂 `if-else` / `switch` 超过 5 个分支：用策略模式 / 对象映射。
- React 组件渲染函数 JSX 嵌套 > 3 层：抽子组件。

### 4.3 导入导出规范
- **禁止默认导出业务组件/服务**（React.lazy 等场景例外），一律命名导出。
- 类型抽到 `*.types.ts`，禁止在业务文件里放 20+ 行 `interface/type`。
- 常量抽到 `*.const.ts`，禁止散落组件内。
- **禁止循环 import**：拆分后跑 `pnpm typecheck` + `madge --circular apps/windows/src` 校验。

### 4.4 反模式识别（AI 生成代码高频踩坑）
1. **"堆肉式"组件**：一个组件文件 1000 行，全是 `useState` + `handleXXX` + JSX，没有子组件拆分。
2. **"洋葱式" IPC**：一条 IPC handler 写 100+ 行，包含权限、业务、持久化、回包。
3. **"上帝模块"**：一个 class 塞 30+ 方法，所有依赖都通过 `this.xxx` 访问。
4. **"复制粘贴"类型**：同一个 interface 在 3+ 个文件里重复定义，没有抽到 shared。

---

## 五、重构执行路线图

### 阶段 1：P0 清欠（预计 5–7 个工作日，可并行 2 人）

| 周 | 任务 | 负责人（示例） | 产出 |
|---|---|---|---|
| W1-D1 | `preload/index.ts` 拆分 | 主进程 | `preload/bridge/*` + `preload/event-mux/*` + `ElectronAPI.d.ts` |
| W1-D2 | `src/main/index.ts` 拆分 | 主进程 | `windows/*` + `tray/*` + `ipc/*` + `bootstrap/*` |
| W1-D3 | `agent-runtime-ipc.ts` 拆分 | 主进程 + Agent Runtime | `ipc/agent-runtime-ipc/*` 9 个能力域文件 |
| W2-D1 | `SettingsPage.tsx` 拆分 | 前端 | 10 个 Section + 3 个 hooks |
| W2-D2 | `ChatPage.tsx` 拆分 | 前端 | layout/* + hooks/*，主组件精简到 300 行 |
| W2-D3 | `system-prompt-builder.ts` 拆分 | Agent Runtime | 10 个 section 文件 |
| W2-D4 | 全部回归 `pnpm typecheck` + `pnpm test` | 全体 | 无编译错误；关键路径测试通过 |

### 阶段 2：P1 推进（按需，穿插在日常迭代）
- 每个 feature 分支顺手拆分 1–2 个 P1 文件，不做集中大改。
- 原则：**改到哪个大文件，就把那个文件顺手拆了**，不要积累。

### 阶段 3：ESLint 门禁
- 阶段 1 完成后，立即引入 `eslint-plugin-max-lines`，设置 400 行 warn、500 行 error。
- CI 中加入 `tsc --noEmit` + madge 循环依赖检查。

---

## 六、重构校验清单（每项必过）

- [ ] `pnpm typecheck` 全 workspace 零报错
- [ ] `npx madge --circular apps/windows/src` 无循环依赖
- [ ] 单文件行数：业务组件≤400 行；服务/Hooks≤300 行；工具≤500 行；纯常量≤1000 行
- [ ] 无内联默认导出（除 `React.lazy` 等特殊场景）
- [ ] 类型集中在 `*.types.ts`，无跨文件重复 interface
- [ ] 拆分前后关键行为一致：跑 `pnpm test` + 手动回归主路径（发消息、调工具、语音通话、录屏、渠道发信）
- [ ] 文件命名：从文件名即可判断职责（如 `bridge-tool-registrar.ts` ✅，`utils.ts` ❌ 聚合太泛）

---

## 七、详细文件索引

所有 107 个 >400 行文件的分级、问题诊断、具体拆分建议见：

👉 **[code-location-index.md](./code-location-index.md)**
