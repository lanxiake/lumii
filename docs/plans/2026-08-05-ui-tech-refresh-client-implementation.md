# UI Tech Refresh 落地客户端 Implementation Plan

> **For Claude:** Implement task-by-task. 对话页优先。

**Goal:** 把 `demos/ui-tech-refresh/index.html` 的视觉与交互方案落到 `apps/windows`，优先对话页组件。

**Architecture:** 纯前端改造。`--mt-*` 补 token → 各 `*.module.css` 重构 → 少量 JSX 结构调整。不动主进程、不动 IPC、不动业务 hook。

**Tech Stack:** Electron + React + CSS Modules + lucide-react

---

## 前置结论（实现时必须遵守）

**1. Token 架构已就绪，只需补充，不要新建体系**
- `styles/design-system.css` 是唯一源：深色 L146-183，浅色 L186-221
- `styles/tokens.css` L317+ 是兼容层，`--color-*` 全部转发到 `--mt-*`
- 结论：**只往 `design-system.css` 补 token**，`--color-*` 自动继承。组件里新写样式统一用 `--mt-*`

**2. 浅色主题保持现有暖奶油色，不要抄原型的冷色**
- 客户端浅色已是 `--mt-bg-primary:#F5F1E9` / `--mt-fg-1:#1F1E1B`（暖棕系）
- 原型的浅色是冷灰 `#f3f5f9`，是原型自己的临时值，**不是目标**
- 只搬原型的**结构、层级、动效**，配色沿用客户端两套主题

**3. 图标保留 lucide-react，不要换成几何字符**
- 原型里的 `◈ ◍ ▤ ✆` 是零依赖 demo 的权宜写法
- 客户端 `lucide-react` 的 `PanelLeft / Sparkles / Lightbulb / Timer / Zap` 等语义更清楚，全部保留
- 新增图标从 lucide 里挑，不要引入新图标库

**4. 组件不需要新建**
原型模拟的每一块在客户端都已存在：

| 原型 class | 客户端组件 |
|---|---|
| `.cmp` 输入区 | `ChatInput/index.tsx` |
| `.msg` `.bub` 气泡 | `ChatMessage/index.tsx` |
| `.tc` 工具卡 | `ToolCallCard/index.tsx` |
| `.apr` 审批卡 | `ApprovalCard/index.tsx` |
| `.todo` 任务进度 | `TodoPanel/index.tsx` |
| `.sysn` 压缩提示 | `CompactionCard/index.tsx` |
| `.think` 思考条 | `ChatMessage` 内 thinkingText 区 |
| `.vbar` 语音条 | `VoiceCallPanel/index.tsx` |
| `.fdr` 文件抽屉 | `WorkspaceFilePanel/index.tsx` |
| `.tip` 提示轮播 | `TipsBanner/` + `useRotatingTip` |
| `.refs` 引用 chip | `SessionFileList/index.tsx` |
| `.macts` 消息操作 | `MessageActions/index.tsx` |

**所以每个任务都是「改这个组件的 CSS」，不是「写这个组件」。**

---

## Phase 0：补齐设计 token

### Task 0.1: design-system.css 补充缺失 token
- Modify: `apps/windows/src/renderer/styles/design-system.css`
- 深色块（L148-183 内）与浅色块（L186-221 内）**各加一份**，值不同：

需要新增的语义（原型用到但客户端没有）：
- `--mt-violet` — 语音/思考态专用色。深色 `#8b5cf6`，浅色 `#7c3aed`
- `--mt-surface-2` / `--mt-surface-3` — 卡片内嵌层。深色 `#162033` / `#1c2a40`；浅色 `#EDE8DD` / `#E4DECE`（复用已有 bg-secondary/tertiary 值，语义更贴切）
- `--mt-shine` — 卡片斜向高光。深色 `linear-gradient(145deg,rgba(56,189,248,.08),transparent 48%)`，浅色 `linear-gradient(145deg,rgba(37,99,235,.05),transparent 48%)`
- `--mt-mesh` — 页面底噪光斑，三层 radial-gradient。深色用 sky/blue/teal 低透明度，浅色同色更淡
- `--mt-code-bg` — 代码块底。深色 `rgba(0,0,0,.28)`，浅色 `rgba(31,30,27,.04)`

`:root` 公共块（L128-136 附近）追加：
- `@property --spot{syntax:'<number>';inherits:false;initial-value:0}` — 供指针光斑动画插值
- 已有 `--mt-ease-spring`（L129）和 `--mt-dur-*`（L133-136），**直接用，不要重复定义**

- Verify: 切换主题两次，确认无未定义变量（DevTools Computed 面板无 invalid）

### Task 0.2: 全局微动基座
- Modify: `apps/windows/src/renderer/styles/design-system.css` 末尾新增 section
- 三条通用规则，全应用共享：
  1. `.mt-press` — 按压回弹 `:active{transform:scale(.94)}`，`transition:transform var(--mt-dur-fast) var(--mt-ease-spring)`
  2. `.mt-spot` — 指针光斑。`background:radial-gradient(420px circle at var(--mx) var(--my), color-mix(in srgb,var(--mt-accent-500) calc(var(--spot)*11%),transparent),transparent 62%)`，`:hover{--spot:1}`
  3. `@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}` — 逃逸口，**必须有**
- ⚠️ CSS `@keyframes` 名全局共享，新增动画名统一加 `mt-` 前缀避免与组件内同名冲突（原型里踩过这个坑：`breathe` 被覆盖）
- Verify: 系统开启「减少动态效果」后所有动画停止

---

## Phase 1：对话页（优先，逐组件）

### Task 1.1: 输入区玻璃态 — 视觉重心
- Modify: `components/ChatInput/ChatInput.module.css`
- 现状：`.input-card`（L69-76）`background:transparent` + 1px 边框，输入区在视觉上"陷进"页面
- 目标：`.cmp` 的玻璃卡片，成为页面最重的元素
  - `.input-card` → `border-radius:20px`；`background:var(--mt-glass-bg)`；`backdrop-filter:blur(var(--mt-glass-blur)) saturate(160%)`；`box-shadow:var(--mt-shadow-lg)`
  - `.input-card:focus-within` → 边框 `color-mix(in srgb,var(--mt-accent-500) 55%,transparent)` + `0 0 0 3px` 15% 光环
  - 焦点呼吸动画（可选）：keyframe 命名 `mt-focus-breathe`，3.4s 循环，光环在 3px↔5px 之间脉动
- ⚠️ 保留 `.input-card` 的 `overflow:visible`（L75），底部工具栏下拉要向上展开，改成 hidden 会被裁切
- ⚠️ `.input-card-filled`（L83-86）现在靠实心背景避免与消息重叠；玻璃态 + blur 已能隔断，这条可简化但**不要直接删**，先确认滚动到底时输入区上方文字不糊
- Verify: 输入区上方有消息时滚动，文字不穿透；聚焦有光环；下拉面板不被裁切

### Task 1.2: 工具栏分区 — 左辅助 / 右主操作
- Modify: `components/ChatInput/index.tsx` L780-1181、`ChatInput.module.css` L155-178
- 现状顺序已接近原型，只需调整视觉权重：
  - `.toolbar-left`（Agent 切换 L784-804、模型切换 L851-869、思考控件 L900-923）→ 统一成原型 `.tool-btn` 的扁平样式：透明底、`height:30px`、`border:1px solid transparent`，hover 才出现 `--mt-bg-tertiary` 底
  - 激活态（思考开启、自动批准）→ `color:var(--mt-accent-500)` + 12% 底 + 38% 边框
  - `.input-toolbar` 的 `border-top`（L160）改 `var(--mt-border-hairline)`，减轻分割感
- Verify: 三个左侧控件视觉同一档；激活/未激活对比明显；点击回弹

### Task 1.3: 通话键与发送键 — 主操作区
- Modify: `components/ChatInput/index.tsx` L1147-1180、`ChatInput.module.css` L350-421
- `.voice-btn`（L389-412）现在是 32px 透明图标钮，和发送键同权重
- 目标：原型 `.call` 的胶囊按钮，`--mt-violet` 语义色，与发送键并列但不抢主色
  - `border-radius:99px`；`height:32px`；`padding:0 13px`；文字「通话」+ lucide `Mic`
  - `background:color-mix(in srgb,var(--mt-violet) 13%,transparent)`；边框 42%
  - 通话中：实心紫渐变 + 图标摇摆动画（keyframe `mt-mic-shake`，±9deg，1.1s）
- `.send-btn`（L350-378）→ 圆形 `border-radius:50%`，`linear-gradient(135deg,var(--mt-accent-600),var(--mt-accent-700))`，`box-shadow` 带主色投影；hover `scale(1.08)`
- ⚠️ `.stop-btn`（L380-387）的 `pulse-stop` 动画保留，这是中断态的关键反馈
- Verify: 通话/发送视觉分工清楚；通话中图标摇摆；streaming 时按钮变红方块且脉冲

### Task 1.4: 提示行 — tips 与快捷键互斥
- Modify: `components/ChatInput/index.tsx`、`components/TipsBanner/TipsBanner.module.css`
- 现状：`useRotatingTip`（L12 import）已有轮播逻辑，`help-panel`（L1018-1145）是独立弹层
- 目标：原型 `.cw-hint` 的单行极轻量提示，放输入卡下方
  - 空闲：tips 轮播 + `◀ 1/5 ▶` 翻页（复用 `useRotatingTip`）
  - 输入中：切换成 `Enter 发送 / Shift+Enter 换行 / / 技能` + 字符数
  - 字号 `--mt-fs-xs`、`--mt-fg-4`、等宽字体，快捷键用 `kbd` 小胶囊（复用已有 `.help-kbd` L1045 的样式）
- ⚠️ `help-panel` 里的 /命令清单和动态 UI 说明信息量大，**不要合并进单行**，保留弹层入口
- Verify: 空/有输入两态切换；翻页可用；不遮挡消息

### Task 1.5: 消息气泡 — 用户/助手非对称
- Modify: `components/ChatMessage/ChatMessage.module.css` L106-236
- 现状：`.message` 是 avatar + content 的 flex 行，用户消息也带头像，两侧对称
- 目标：原型的非对称布局，用户右对齐窄气泡，助手左对齐通栏
  - `.message.user` → `align-self:flex-end`；`max-width:min(560px,78%)`；气泡右上角切角 `border-top-right-radius:5px`
  - `.message.user .message-text`（L206-210）→ 主色渐变 `linear-gradient(135deg, color-mix(...accent-600 26%...), color-mix(...accent-700 34%...))`
  - `.message.assistant` → `align-self:flex-start`；`width:100%`；左上角切角
  - 助手气泡 → `var(--mt-glass-bg)` + `backdrop-filter:blur(14px)`
  - 元信息行（`.message-meta` L229-236）改成原型 `.mh`：等宽小字在气泡**上方**，含角色名/时间/模型/耗时
- ⚠️ `message-enter` 动画（L112, L121-130）已经是 spring 曲线且和原型一致，**保持不动**
- ⚠️ `.message--no-enter`（L117-119）是会话切换时抑制批量弹跳的关键，**不要删**
- ⚠️ `--chat-font-size`（L200）是字体缩放的接入点，`cycleFontScale()` 在 `ChatPage.tsx` L739，保持
- Verify: 用户/助手左右分明；字体缩放三档生效；切换会话不批量弹跳

### Task 1.6: 工具卡 / 审批卡 / 任务进度
- Modify: `ToolCallCard.module.css`、`ApprovalCard.module.css`、`TodoPanel.module.css`
- 三张卡统一成原型的内嵌卡语言，**共用同一套规则**：
  - 底 `var(--mt-surface-2)`，边框 `var(--mt-border)`，`border-radius:10-11px`，`margin-top:8px`
  - 头部行等宽字体，状态圆点 15px：成功 `--mt-success` 20% 底、失败 `--mt-error`、运行中转圈（keyframe `mt-spin`）
  - 展开体 `border-top:1px solid var(--mt-border-hairline)` + `background:var(--mt-code-bg)`
- 审批卡额外：左侧 2.5px `--mt-warning` 竖条（`::before`）+ 8% 警告底，视觉上「拦住」用户
- 任务进度额外：已完成项 `line-through` + `--mt-fg-4`；进行中项 accent 边框 + 呼吸圆点
- Verify: 三卡视觉同族；审批卡足够显眼；运行中转圈流畅

### Task 1.7: 思考过程条
- Modify: `components/ChatMessage/ChatMessage.module.css` thinking 区
- 目标：原型 `.think` — 虚线紫框单行条，折叠态只显示一行摘要
  - `border:1px dashed color-mix(in srgb,var(--mt-violet) 40%,var(--mt-border))` + 8% 紫底
  - 左侧 5 根跳动竖条（keyframe `mt-wave`，逐根 delay 0.12s），右侧耗时
  - 摘要文字 `text-overflow:ellipsis` 单行 + 斜体 85% 透明
- 展开后正常显示全文
- Verify: 流式思考时竖条跳动；折叠态不超一行；展开可读

### Task 1.8: 压缩提示与引用 chip
- Modify: `CompactionCard.module.css`、`SessionFileList.module.css`
- 压缩提示 → 原型 `.sysn`：居中虚线胶囊、等宽小字、数字用 accent 高亮
- 引用 chip → 原型 `.ref`：`border-radius:99px`、hover 变 accent 边框和文字
- Verify: 压缩提示不像错误提示；chip 可点击且 hover 明确

### Task 1.9: 会话头部瘦身
- Modify: `ChatPage.module.css` L61-105、`ChatPage.tsx` L1400-1450 附近
- 现状：`.chat-toolbar`（L61-69）+ `.chat-meta-bar`（L92-105）两行，信息分散
- 目标：原型 `.ct` 单行 —— 标题 + 会话类型小字 + 右侧「自动批准 / 字体 / 文件」三钮
  - 背景 `var(--mt-glass-bg)` + `blur(14px)`，`border-bottom:1px solid var(--mt-border-hairline)`
  - `.llm-route-indicator`（L157-191）的模型路由状态点保留，但移到标题右侧同一行
- ⚠️ `--chat-overlay-top:44px`（L16）是消息区避让高度，头部改高度后**必须同步这个值**
- Verify: 头部单行不换行；窄窗口不溢出；消息区顶部不被遮

### Task 1.10: 文件抽屉过渡
- Modify: `WorkspaceFilePanel.module.css`
- 目标：原型 `.fdr` 的宽度过渡（0 ↔ 236px）
- ⚠️ 原型踩过的坑：`border-left:1px` 在 `width:0` 时会留 1px 发丝线。必须 `border-left:0 solid` + 展开态才 `border-left-width:1px`，并把 `border-left-width` 一起放进 transition
- Verify: 收起后无残留竖线；展开过渡平滑

### Task 1.11: 语音通话条
- Modify: `VoiceCallPanel.module.css`、`WaveformVisualizer.tsx`
- 目标：原型 `.vbar` — 输入区上方的紫框玻璃条：状态标签 + 波形 + 计时 + 挂断
- `WaveformVisualizer` 已存在，只需把柱子改成 `linear-gradient(180deg,var(--mt-violet),var(--mt-accent-500))`，`transition:height .12s linear`
- 入场用 `mt-msg-in` spring 动画
- Verify: 通话开始/结束有过渡；波形跟随音量

---

## Phase 2：概览页

### Task 2.1: 指标卡改为真实可得的数据
- Modify: `pages/DashboardPage/DashboardPage.tsx` L94-158
- 现状四卡：已连接设备 / 已安装技能 / 今日调用 / 当前订阅
- 目标四卡：**MCP 服务** / 已安装技能 / 今日调用 / Token 用量
- ⚠️ **数据可得性**（已逐层查证到主进程，实现前必读）：

| 指标 | 现状 | 处理 |
|---|---|---|
| 内存 | `system-service.ts` L515-558 `getSystemInfo()` 返回 `memoryUsagePercent`，实时 | 直接接 |
| 磁盘 | 同文件 L564-607 `getDiskInfo()`，PowerShell WMI，30s 缓存 | 直接接 |
| **CPU%** | `SystemInfo.cpuUsage` 在 L115 **声明了但从未赋值**；只有 `cpuModel`/`cpuCores` | **Phase 4 补采集** |
| **GPU** | 完全没有采集代码 | **Phase 4 新开发** |
| **今日调用 / Token** | `api:getUsage` 在 `main/index.ts` L2185-2201 是**恒定全 0 的桩**，不是真实数据 | **Phase 4 新开发** |
| **花费金额** | 同上，桩里没有 cost 字段 | **Phase 4 新开发** |
| **时间范围查询** | 桩只有 daily/monthly 两个固定形状 | **Phase 4 新开发** |
| **MCP 服务** | 客户端无 MCP 模块 | 独立立项，见 Task 4.5 |

- ⚠️ 更正：`getUsage()` 看起来有日/月汇总，但主进程返回的是硬编码 0。**概览页四卡里有三卡目前无真实数据源**，必须先做 Phase 4.3
- 建议实施顺序：Phase 4.3（本地用量存储）→ 再回来做本任务的视觉
- Verify: 四卡数字来自真实数据；未完成采集的指标显示空状态或「—」，不要填 0 冒充

### Task 2.2: 运行时态势卡
- Modify: `DashboardPage.tsx`
- 目标：原型 `.hero` — 左侧状态文案 + 火花线，右侧 CPU/内存/磁盘 环形仪表
- 环形仪表用 conic-gradient + `@property --p` 插值（原型 L42 的写法，token 已在 Task 0.1 加）
- ⚠️ 原型最新一版已**移除**延迟/上传/下载三条，不要加回来；网络延迟只在底栏出现一次
- ⚠️ GPU 仪表按 Task 2.1 结论处理
- Verify: 仪表随真实数据变化；无重复的延迟指标

### Task 2.3: 近期关注面板
- Modify: `DashboardPage.tsx`
- 目标：原型的「近期关注」——事务/计划/任务三分段，条目形如从用户记忆归纳出的关注项
- 数据源：`MemoriesPage` 背后的记忆存储。**先确认有没有可查询的记忆摘要接口**
- 如果没有归纳能力：这一块降级为「最近记忆条目」直接列出，不要伪造「AI 归纳」的假象
- Verify: 条目来自真实记忆数据，或明确是空状态

---

## Phase 3：外壳与设置

### Task 3.1: 侧边栏收敛
- Modify: `components/layout/Sidebar/Sidebar.tsx` L88-96（`defaultNavItems`）
- 现状 7 项：概览 / 对话 / AI 团队 / 定时任务 / 技能管理 / 记忆管理 / 插件中心
- 目标：只留高频（概览 / 对话 / 插件中心），其余移入设置
- 底部对话钻取：默认会话 ↔ 渠道 两态 tab，在侧栏内展开会话列表（原型 `.dsec` + `.seg`）
- ⚠️ 移走的菜单必须在设置里有入口，`Router.tsx` L25-34 的 9 个页面 id 都要可达，不能出现死路由
- ⚠️ 原型已移除侧栏底部的用户信息块（产品无需登录），Sidebar 现有的「用户信息 + 登出」需要一并处理——**这涉及登录态逻辑，改之前先确认产品是否真的不需要登录**
- Verify: 每个页面都能到达；无死链

### Task 3.2: 底栏观测 HUD
- Modify: 新增或复用底栏组件（调研未发现 StatusBar，需确认）
- 目标：原型右下角集中式 HUD —— 消息数 / 上下文占用 / token 上下行 / tok/s / 延迟 / 花费
- 数据源：`runtimeContextUsage`（agent-runtime-store）有上下文占用；消息数可从 `runtimeMessages.length` 得
- ⚠️ **花费金额无数据源**，同 Task 2.1
- Verify: 数值变化有跳动反馈；不与其他位置重复展示同一指标

### Task 3.3: 设置页 tab 对齐
- Modify: `pages/SettingsPage/SettingsPage.tsx` L75-87（`CATEGORIES`）
- 现状 11 个 tab：account / workspace / modelConfig / voice / pet / channels / notification / privacy / shortcuts / update / about
- 原型要求补：**技能中心**、**MCP 服务**
- ⚠️ 这两个功能在真实客户端**目前不存在**（技能管理页有，但「技能中心」商店形态没有；MCP 服务无对应模块）。实现时要么接已有的 SkillsPage，要么明确标为未实现，**不要做一个点不动的假 tab**
- Verify: 每个 tab 都有真实内容或明确的未实现说明

---

## Phase 4：补齐缺失的数据采集（新开发）

原则：全部本地采集，不依赖任何服务端。这是开源本地产品，指标不该走网络。

### Task 4.1: CPU 使用率采集
- Modify: `apps/windows/src/main/system-service.ts`
- `SystemInfo.cpuUsage`（L115）已声明未实现。用 `os.cpus()` 的 times 差分算：
  - 缓存上一次各核 `times`（user/nice/sys/idle/irq）
  - 本次采样求 `total` 与 `idle` 的增量，`usage = 1 - idleDelta/totalDelta`
  - 首次调用无基准 → 返回 `undefined`，前端显示「—」而不是 0
- ⚠️ 不要用 PowerShell 取 CPU：`Get-Process` 的 CPU 字段是**进程累计 CPU 秒数**，不是瞬时百分比，直接当百分比用是错的
- ⚠️ `getSystemInfo()` 有 10s 缓存（L138），CPU 差分要走缓存外的独立路径，否则差分间隔失真
- Verify: 跑满一个核时数值明显上升；空闲时回落；首次调用不显示 0

### Task 4.2: GPU 采集
- Create: `apps/windows/src/main/gpu-service.ts`
- Electron 自带 `app.getGPUInfo('complete')` 能拿到型号/驱动，**但拿不到利用率**
- 利用率方案（Windows）：
  1. NVIDIA → `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits`
  2. 无 nvidia-smi → 降级只显示型号，利用率显示「不支持」
- ⚠️ 走 `securityUtils.isCommandAllowed()` 白名单（L705），新命令要先加白名单
- ⚠️ 缓存 ≥2s，`nvidia-smi` 冷启动约 100-200ms，3s 刷新间隔下别每次都调
- ⚠️ AMD/Intel 集显没有统一 CLI，明确降级，不要为了填满仪表盘而估算
- Verify: 有 N 卡的机器显示真实利用率；无 N 卡显示型号 + 不支持；不报错

### Task 4.3: 本地用量与花费统计
- Create: `apps/windows/src/main/usage-store.ts`
- 现状 `getUsage()` 只有日/月汇总，无 cost、无时间范围
- 新建本地 append-only 记账：每次模型调用后写一条
  - 字段：`ts` / `model` / `promptTokens` / `completionTokens` / `costCents` / `sessionKey`
  - 存储：`userData/usage/YYYY-MM.jsonl`，按月分文件，避免单文件无限增长
- 价目表：`shared/model-pricing.ts`，`{ modelId: { inputPer1M, outputPer1M } }`
  - ⚠️ 用户自配 provider 的价格未知 → 允许价目表缺失，缺失时只记 token 不记 cost，前端显示「—」
  - ⚠️ 本地模型（ollama/qwen 本地）成本为 0，不是「未知」，要能区分这两种情况
- 查询接口：`usage:query({ from, to, groupBy: 'hour'|'day' })`，供原型的「今日/7天/30天」分段用
- 接入点：`agent-runtime` 拿到 usage 回执处写入。⚠️ 先确认 ACP/provider 回执里**是否真的带 token 数**，不带就只能估算——估算要在 UI 上标明是估算
- Verify: 发几条消息后 jsonl 有记录；切换时间范围数字变化；无价目的模型不显示假金额

### Task 4.4: 网络延迟
- Modify: `system-service.ts` 或新建 `net-service.ts`
- 原型底栏保留了「延迟」一项。语义定为**到当前模型 provider 的延迟**，而不是 ping 公网
- 实现：记录每次请求的首字节时间（TTFB），取最近 N 次中位数
- ⚠️ 本地模型的延迟含义不同（无网络往返），要么标注，要么本地模型时隐藏该项
- Verify: 数值与实际响应快慢相符；本地模型不显示误导性延迟

### Task 4.5: MCP 服务指标
- Modify: 概览页 MCP 卡片的数据源
- ⚠️ 调研发现客户端**没有 MCP 模块**。原型的「MCP 服务 5 个已连接 / 1 个待授权」是纯设计稿
- 这是独立功能，不是 UI 改造。**建议单独立项**，本计划里概览页 MCP 卡先不接数据
- 若本轮必须做：至少要有 MCP client 的连接管理 + 配置读写，工作量远超样式改造

---

## Phase 5：移除用户系统（开源版无登录）

**调研更正：这里比预想的简单得多。** 用户系统已经是一层空壳：
- `useAuth.ts` L16-20 `LOCAL_USER` 是硬编码本地用户；L34-43 `login`/`register`/`logout` 全是 noop；L50 `accessToken:'local'` 是占位字符串；`isAuthenticated` 恒为 `true`
- `main/auth-manager.ts` **从未被实例化**，是死代码
- `hooks/business/useSubscription/` **没有任何页面 import**
- 所有 `api:*` IPC 都是桩：`index.ts` L2169-2201，订阅返回「独立版不支持云订阅」，credit 返回 0
- **没有 Authorization header 的远程请求，没有登录页/登录弹窗**

所以这不是「拆除认证系统」，是「删掉一批从来没生效的壳代码」。

### Task 5.1: 删死代码
- Delete: `src/main/auth-manager.ts`（未实例化）
- Delete: `hooks/business/useSubscription/`（无消费者）
- Delete: `hooks/business/useCredits/`、`hooks/business/useServerCaptcha/`（先 grep 确认无消费者再删）
- Modify: `hooks/business/index.ts` 去掉对应导出
- ⚠️ 严格区分：**用户 token** 删；**provider API key**（`provider-config.ts` 的 safeStorage）是核心功能，**绝对不能删**

### Task 5.2: 拆 AuthContext
- `contexts/AuthContext/AuthContext.tsx` 被 **11 个文件** import：App.tsx、MainLayout.tsx、DashboardPage.tsx、Router.tsx、AppProviders.tsx、WorkspaceWizard.tsx、SettingsPage.tsx、GenerateTeamWizard.tsx、SkillsContext.tsx、useDashboard.ts
- 这些地方消费的其实只有 `user.displayName`（UI 展示）和 `user.id`（本地数据归属）
- 方案：**不保留 Auth 语义**。把 displayName 迁到设置里的「怎么称呼你」（宠物模式已有同名设置项，可复用同一份配置），userId 用固定 `'local-user'`
- ⚠️ 11 处逐个改，改完必须 grep 确认无残留 `useAuth` / `AuthContext` 引用
- ⚠️ `isAuthenticated` 恒 true，所有依赖它做条件渲染的地方直接去掉分支，不要留 `true &&`

### Task 5.3: 移除登出 UI 与用户信息块
- Modify: `components/layout/Sidebar/Sidebar.tsx` L17（`LogOut` 图标 import）、L186-210（用户信息卡 + 登出按钮）
- Modify: `App.tsx` L45、L87-94（`handleLogout` 及其传递链）
- 侧栏底部腾出的空间给 Phase 3.1 的对话钻取用
- ⚠️ 没有独立 LoginPage/LoginModal 文件，不用找

### Task 5.4: 概览页去 SaaS 化
- Modify: `pages/DashboardPage/DashboardPage.tsx`
- 删「当前订阅 plan + 剩余天数」卡（L146-158）
- 删「已连接设备 / 限制 5」的配额语义（L95-108）
- 删「今日调用 conversationsUsed/Limit」的配额分母（L129-144）
- 换成 Phase 2.1 的四卡，数据来自 Phase 4 的本地采集
- ⚠️ 「设备数限制」「配额」「剩余天数」在本地开源产品里没有意义，全部清掉

### Task 5.5: 清桩 IPC
- Modify: `src/main/index.ts` L2150-2201
- 移除 `api:getSubscription` / `getSubscriptionOverview` / `getPlans` / `getAvailablePlans` / `createSubscription` / `cancelSubscription` / `getCreditBalance`
- `api:getUsage`（L2185）**不是移除而是重写**——Phase 4.3 的本地用量存储接到这里
- Modify: `src/preload/index.ts` 同步去掉对应暴露（L1212-1224、L1357）
- ⚠️ 删 IPC 前先删 renderer 侧调用，否则运行时报 "No handler registered"
- Verify: 断网启动，所有页面正常，无网络报错

### Task 5.6: 遥测上报
- Modify: `src/main/agent-runtime/analytics-reporter.ts` L32-62
- 现在会把工具调用事件 POST 到 `/api/internal/agent-analytics/ingest`
- 开源本地产品默认不该外发数据。建议**默认关闭**，若保留必须是设置里的显式 opt-in
- ⚠️ 这是唯一一处真实的对外网络请求，删/关之前跟用户确认

---

## 验证清单（每个 Phase 结束跑一次）

0. ⚠️ **基线**：改造开始前 `npx tsc --noEmit` 已有 **49 个既有 error**（bridge.ts、mempalace-mcp-client.ts、WorkspaceVersionPanel.tsx 等，与本次改造无关）。验收标准是「不新增 error」，不是「零 error」。每个 Phase 结束重新计数对比
1. `npm run build --workspace apps/windows` 通过
2. 深色 / 浅色主题各自完整走一遍对话流程：发消息 → 工具调用 → 审批 → 压缩 → 语音通话
3. 窄窗口（1100 / 900 宽）无横向溢出
4. 系统「减少动态效果」开启后无动画
5. 字体缩放三档、思考三档、自动批准开关均可用
6. 无 console error
7. **断网启动**：所有页面可用，无 401 / 网络错误（Phase 5 之后）
8. **功能不丢**：对照下方清单逐项点一遍

### 功能保留清单（改样式时不得丢失）

输入区：Agent 切换 / 模型切换 / 思考开关 / reasoning effort / 上下文压缩 / 文件上传 / 图片上传 / @文件引用 / 斜杠命令补全 / 帮助弹层（快捷键 + /命令 + 动态 UI 说明）/ 中途插话 / 消息队列 / 拖拽上传 / 字体缩放 / 语音通话 / 发送 / 停止

消息区：markdown / GFM 表格 / LaTeX / 代码高亮 / 工具卡展开 / 审批卡三按钮 / 任务进度 / 思考折叠 / 流式光标 / 消息操作（复制/编辑/删除/重生成）/ 引用文件 / 压缩提示 / 中断标记

侧栏：会话列表 / 新建会话 / 渠道切换 / 会话重命名删除 / 折叠

**任何一项在改造后点不动，就是回归。**

---

## 明确不做（避免范围蔓延）

- 不改浅色主题配色（客户端暖奶油是对的，原型冷色是权宜）
- 不换图标库
- 不动 `agent-runtime-store` 的流式逻辑
- 不为对齐原型而伪造数据（缺的数据去 Phase 4 补采集，不是编假值）
