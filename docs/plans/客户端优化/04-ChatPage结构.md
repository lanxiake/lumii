# 第 4 片 · ChatPage 结构 — 实施计划

> 创建：2026-09-12 · 状态：**待决策确认**（决策记录见第六节）
> 上位文档：[客户端优化切片计划](./README.md)
> 复核方式：逐行读完 4 个核心文件 + import 说明符解析脚本（不仅字符串搜索）+ 测试基线实测（vitest 单跑 2 个受影响文件）

---

## 一、审计结论（修正 README 的旧数据）

### 1.1 props 穿透矩阵（实测）

| 组件 | 声明 props | 实际传入 | 纯穿透（本层不用、只下传） |
|---|---|---|---|
| `ChatContainer`（`components/ChatContainer/index.tsx:71-113`） | **22** | **21**（`userId` 声明了但 ChatPage 从不传） | 8 个回调 + `replayMessageId` |
| `ChatMessageRow`（`ChatContainer/index.tsx:134-152`，Memo 包裹） | **17** | 17 | 全部 17 中有 8 个仅为下传 |
| `ChatMessage`（`components/ChatMessage/index.tsx:37-68`） | **15** | 15 | 叶子组件，消费方 |

纯穿透集合（本层零使用）：`formatTime`、`onCopyMessage`、`onEditMessage`、`onDeleteMessage`、`onRegenerateMessage`、`onReplayFromMessage`、`onReviewFileChanges`、`userId`（死）。

`onReviewFileChanges` 完整链路（4 层下传后消费）：

```
ChatPage.tsx:1505 → ChatContainer:106(interface)/247(转手) → ChatMessageRow:150/629 → ChatMessage:67/711,766 → TurnFileChangesCard onReview
```

### 1.2 新发现 1：`handleRegenerateMessage` 的闭包依赖击穿了行级 memo（本片顺带修复）

- `ChatPage.tsx:1212-1236`：deps 含 `runtimeMessages`，该值在每次流式增量时换新引用 → 回调 identity 每 token 变一次 → 作为 prop 传给 `ChatContainer`/`ChatMessageRowMemo`/`ChatMessageMemo` → **流式期间所有历史消息行的 memo 全部失效**（每次 delta 全量重渲染）。
- 与源码注释自述矛盾：`ChatPage.tsx:1354`「稳定化传给 ChatContainer 的回调，避免每次 render 新建函数破坏 memo」——`formatTime`/`handleCopyMessage`/`handleReplayFromMessage` 确实稳定，但 `handleRegenerateMessage` 实际没有。
- 修复：回调内改从 `runtimeStore.getState()` 读当前会话消息（store 已是现成数据源，`ChatPage.tsx` 已 import `runtimeStore`），deps 缩为 `[runtimeActions]`（稳定）。

### 1.3 新发现 2：`components/index.ts` 桶导出零消费者；`userId` 为死 prop

- import 解析脚本（把每个相对说明符解析到真实文件）确认：`pages/ChatPage/components/index.ts` **全仓零消费者**；`ChatMessage` 仅被 `ChatContainer` 消费（测试除外）；本地 `Toast` 仅被 `FloatingOverlays` 消费。
- `ChatContainerProps.userId` 声明未传，链路上 `ChatMessage` 的 `userId` 永远走默认值 `'local-user'`。

### 1.4 Toast 双实现数据核实

| 项 | 实测 |
|---|---|
| 本地实现 | `components/Toast/index.tsx`（43 行）+ `Toast.module.css`（65 行）；仅 `FloatingOverlays.tsx`（19 行，ChatPage 唯一消费者）使用 |
| ChatPage 内调用 | **22 个 `setToast` 调用点**（`ChatPage.tsx` 内，另有 1 个 state 声明；含传给斜杠命令执行器的 `showToast` 适配器） |
| ui/Toast | `components/ui/Toast/`（Provider + useToast + 条目 + CSS）；**18 个文件引用**（16 个 `useToast` 消费 + `AppProviders.tsx:31` 全应用挂载 + 1 个测试）；`useToast` 返回值 useMemo 稳定（`useToast.ts:25-40`） |

### 1.5 测试影响面（已实测基线）

| 测试文件 | 现状 | 本片影响 |
|---|---|---|
| `src/test/components/ChatMessage.parts.test.tsx` | **3 通过**（`ChatMessage` 直接渲染，回调由 props 传入） | 必须同步加 Provider 包装，否则变新增失败 |
| `src/test/components/ChatPage.test.tsx` | **6 既有失败**（根因 `useSettingsHub must be used within SettingsHubProvider`，ChatSidebar:94） | ChatPage 改调 `useToast()` 后若不包 Provider，失败根因会变成 `useToast must be used within a ToastProvider`；需包 `ToastProvider` 保持失败签名不变 |
| `MessageActions.test.tsx` / `TurnFileChangesCard.test.tsx` | 通过 | 不受影响（二者 props 接口不变） |

---

## 二、技术方案

### 2a · 本地 Toast 退场（4a）

1. ChatPage 引入 `useToast()`，22 个 `setToast` 调用点逐点改写：
   - `setToast({ message, type: 'success' | 'error' | 'info' })` → `toast.success/error/info(message)`
   - 斜杠命令执行器适配器：`showToast: (message, type) => toast[type](message)`（执行器签名 `(message: string, type: 'success' | 'error' | 'info')` 与 `UseToastReturn` 键完全对齐，`slash-command-executor.ts:26`）
2. 删除：`layout/FloatingOverlays.tsx`、`components/Toast/index.tsx`、`components/Toast/Toast.module.css`；`components/index.ts:11` 的 `export { Toast }` 行。
3. 删除 ChatPage 内 `toast` state 与 `<FloatingOverlays>` 渲染。

**登记的行为/视觉变化（原则 3）**：

| 项 | 原（本地版） | 新（ui/Toast） |
|---|---|---|
| 位置 | 右上（fixed 16px） | 右上（容器 padding 16px，基本同位） |
| 动画 | 下滑淡入 translateY | 右滑入 translateX |
| 时长 | 固定 2000ms | 默认 3000ms，可手动关闭 |
| 多条 | 单条覆盖 | 堆叠（最多 5 条） |
| 结构 | 整卡边框+底色着色 | 左侧 4px 色条 + 圆形图标底；新增 × 关闭钮；`role="alert"` |
| 宽度 | max 320px | min 280 / max 400px |
| 缩放 | 在 ChatPage 根容器内，随 Ctrl+滚轮 zoom 缩放 | portal 到 body，**不再随页面 zoom 缩放**；但 z-index 抬到 `--z-settings-hub + 60`，可盖过设置浮层 |

### 2b · 回调稳定化（4b，独立小提交）

`handleRegenerateMessage` 改读 `runtimeStore.getState()`（当前会话 key + 该会话 messages），deps `[runtimeActions, runtimeCurrentSessionKey, runtimeMessages]` → `[runtimeActions]`。行为语义：解析锚点从「渲染时快照」变为「点击时最新」——用户点「重新生成」和消息到达之间若有新消息，按最新列表找锚点，属修正而非回退。

### 2c · Context 收敛（4c）

新增 `pages/ChatPage/contexts/ChatMessageActionsContext.tsx`（约 45 行）：

```ts
export interface ChatMessageActions {
  formatTime(date: Date): string
  copyMessage(content: string): void
  editMessage(messageId: string, newContent: string): void
  deleteMessage(messageId: string): void
  regenerateMessage(messageId: string): void
  replayFromMessage(messageId: string): void
  reviewFileChanges(path: string, status: 'added' | 'modified' | 'deleted'): void
}
```

- `useChatMessageActions()` 无 Provider 时 **throw**（与 `useToast`/`useSettingsHub` 的仓库惯例一致，不设静默 no-op 兜底）。
- ChatPage 用 `useMemo` 构造 value（deps 为 7 个回调自身），包在 `<ChatContainer>` 外层。
- **稳定性契约**：7 个回调中仅 `editMessage`/`deleteMessage` 依赖 `runtimeCurrentSessionKey`（会话切换时变化）、`reviewFileChanges` 依赖 `toAbsolutePath`（workspace 初始化时变化一次）；流式/打字/回放期间 value 恒定 → 不会因 Context 传播击穿行级 memo。这一点以代码注释固化。

**props 收敛结果**：

| 组件 | 现在 | 之后 | 下线项 |
|---|---|---|---|
| `ChatContainer` | 22 声明 / 21 实传 | **14 / 14** | 7 回调 + `userId`（死） |
| `ChatMessageRow` | 17 | **9** | 同上 8 个 |
| `ChatMessage` | 15 | **7 + context** | 同上；`onReplayFileChanges` 等改由 context 取 |
| `userId` 链路 | `ChatContainer → Row → ChatMessage`（恒 undefined） | **整链删除**，`FilePreviewModal` 处直用常量 `'local-user'`（与 ChatPage `files:import` 的既有常量一致） |

保留为显式 props 的状态类字段（刻意不进 Context，保护 memo 门控）：`streamingThinkingText`（按行门控，仅最新助手行接收变化值）、`replayMessageId`（回放期间逐条切换）、`session`/`isStreaming`/`isSending` 等。

### 2d · 测试同步修改（4c 内）

- `ChatMessage.parts.test.tsx`：加 `ChatMessageActionsProvider` 包装（noop 动作 + `formatTime: () => '10:00'`），删除已下线的 props。
- `ChatPage.test.tsx`：6 处 `render(<ChatPage />)` 统一改为 `render(<ToastProvider><ChatPage /></ToastProvider>)`，**失败计数与根因保持与基线一致（6 个，useSettingsHub）**。

### 2e · 每批验证机制

- 残留扫描：`setToast|FloatingOverlays|components/Toast` 与 props 名（按第 3 片教训，覆盖 `"` `'` `` ` `` 及拼接形式；本轮无模板类名，主要靠解析脚本复扫 import 说明符）。
- `pnpm typecheck`（4 包）+ `pnpm build` 每批必过。
- 测试：`vitest run src/test/components/ChatMessage.parts.test.tsx src/test/components/ChatPage.test.tsx`（4a、4c 各跑一次，对比基线）。
- 人工冒烟清单（收尾）：流式对话打字/滚动、消息复制/编辑/删除/重新生成、语音消息回放、文件变更卡「查看」定位、Toast 各类型展示；长对话流式期间观察历史消息是否重渲染（memo 修复的实际效果）。

---

## 三、批次（每批独立提交、独立验证、可单独回滚）

| 批次 | 内容 | 验证 |
|---|---|---|
| 4a | 本地 Toast 退场：22 处调用点改 `useToast`；删组件/CSS/FloatingOverlays/桶行 | typecheck + build + 残留扫描 + 2 个测试文件对比基线 |
| 4b | 回调稳定化：`handleRegenerateMessage` 改读 store | typecheck + build + deps 静态检查 |
| 4c | Context 收敛：新增 Context；三层组件 props 下线 8 个；测试同步更新 | typecheck + build + 残留扫描 + 测试通过状态对比基线 |

收尾：README 切片表状态更新 + 本文档执行记录 + 记忆更新；一次性脚本删除。

## 四、明确不做

- `ChatInput`（30+ props）、`ChatToolbar`、`ChatBottomOverlay`、`ChatSidebarArea`、`WorkspaceWorkbenchArea` 的 props 不动（超出本片「21 个 props」范围）。
- 不把 `session`/消息/流式状态放进 Context（会破坏按行门控的 memo 设计，见选项 B）。
- 不做 `components/index.ts` 整桶删除（零消费者的结论只登记；本片仅删 Toast 行）——除非决策选择 B。
- 组件逻辑、结构外行为、其它页面的类似问题（切片 5 范围）不动。

## 五、风险与对策

| 风险 | 对策 |
|---|---|
| Context value 意外不稳定 → 全量行重渲染（比现状更糟） | 值仅依赖 7 个回调；唯一会变的是会话切换/workspace 初始化，均已登记；代码注释固化契约；人工冒烟长对话确认 |
| 直接渲染 ChatMessage 的测试被破坏 | 4c 同批更新两测试文件，并与实测基线（3 通过 / 6 失败）逐一对比 |
| Toast 交互差异被当成回归 | 2a 表格逐项登记；时长/位置/类型语义保持一致，差异集中在动画、关闭钮、堆叠、zoom |
| 删除 `FloatingOverlays` 影响布局 | 该组件无自身样式、仅 19 行包装，ChatPage 内无布局占位 |
| `userId` 死 prop 删除改变外部行为 | 全仓解析脚本证明链路恒为默认值 `'local-user'`；typecheck 兜底 |

## 六、决策记录（2026-09-12 已确认）

1. **Context 范围：仅收敛纯穿透回调**（7 个回调进 Context + 删死 prop `userId`）。流式/回放等状态类 props 保持显式传递，保住现有 memo 门控。
2. **零消费者桶：仅删 Toast 导出行**；整桶零引用的结论只登记在 1.3 节，未动。
3. **提交粒度：三个独立提交**（4a / 4b / 4c），各自可单独验证与回滚。
