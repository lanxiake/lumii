# 灵栖 Lumii

本地优先的 Windows 桌面 AI 伙伴 —— 开源独立版。

Lumii 是一个运行在 Windows 桌面的全栈 AI 助手：对话、Agent 执行、技能调用、定时任务、语音交互、Live2D 桌宠陪伴、浏览器自动化、屏幕录制等全部能力**本机运行**。无需自建后端、无需用户登录，模型服务商由用户在客户端直连配置（direct-stream 架构）。

---

## 一、设计核心思想与目标

### 核心理念

| 原则 | 说明 |
|------|------|
| **本地优先 (Local-First)** | 对话历史、长期记忆、Agent 定义、用户配置 100% 存储在本机 SQLite（`~/.lumii/`），用户拥有完整的数据主权 |
| **直连模型 (Direct-Stream)** | LLM 请求从客户端直接发往服务商（OpenAI / Anthropic / 兼容 OpenAI 协议的任意端点），无中转、无代理、不劫持 API Key |
| **无后端、无登录** | 应用冷启动即可用，不强制注册、不绑定账号；Gateway 是可选的远程扩展通道，非核心路径 |
| **能力即技能 (Skill-as-Capability)** | 所有扩展能力以磁盘上的 `SKILL.md` + 脚本目录存在，用户可自由编写、安装、分发、热更新 |
| **桌宠即交互 (Pet-as-Interface)** | Live2D 虚拟人不只是装饰，而是具备情绪状态、口型同步、语音播报、Agent 状态映射的第二交互界面 |

### 目标

1. **个人生产力中枢**：把聊天、代码、文档、浏览器、IM 多渠道统一到一个桌面入口
2. **Agent 编排工作台**：支持多 Agent 协作、子 Agent 派生、定时流水线
3. **可离线运行**：在断网环境下，本地 ASR/TTS、SQLite 记忆、文件操作、技能脚本仍可使用
4. **开发者友好**：monorepo 架构、包不预编译、TypeScript 源码直出，调试改造成本最低

---

## 二、架构设计

### 2.1 三进程边界（Electron 经典分层）

```
┌─────────────────────────────────────────────────────────┐
│  Renderer Process (React 18 + Vite)                      │
│  ├── pages/   ChatPage · AgentsPage · SkillsPage ...    │
│  ├── components/ui  (Badge/Button/Card/Modal/Table...)  │
│  ├── contexts + hooks    (无 Redux，纯 React 状态)       │
│  └── pet/       pixi.js 6 + Live2D 桌宠渲染层            │
└───────────────────────┬─────────────────────────────────┘
                        │ contextBridge (IPC 白名单)
┌───────────────────────▼─────────────────────────────────┐
│  Preload Script (preload/index.ts)                      │
│  唯一出口 ElectronAPI，1700+ 行，定义全部 IPC 方法与类型  │
└───────────────────────┬─────────────────────────────────┘
                        │ Node Integration 关闭
┌───────────────────────▼─────────────────────────────────┐
│  Main Process (Node.js 22 · Electron 36)                │
│  ├── 窗口 / 托盘 / IPC 注册 (main/index.ts ~3000 行)    │
│  ├── agent-runtime/   Agent 运行时 Electron 桥接层       │
│  ├── channel/         飞书/企微/微信 IM 适配器           │
│  ├── skill-*          技能运行时 + 沙箱 + 热更新          │
│  ├── voice/           ASR · TTS · VAD · 声纹克隆         │
│  ├── pet/             桌宠窗口管理 + 虚拟人激活           │
│  ├── browser-service  Playwright 浏览器自动化            │
│  ├── screen-record/   FFmpeg 录屏 + 字幕烧录             │
│  ├── app-ui-control/  截屏 + 点击 + UI 自动化            │
│  └── workspace-vcs    isomorphic-git 项目版本快照        │
└─────────────────────────────────────────────────────────┘
```

**关键约束**：新增一条 IPC 必须三处同步 —— main 侧 handler → preload 的 `ElectronAPI` 方法与类型 → renderer 调用点。

### 2.2 Agent 运行时分层

```
packages/agent-runtime/           (通用、纯 TS，与 Electron 解耦)
├── kernel/        @mariozechner/pi-agent-core 驱动封装
├── llm/           direct-stream 直连模型 + 路由 + 错误自愈
├── agent/         实例生命周期 · 注册 · 定义存储 · 卡死检测
├── tools/         30+ 内置工具 + MCP 代理 + Hook 机制
├── memory/        分段记忆 · 提取 · 巩固 · 记忆宫殿注入
├── compact/       上下文压缩（硬裁剪 / 微压缩 / 摘要压缩）
├── security/      权限检查 · 参数白名单 · 沙箱 · 用户确认
├── skill/         技能激活解析 · 运行时编排
├── shell/         PowerShell / CMD / Bash 多终端适配
└── storage/       SQLite (node:sqlite + better-sqlite3 回退)

apps/windows/src/main/agent-runtime/  (Electron 专属桥接)
├── bridge-instance-factory     Agent 实例构造
├── bridge-tool-registrar       工具注册（含桌面专属工具）
├── bridge-prompt-dispatcher    用户消息派发
├── bridge-agent-instance-events 事件流 → IPC → UI
├── bridge-context-compactor    上下文压缩持久化
├── cron-scheduler              croner 定时任务驱动
└── router/                     语义路由 + 快速路径 + 命中率统计
```

**修改判断规则**：模型/工具/记忆等通用逻辑 → `packages/agent-runtime`；窗口/托盘/文件对话框等桌面能力 → `main/agent-runtime`。

### 2.3 共享包（pnpm workspace monorepo）

所有 `packages/*` 入口都是 `.ts` 源码，不做预编译。`electron.vite.config.ts` 通过绝对路径 alias 把 `@mtbot/*` 指向源码，并从 externalize 名单中排除以打进 bundle。

| 包 | 职责 | 可引入依赖 |
|----|------|-----------|
| `@mtbot/agent-runtime` | Agent 循环核心（见上文） | pi-agent-core、TypeBox |
| `@mtbot/browser-control` | Playwright 封装（浏览 + 截图 + 下载 + AI 感知） | playwright-core 1.58.1 |
| `@mtbot/pet-core` | 桌宠状态机 + 口型波形 + 表情策略 + 渲染命令 | **零** react/electron/pixi/DOM |
| `@mtbot/protocol` | Gateway 协议门面（TypeBox + AJV 校验） | - |
| `@mtbot/client-sdk` | 传输无关 Gateway 客户端原语 | - |

---

## 三、项目文件结构

```
lumii/
├── apps/
│   └── windows/                     # 唯一应用：Windows 桌面端
│       ├── assets/                  # logo、icon、splash 启动视频
│       ├── bundled-skills/          # 随包内置技能（只读分发）
│       │   ├── weather/
│       │   ├── 代码开发/coding-agent/
│       │   ├── 文档与分析/{docx,pdf,pptx,xlsx,summarize,...}/
│       │   ├── 设计与可视化/Art/
│       │   ├── 智能体协作/agent-team/
│       │   └── 技能管理/{cli-hub,skill-creator}/
│       ├── build-resources/         # NSIS 安装器脚本、license
│       ├── config/                  # draw-config / server-config
│       ├── docs/                    # 内置技能策略等文档
│       ├── pet-lab/                 # Live2D 调试沙盒 (vite 独立启动)
│       ├── resources/
│       │   ├── live2d/              # Cubism 4 Core JS
│       │   ├── pet-models/          # 桌宠模型（mao_pro、ug_official、xiaomai...）
│       │   └── app-ui-cli/          # UI 自动化 CLI 工具
│       ├── scripts/                 # 构建/打包/开发 PowerShell 脚本
│       ├── src/
│       │   ├── main/                # Electron 主进程
│       │   ├── preload/             # contextBridge 桥接层
│       │   ├── renderer/            # React 渲染进程
│       │   │   ├── pages/           # 9 个顶级页面
│       │   │   ├── components/      # ui / layout / business
│       │   │   ├── contexts/        # Theme / Settings / ... Provider
│       │   │   ├── hooks/           # common + business 自定义 hooks
│       │   │   ├── services/        # agent-service / screen-record-api ...
│       │   │   ├── styles/          # design-system.css + tokens
│       │   │   └── pet/             # pixi.js 桌宠渲染层
│       │   ├── shared/              # 主/渲双侧共享类型与事件常量
│       │   ├── test/                # vitest 单测 & 组件测试
│       │   └── types/               # 全局 TS 声明
│       ├── electron-builder.json    # electron-builder 打包配置
│       └── electron.vite.config.ts  # 三进程构建 + 兼容补丁插件
│
├── packages/                        # 跨端共享库（源码直出）
│   ├── agent-runtime/               # Agent 核心（见 §2.2）
│   ├── browser-control/             # Playwright 浏览器控制
│   ├── pet-core/                    # 桌宠纯逻辑（零渲染依赖）
│   ├── protocol/                    # Gateway 协议类型门面
│   └── client-sdk/                  # Gateway 客户端原语
│
├── docs/
│   ├── plans/                       # 带日期的设计与实施文档（30+ 份）
│   ├── design/                      # 架构设计稿
│   ├── standards/                   # 代码/组件/页面开发规范
│   └── prompts/                     # 系统提示词模板
│
├── demos/ui-tech-refresh/           # UI 视觉原型 demo
├── patches/                         # pnpm.overrides 补丁（当前 @mariozechner/pi-ai）
├── scripts/                         # 根目录开发脚本（dev start/stop/restart）
├── CLAUDE.md                        # AI 协作指南
├── LICENSE                          # MIT
└── README.md                        # 本文件
```

---

## 四、技术路线

### 4.1 语言与框架

- **语言**：TypeScript 5.3（strict 模式）
- **桌面壳**：Electron 36（Node.js 22.19，内置 `node:sqlite`）
- **前端框架**：React 18 + CSS Modules + lucide-react 图标
- **构建**：electron-vite 4（Vite 5 封装），主/预载/渲三进程独立构建
- **打包**：electron-builder 26，产物 NSIS 安装器 / Portable / ZIP

### 4.2 核心依赖选型

| 领域 | 选型 | 备注 |
|------|------|------|
| **Agent 内核** | `@mariozechner/pi-agent-core` 0.50.7 | pnpm override 锁版 + 本地补丁 |
| **存储** | `node:sqlite` 原生 + `better-sqlite3` 12.8 回退 | 自动备份（每日 3:00，保留 10 份）+ 损坏自愈 |
| **桌宠渲染** | `pixi.js` 6.5.10 + `pixi-live2d-display` 0.4.0 | **版本锁死**，升级必测 Cubism 4 兼容性 |
| **浏览器自动化** | `playwright-core` 1.58.1 | app 与 browser-control 包必须同版本 |
| **语音** | `msedge-tts`（Edge 流式 TTS）、`sherpa-onnx-node`（本地 ASR/VAD）、`qwen3-tts`（本地声纹克隆） | 模型下载 `modelscope_downloader.py` |
| **文档解析** | `pdf-parse` · `mammoth`(docx) · `xlsx` · `pptx-preview` · `epub2` | pptx-preview 由 `patchPptxPreviewPlugin` Vite 插件现场打补丁 |
| **图像处理** | `sharp` 0.34 + `@img/sharp-win32-x64` | postinstall 为 Electron 重建原生模块 |
| **定时任务** | `croner` 9.x | at / every / cron 表达式三态统一 |
| **图片/视频生成** | RightCodes API + 本地 H3 MiniMax 直连 | 兼容配置 `draw-config.json` |
| **Git 集成** | `isomorphic-git` 1.38 | 工作区 Turn-level 快照 + diff |
| **测试** | `vitest` 2.x（单测） · `@playwright/test` 1.58（E2E） · `@testing-library/react` 16（组件） |
| **代码质量** | `eslint`（见 apps/windows `pnpm lint`） · `tsc --noEmit` 类型检查 |

### 4.3 关键工程技巧

1. **Electron 兼容补丁插件**（`electronCompatPlugin`）：解决 undici 的 `require("node:sqlite")` 与缺失 `globalThis.File`
2. **workspace 包 alias**：`@mtbot/agent-runtime` → 源码路径 + 从 externalize 排除，实现 TS 源码直打
3. **原生模块重建**：`pnpm rebuild:native` 仅重建 `better-sqlite3` / `sharp`
4. **Windows 控制台 UTF-8**：`scripts/run-dev.cjs` + `.ps1` 脚本开头切 `chcp 65001`
5. **路径别名三套一致**：`@/` · `@main/` · `@renderer/` · `@shared/` 分别在 tsconfig / vite / vitest 同步声明

---

## 五、客户端功能（按主题）

### 5.1 对话与交互（ChatPage）

对话是 Lumii 的主交互界面，包含：

- **多会话侧边栏**：新建、搜索、切换、删除会话，置顶 + 搜索框
- **富消息展示**：Markdown（GFM + 数学公式 KaTeX）、代码高亮（highlight.js）、表格、任务列表
- **多模态输入**：拖拽文件（支持 PDF/Word/Excel/PPT/图片/代码…）、粘贴图片、Composer Plus 菜单（@技能、#Agent、/斜杠命令）
- **工具调用可视化**：`ToolCallCard` 展示工具入参/结果、`ToolBatchGroup` 批量分组、`TurnFileChangesCard` 展示本轮文件增删改 diff
- **审批流**：高风险工具（Shell / 文件写入 / 联网…）弹出 `ApprovalCard`，支持单步/永久/拒绝，可在设置中预设白名单
- **计划审批**：复杂任务由 Agent 先出 `PlanApprovalCard`，用户确认后再分步执行
- **上下文压缩卡**：触发压缩时 `CompactionCard` 展示 token 变化、摘要、可展开旧消息
- **Todo 进度面板**：Agent 拆解的子任务实时完成率
- **工作区工作台**：`WorkspaceFilePanel` 文件树 + `WorkspaceVersionPanel` Git 快照 + `WorkspaceWorkbench` 任务工作台三合一
- **斜杠命令**：`/new` `/clear` `/compact` `/link` `/resume` `/help` 等

### 5.2 Agent 与智能体协作（AgentsPage）

- **三种视图**：Feed 视图 · Grid 卡片视图 · Map 拓扑图（@xyflow/react）
- **Agent 定义管理**：创建 / 编辑 / 克隆 / 导入导出，包含系统提示词、模型、工具白名单、温度、最大 token 等
- **团队生成向导**：`GenerateTeamWizard` —— 三步（需求 → 规划 → 审核）由 LLM 自动生成多 Agent 协作团队
- **团队优化向导**：`OptimizeTeamWizard` —— 根据历史表现推荐角色与工具配置
- **子 Agent 派生**：运行时 `spawn-agent` 工具动态创建子 Agent，父级可收回结果

### 5.3 技能系统（SkillsPage）

```
加载优先级（高 → 低）：
  1. ~/.lumii/skills/          用户已安装的技能（可卸载/更新）
  2. <workspace>/skills/       项目专属技能（SkillWatcher 热更新）
  3. <resources>/bundled-skills/  随包内置技能（只读）
```

- **技能结构**：`SKILL.md`（含 frontmatter 元数据） + `skill.json` 清单 + 脚本目录
- **多执行器**：TypeScript (`ts-runner`) · Python (`python-runner`，自动识别 venv/conda) · Shell (`shell-runner`，PS/CMD/Bash 自动选择)
- **沙箱隔离**：`skill-sandbox` 限制路径、网络、子进程；用户确认对话框
- **热更新**：`skill-watcher` 监听 `skills/` 目录，保存即生效
- **内置技能集**（bundled-skills）：

| 分类 | 技能 |
|------|------|
| 通用 | `weather` 天气、`coding-agent` 代码助手、`skill-creator` 技能生成、`cli-hub` 命令行工具链 |
| 文档 | `docx` Word、`pdf` PDF、`pptx` PPT、`xlsx` Excel、`summarize` 长文摘要、合同审查、法条转 Markdown |
| 设计 | `Art` 图像生成工作流（含 Tools/Workflows） |
| 协作 | `agent-team` 智能体团队 |

- **技能市场**：`skillnet-store.ts` IPC 对接在线技能商店（可选）
- **技能进化**：`skill-evolution/` 模块根据对话反馈自动草拟新技能并经用户确认入库

### 5.4 定时任务与流水线（CronPage）

- **四个 Tab**：概览（统计卡片 + 最近执行） · 调度（日历视图） · 流水线（DAG 图 @xyflow/react） · 历史（执行日志）
- **三种调度语法**：
  - `at`：一次性（如 2026-08-20 09:00）
  - `every`：间隔（如 every 15m / every 1h）
  - `cron`：标准五段式 cron 表达式
- **触发器类型**：运行 Agent 会话 · 运行指定技能 · 发送系统通知 · HTTP 回调
- **激活窗口**：`cron-active-window` 只在用户活跃时段触发，避免深夜弹通知
- **流水线 DAG**：`CreatePipelineModal` 可视化编排，节点间传参，失败重试策略

### 5.5 长期记忆（MemoriesPage）

- **记忆分层**：工作记忆（会话内）→ 短期记忆（最近 7 天分段）→ 长期记忆（巩固后持久化）
- **分段管线**：`segmentation` → `segment-memory-pipeline` → `memory-extractor`（LLM 抽事实）→ `memory-consolidation`（去重合并）
- **记忆宫殿可视化**：`MemPalaceViewer` 三维主题分组，支持搜索、删除、编辑
- **人格文件 (soul.md)**：基础人设、说话风格、价值观约束，模板库提供多种预设
- **记忆注入**：对话启动前 `memory-injector` 按语义检索注入最相关 10 条记忆
- **MCP 对接**：`mempalace-mcp-client` 对接外部记忆宫殿 MCP 服务

### 5.6 Live2D 桌宠与虚拟人

- **桌宠窗口**：独立透明置顶窗口，可拖拽移动、缩放、右键菜单
- **核心包分层**：
  - `@mtbot/pet-core`（纯 TS，逻辑）：状态机 `petStateMachine`、表情策略 `state-expression-policy`、口型波形 `mouth-waveform`、Agent 信号映射 `agentSignalMapper`
  - `renderer/pet/`（pixi.js 6，渲染）：`PetCanvas`、`PetLipSync`、`PetModeShell`
- **模型资源**：`mao_pro` / `ug_official` / `xiaomai` + 注册表 `registry.json`
- **情绪联动**：Agent 事件（思考中 / 工具调用 / 报错 / 完成）→ 映射为桌宠表情 + 动作 + 口型
- **语音播报**：回答生成的同时 TTS 流式输出，口型随音频振幅同步
- **虚拟人激活 (virtual-human-activation)**：根据对话内容、时段、用户活跃度智能决定是否唤醒桌宠
- **调试沙盒**：`pnpm lab` → `pet-lab/` 独立 vite 工程，单独调试 Live2D 不启动主应用

### 5.7 语音交互

- **三层引擎架构**（`voice/`）：
  - **ASR**：`asr-engine` → sherpa-onnx 本地离线识别（中文/英文模型）
  - **VAD**：`vad-engine` → 语音活动检测，自动切分句末
  - **TTS**：`tts-engine` → 三通道可切换：
    - `msedge-tts`：Edge 浏览器在线，音色多、延迟低
    - `qwen3-tts-client`：本地部署，5 秒参考音频即可声纹克隆
    - `modelscope`：离线多音色模型下载
- **语音档案 (voice-profile-store)**：保存克隆的声纹参考音频 + 预设
- **语音状态机**：`voice-state-machine` 管理 idle → listening → thinking → speaking → idle 全链路
- **边听边说**：`VoiceCallPanel` 悬浮面板，波形可视化，可打断

### 5.8 IM 多渠道接入（SettingsPage → ChannelsSection）

| 渠道 | 适配器文件 | 登录方式 | 能力 |
|------|-----------|---------|------|
| 飞书 | `feishu-channel-adapter.ts` | 自建应用 App ID/Secret + 回调 | 收发消息、slash 命令、群聊上下文 |
| 企业微信 | `wecom-channel-adapter.ts` | CorpID + AgentID + Secret + Token + AESKey | 同上 |
| 微信个人 | `weixin-channel-adapter.ts` | 扫码登录（协议级，50KB+ 大文件） | 收发私聊/群聊、语音 silk 编解码 |
| IPC 本地 | `ipc-channel-adapter.ts` | 内置 | 测试 & CLI 直通 |

- **出站路由**：`channel-outbound-router` 按规则（关键词 / 目标群 / 优先级）选择渠道
- **会话绑定**：`weixin-session-binding` 把 IM 会话绑定到对应 Lumii 对话线程
- **ACP 后端管理**：`acp-backend-manager` 支持切换到 ACP（Agent Control Plane）远程处理

### 5.9 浏览器自动化

- `@mtbot/browser-control` 包封装 Playwright：
  - `agent.act`：自然语言驱动网页点击/输入/导航
  - `agent.snapshot`：返回页面结构 + 可交互元素 JSON
  - `pw-ai-module`：把 DOM 快照喂给 LLM，循环决策直到任务完成
  - `profiles-service`：多隔离浏览器配置文件（防指纹关联）
- 主进程 `browser-service.ts` + `cloak-browser-downloader.ts`：下载管理 + 内置 Chromium

### 5.10 屏幕录制与字幕（screen-record/）

- **录制**：FFmpeg 桌面捕获 + 系统音频 + 麦克风混音，磁盘空间检测（`disk-space.ts` 阈值告警）
- **旁白生成**：`narrate-service` 调用 LLM 根据 Agent 操作生成操作说明 TTS
- **智能提示词**：`smart-cues-generator` 自动生成教程类视频的提示卡
- **字幕工程**：`subtitle-project` → SRT 解析/生成 → `burn-subtitles-service` 烧录进视频
- **字幕样式**：`subtitle-style` 自定义字体、描边、位置、动画
- **教程流水线**：结合 Agent 的 app-ui-control 操作，自动录屏 + 旁白 + 字幕 → 成品教程视频

### 5.11 应用 UI 自动化（app-ui-control/）

- 截屏（`snapshot.ts` 带坐标映射）
- 点击/输入/滚动（`act.ts`）
- 屏幕标注（`annotate.ts` —— 画框/箭头/文字）
- 跳转 URL / 激活窗口（`goto.ts`）
- 统一 HTTP 服务（`server.ts`）+ 限流（`rate-limit.ts`）+ 命令白名单
- CLI 命令：`resources/app-ui-cli/lumii-ui.mjs` 远程调用 UI 控制

### 5.12 代码开发环境集成（coding-dev-*）

- `coding-dev-cli-detect`：自动检测本机 Trae / Cursor / VS Code / JetBrains IDE
- `coding-dev-cli-install`：一键安装缺失 CLI
- `coding-dev-env`：Python / Node / Git 环境诊断
- `coding-dev-projects`：项目目录扫描 + 索引
- `coding-dev-acp-run`：ACP 协议运行代码 Agent
- `coding-dev-local-runner`：本地 JSONL 回放

### 5.13 Git 工作区版本控制（workspace-vcs + project-git）

- `workspace-turn-snapshot`：每轮对话结束自动快照工作区（isomorphic-git 轻量分支）
- `vcs-diff`：两轮之间的 diff 展示（`ChangedFilesRail` + `DiffFileCard`）
- `project-git-status`：读取真实 git 仓库状态，未提交更改告警

### 5.14 仪表板（DashboardPage）

- 虚拟人状态区（当前情绪、今日互动次数）
- Token / 费用用量图（`UsageChart` + recharts）
- 最近关注项目（`RecentFocus`）
- 新闻订阅流（`NewsFeed` + `news-store`）
- 仪表概览：CPU、内存、SQLite 大小、今日会话数

### 5.15 插件中心（PluginCenterPage）

- MCP 插件注册表：`plugins-registry.ts` 预置常用 MCP 服务
- 一键启用 / 配置 / 测试连通性
- 与 `mcp-manager.ts` + `mcp-config.ts` 联动

### 5.16 设置页（SettingsPage）

- 模型服务商配置（多提供商、API Key、Base URL、并发/重试策略）
- 渠道登录与绑定（飞书 / 企微 / 微信）
- 语音模型下载与声纹克隆
- 桌宠模型切换与参数
- 存储信息与一键清理
- 使用量面板
- 权限安全日志查看器
- MCP 高级配置
- 编码开发 ACP 面板

---

## 六、待完善的地方

### 6.1 已知工程债

1. **主进程入口过大**：`src/main/index.ts` 仍 3000+ 行，需按模块拆成 bootstrap 序列
2. **Preload 单文件**：`src/preload/index.ts` 1700+ 行，应按 domain 分片 + 自动生成类型
3. **遗留路径文案**：部分 `.env.example` / 注释仍写旧目录 `~/.mtbot-client`，需全局统一为 `~/.lumii`（`client-data-root.ts` 为准）
4. **E2E 覆盖率低**：`pnpm test:e2e` 仅跑 `e2e/memory/memory-management.spec.ts`
5. **测试命令不一致**：`vitest.config.include` 是 `src/**/*.test.ts(x)`，但 `pnpm test` 只跑 `src/test`；`src/main/**` 下的同目录测试需显式命令

### 6.2 功能缺口

- **桌宠物理交互**：当前纯 2D Live2D，碰撞检测、拖拽惯性、桌面穿透等未完成
- **跨平台**：目前仅 Windows，macOS / Linux 的 shell 适配器、托盘、原生模块需补
- **多显示器 DPI**：桌宠窗口在高分屏跨屏拖动坐标换算未覆盖所有缩放组合
- **模型价格表**：`model-pricing.ts` 覆盖不全，新模型（o3、Claude 3.7 Sonnet…）需补
- **自动更新**：`updater-service.ts` 已接入 electron-updater，但签名 & 发布流未打通

### 6.3 性能优化

- **首屏启动**：主进程 3000+ 行同步初始化 + SQLite 首次打开 VACUUM，冷启动需 3-5s
- **长对话渲染**：1000+ 条消息的虚拟滚动还未做，滚动明显卡顿
- **上下文压缩**：摘要压缩策略还偏保守，高 token 成本可进一步下降

---

## 七、未来规划

### Phase 1 — 稳定性（短期）

- [ ] 主进程入口拆分 & preload 分片
- [ ] Windows 安装包数字签名 + 自动更新流水线
- [ ] 虚拟滚动落地（ChatPage 10k 消息 60fps）
- [ ] 全量 E2E 覆盖：对话 / 技能 / 桌宠 / 渠道
- [ ] 启动优化：懒加载 tray / updater / browser 等非首屏模块

### Phase 2 — 跨端与生态（中期）

- [ ] macOS 客户端适配（shell 适配器、原生通知、触控栏）
- [ ] MCP 1.0 协议完整支持（动态工具注册、资源订阅）
- [ ] SkillNet 技能市场正式上线 + 一键安装
- [ ] 移动端 Lite 版（iOS/Android，只读同步会话）

### Phase 3 — 高级能力（长期）

- [ ] 多模态 Agent（图片理解 · 视频分析 · 屏幕感知作为原生工具）
- [ ] 桌宠 3D 化（Three.js 替换 pixi，支持 VRM 模型）
- [ ] 本地小模型端侧推理（llama.cpp 集成，离线可用）
- [ ] 插件系统 v2：WebAssembly 沙箱技能运行时
- [ ] 多设备同步（可选，端到端加密）

---

## 八、环境要求

- **操作系统**：Windows 10 21H2+ / Windows 11（x64，ia32 安装包仅 NSIS）
- **Node.js**：20.11+（推荐 22 LTS，Electron 36 内嵌 Node 22.19）
- **pnpm**：10.23+（`packageManager` 已锁）
- **磁盘空间**：开发模式 ≈ 2 GB；打包后安装包 ≈ 350 MB（含 Playwright + sherpa-onnx + Live2D）
- **可选**：Python 3.10+（Python 技能执行器 / Qwen3 本地 TTS）、Git 2.39+（工作区 VCS）

---

## 九、常用命令

### 9.1 根目录（推荐）

```bash
# 安装依赖（postinstall 自动为 Electron 重建 better-sqlite3 / sharp）
pnpm install

# 前台开发模式（electron-vite dev，热重载）
pnpm dev

# 后台启动开发模式（日志写入 .lumii-dev.log，PID 写入 .lumii-dev.pid）
pnpm dev:start

# 停止后台 dev
pnpm dev:stop

# 重启后台 dev（= start-dev.ps1 -Force）
pnpm dev:restart

# 全 workspace 递归类型检查
pnpm typecheck

# 构建三进程产物 → apps/windows/out/
pnpm build

# 打包 Windows 安装包（NSIS x64+ia32 / Portable x64 / ZIP x64）
pnpm dist
```

### 9.2 apps/windows 目录

```bash
cd apps/windows

# ESLint
pnpm lint

# TypeScript 类型检查
pnpm typecheck

# 运行 src/test 下的单测 & 组件测试
pnpm test

# 单文件 / 单用例
npx vitest run src/test/components/ChatPage.test.tsx
npx vitest run -t "会话切换"

# 运行 src/main 下同目录测试（默认 pnpm test 不覆盖）
npx vitest run src/main

# Playwright E2E（当前指向 memory-management.spec.ts）
pnpm test:e2e
pnpm test:e2e:headed    # 带浏览器窗口
pnpm test:e2e:debug     # Playwright Inspector

# Live2D 桌宠调试沙盒（pet-lab/ 独立 Vite，不启动 Electron）
pnpm lab

# 单独打包各目标
pnpm package:nsis       # NSIS 安装器（x64 + ia32）
pnpm package:portable   # 便携版 exe
pnpm package:zip        # ZIP 压缩包
pnpm package:dir        # 仅解包目录，不打安装器

# 原生模块重建（修改 better-sqlite3 / sharp 依赖后执行）
pnpm rebuild:native

# 生成应用图标（从 assets/source 生成多尺寸 icon.ico）
pnpm generate:icon
```

### 9.3 packages/* 各自

每个包都有自己的 `pnpm test` / `pnpm typecheck`：

```bash
cd packages/agent-runtime && pnpm test
cd packages/pet-core     && pnpm test
```

---

## 十、数据目录与配置

### 默认根目录

代码实际以 `src/main/client-data-root.ts` 为准，可用环境变量覆盖：

```
数据根：~/.lumii/                           # 环境变量 LUMII_CLIENT_DATA_DIR
├── config/
│   ├── provider.json                       # 模型服务商 + API Key
│   ├── agents/                             # 用户自定义 Agent 定义
│   └── mcp/                                # MCP 服务配置
├── data/
│   ├── soul.md                             # 人格（人设文件）
│   ├── memories/                           # 长期记忆分段 & 宫殿索引
│   └── skills/                             # 用户已安装技能（优先级高于 bundled）
├── db/
│   └── agent-runtime.db                    # SQLite 主库（对话 / 消息 / 工具 / 任务）
│       └── backups/                        # 自动备份（每日 3:00，保留 10 份）
├── voices/                                 # TTS 本地模型 + 克隆声纹档案
├── logs/
│   ├── main.log                            # 主进程滚动日志
│   └── skills/                             # 技能执行日志（每个技能独立）
├── workspaces/                             # 默认工作区根
│   └── <project-name>/
│       └── skills/                         # 项目专属技能（热更新）
├── .env                                    # 可选：SEARXNG_BASE_URL、LANGSEARCH_API_KEY 等
└── settings.json                           # UI 主题、桌宠开关、渠道登录态
```

> ⚠️ README 与 `.env.example` 中旧的 `~/.mtbot-client` / `MTBOT_*` 文案属历史遗留，以 `~/.lumii` / `LUMII_*` 为准。

### Web 搜索可选配置

在用户数据根的 `.env` 或 `apps/windows/.env` 设置：

```dotenv
# SearXNG 自托管（推荐，免费）
SEARXNG_BASE_URL=https://your-searxng.example.com

# 或 LangSearch API Key
LANGSEARCH_API_KEY=ls_xxx
```

核心对话与 Agent 能力不依赖这两个。

---

## 十一、许可

[MIT](LICENSE) © 2026 Lumii 贡献者。
