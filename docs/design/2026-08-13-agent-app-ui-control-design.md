# Agent 操作客户端自身 — 完整设计

> 日期：2026-08-15  
> 状态：v0.7，MVP 已实现验收通过；二期完整规格补代码事实核查；三期（§14 CLI 统一控制面）经二次核查修正  
> 实施计划：`docs/plans/2026-08-14-agent-app-ui-control-implementation.md`  
> 相关：`bridge-browser-tools.ts`、`SettingsHubContext.tsx`、`Router.tsx`、`App.tsx`、`bridge-renderer-ipc.ts`、`runtime-env.ts`、`pet-window-manager.ts`、`agent-runtime-ipc.ts`、`agent-runtime-commands.ts`、`useSettings.ts`

---

## 0. 结论摘要

| 问题 | 结论 |
|------|------|
| 方案是否可行 | **可行**，但"无新原生依赖、复用现有基础设施"过于乐观：`capturePage`/`sendInputEvent`/DOM 快照/配额计数器均为**全新代码**，只是不需要安装新 npm 包。 |
| v0.3 最大遗漏 | **`app_goto` 回读缺口**：现有 `forwardIpcEvent` 是单向 fire-and-forget，主进程拿不到渲染进程执行 `openHub` 后的真实状态。已实现：主进程 `send('app-ui:goto')` 后 `executeJavaScript` 读取渲染层挂的 `window.__LUMII_APP_UI_STATE__`，不新增 IPC 通道（§7.8）。 |
| 其它须修正 | pet 窗口误伤；截图文件清理；配额计数器落点；permission memory 仅进程内；browser_* 只能参考结构而非复用实现。|
| MVP 不变 | 两个功能：**看** `app_screenshot` + **动** `app_goto` / `app_act(click)`。主窗 only。进程内工具。走通「看→跳/点→再看」闭环。 |
| CLI | 完整设计保留，**二期再做**。 |

---

## 1. 背景

### 1.1 缺口

| 已有 | 能做 | 做不到 |
|------|------|--------|
| `browser_*` | 外部网页 | Lumii 自己的窗 |
| `session_*` / `settings_think` / `settings_backend` / `cron_*` / `skill_*` / `memory_*` | 部分业务 API | 没有对应 API 的界面；也无法**验收** API 是否真的改了 UI |
| 用户快捷键截图 | 人操作 | Agent 不能调 |

设置、技能、定时、记忆、MCP、插件全在 **Settings Hub 浮层**（`SettingsHubContext.tsx`，`useState` 管理 `{open, tab, category}`）。纯坐标点击极不稳定，必须走声明式 `openHub(tab, category)`。

### 1.2 设计要回答的三件事

1. **完整**：软件里人能点的、已有 API 的，尽量都给 Agent 一条路。
2. **闭环**：每次操作都能「看见结果」，不是调完就当成功。
3. **MVP**：先交付能跑通的最小闭环，而不是最小技术演示。

---

## 2. 代码事实核查（v0.3 对照修正）

> 以下基于实际代码搜索结果，每条注明来源。

### 2.1 已验证成立的假设

| 假设 | 代码证据 |
|------|---------|
| `ViewType` 定义完整 | `Router.tsx:18-27`，包含 `dashboard/chat/skills/settings/memories/agents/cron/plugins/mcp` |
| `openHub` / `closeHub` / `openHubForView` 存在 | `SettingsHubContext.tsx:49-76`，`useState` 管理，API 签名与文档一致 |
| `SettingsHubTab` 与 `MergedSettingsCategory` 枚举 | `SettingsHub/types.ts:10-30`，完整覆盖文档所有 view/category |
| `mtbot:navigate-request` CustomEvent | `App.tsx:116-122`，渲染层已监听，`detail.view` → `handleViewChange` |
| `navigate-to-settings` IPC 事件 | `App.tsx:125-133`，`electronAPI.on` 监听，触发 `openHub('settings')` |
| 工具框架 `MtBotToolConfig` 结构 | `image-generate-tool.ts:96-138`，`isReadOnly/needsPermission/execute` 字段成熟 |
| `browser_*` 工具结构可参考 | `bridge-browser-tools.ts:62-82`，`isReadOnly/needsPermission/wrapExecute` 模式 |
| `forwardIpcEvent` 通道存在 | `bridge-renderer-ipc.ts:94-112`，新格式事件走此通道 |
| 图片内容用 `files:read-preview-by-path` 读取 | `ToolCallCard/index.tsx:477-486`，`sendCommand` → base64 data URL |
| `executeJavaScript` 读取渲染层状态先例 | `index.ts:1097-1114`，读 localStorage，可作为回读渲染状态的技术参考 |
| 多窗口共享 preload | `pet-window-manager.ts:194-195` |
| `trySendToRenderer` 成功后**同时** `mirrorToPetWindow` | `bridge-renderer-ipc.ts:55-69`，主窗可达时也会镜像 |

### 2.2 v0.3 中不准确或缺失的内容

#### P1：`capturePage` 从未被调用过

全仓库搜不到一次 `capturePage` 调用。它是 Electron 原生 API，不需要新依赖，但主进程截图逻辑、托盘隐藏时窗口可见性处理、JPEG 压缩全部需要从零写。不能说"复用"。

**补充风险**：Electron 某些版本对 `show: false` 的窗口 `capturePage` 返回空白图，MVP 实现后需在最小化/隐藏状态下专项测试。

#### P2：`browser_*` 工具的"实现"不可复用

`browser_click` 底层走 `dispatchBrowserProxy('/act', ...)` → HTTP 代理 → Playwright CDP → 外部网页。`app_act` 要用 `mainWindow.webContents.sendInputEvent()`，这是完全不同的技术路径。**可以复用的只有**工具注册结构（`MtBotToolConfig` schema + `isReadOnly/needsPermission`），执行逻辑须独立实现。

#### P3：`app_goto` 无法真正"回读"hub 状态（核心架构缺口）

`forwardIpcEvent`（`bridge-renderer-ipc.ts:94`）是**单向 fire-and-forget**：
```
主进程 --webContents.send('agent-runtime:event', event)--> 渲染进程
```
主进程发完就完了，拿不到渲染进程执行 `openHub` 后的结果。

现有双向通道只有 `ipcMain.handle('agent-runtime:command', ...)` (`agent-runtime-ipc.ts:391`)，方向正好相反（渲染→主）。

**已实现方案**：渲染进程响应 `app-ui:goto` 后在 `window.__LUMII_APP_UI_STATE__` 挂一个同步读取函数，主进程 `executeJavaScript` 主动读，不需要渲染进程反向 invoke、不用改 preload。详见 §7.8。

#### P4：`forwardIpcEvent` 会自动镜像到 pet 窗口

`trySendToRenderer` 在主窗口**可达**时也执行 `mirrorToPetWindow`（`bridge-renderer-ipc.ts:60`）。如果 `app-ui:goto` 走 `forwardIpcEvent`，pet 窗口（`mode=pet`，无 `SettingsHubProvider`）会收到该事件，极大概率是静默丢弃，但存在错误风险。

**解法**：`app-ui:goto` 不走 `forwardIpcEvent`，直接 `mainWindow.webContents.send('app-ui:goto', payload)` 精确发给主窗口，绕过镜像逻辑。

#### P5：配额机制无现成实现

全仓库找不到"按 turn 计数"模式。`agent:turn:start/end` 事件存在可以挂，但计数器状态机需要新写，挂载点（工具 execute 闭包 or registrar 级 Map）需要在 §7.9 明确。

#### P6：permission memory 仅进程内，重启失效

`allowIfRemembered`（`permission-checker.ts:106-121`）读取的是进程内 `PermissionMemory` 缓存，重启客户端后"始终允许"失效。设置 UI 文案和工具描述需说明这一点，避免用户误解为"永久豁免"。

#### P7：`data-app-ui` 属性机制全新引入

全仓库无任何 `data-app-ui` 属性使用。这是 MVP 新增的，需要在 `ChatInput`、Sidebar、Hub Tab、设置分类导航上手动标记。

#### P8：截图文件无清理策略

`image_generate` 的缩略图读取走 `files:read-preview-by-path` + base64，文件落在工作区目录。`app_screenshot` 落在哪、由谁清理，文档 v0.3 完全没写。长期使用会累积临时截图文件。

---

## 3. 业务闭环（必须守住）

```
用户：「帮我打开技能页，看看有没有未启用的。」
  1. app_goto({ view: "skills" })     → 触发主窗口 openHub，executeJavaScript 回读 { view, hub }
  2. app_screenshot()                → 图 + refs（看见技能列表）
  3. （可选）app_act click 某个开关
  4. app_screenshot()                → 确认开关状态变了
  5. 用中文回复用户，并描述图上看到的
```

闭环规则：

1. **看**：任何「界面怎样了」都必须能截图 + 元素清单。
2. **动**：优先声明式 API（goto / 已有 `settings_*` / `skill_*` / `cron_*`）；没有 API 再用 click。
3. **验**：写操作之后用截图或 `info_status` 一类只读查询确认，禁止只凭工具 `ok: true` 向用户交差。`app_goto` 的返回 `{ view, hub }` 是 `executeJavaScript` 回读的真实值，但仍建议紧跟一张截图作为最终验收。
4. **不自伤**：不准点当前会话 composer / 停止按钮。
5. **失败可懂**：窗不存在、Hub 未开、ref 过期，返回稳定 `error` 码。

---

## 4. 能力全景

### 4.1 已有、应继续用的工具

| 域 | 已有工具 | 缺口（完整目标补，非 MVP） |
|----|----------|---------------------------|
| 会话 | `session_create/clear/compact/resume`、`info_status` | 列会话、重命名 |
| 思考/ACP | `settings_think`、`settings_backend` | 改对话模型、改视觉/生图槽位 |
| 记忆 | `memory_search/read/manage`、`profile_memory` | 无 |
| 技能 | `skill_list/search/invoke`、`execute_skill` | 启用/停用 |
| 定时 | `cron_create/list/delete` | 立即执行、暂停/恢复 |
| Agent 团队 | `agent_team_generate/optimize`、`spawn_agent` | 切换当前 Agent |
| 文件 | `file_read/write/edit`、`glob`、`grep` | 打开预览窗 |
| 浏览器 | `browser_*` | 保持外部网页 |

### 4.2 界面导航（MVP 包含最小集）

| 目标 | 实现方式 | MVP |
|------|---------|-----|
| `dashboard` / `chat` | `setActiveView(view)` + `closeHub()` via 渲染层监听 | 是 |
| `settings` / `skills` / `mcp` / `cron` / `memories` / `agents` / `plugins` | `openHub(tab)` via 渲染层监听 | 是 |
| `settings` 分类 | `openHub('settings', category)` | 是 |

`app-ui:goto` 精确发给 `mainWindow.webContents`（不走 `forwardIpcEvent`，避免 pet 窗口误伤）。

### 4.3 通用 UI（分期）

| 能力 | MVP | 二期 | 三期 |
|------|-----|------|------|
| 主窗截图 + refs | ✓ | | |
| 主窗 click（按 ref） | ✓ | | |
| 坐标 click、右键、双击 | | ✓ | |
| type / key / scroll | | ✓ | |
| SoM 编号图 | 可选（默认关） | 默认开 | |
| CLI + 控制口 | | ✓ | |
| 桌宠截图 | | ✓ | |
| 桌宠点击（画布坐标） | | | ✓ |

### 4.4 后续声明式 API（三期）

- `app_ui_state`：只读，返回 `{ view, hub, theme, modelId, petMode }`
- `settings_chat_model`、`skill_set_enabled`、`cron_run_now`、`pet_mode_set`

---

## 5. 原则

1. **有 API 走 API，截图做验收。**
2. **能 goto 就不靠点导航。** Hub 是 React state，不是链接。
3. **看 + 结构双通道。** 图给视觉模型；refs/状态给所有模型。
4. **click 优先 ref，ref 来自当次截图快照。** 坐标只作完整目标里的兜底。
5. **引擎一份。** CLI 与工具调同一 `app-ui-control` 模块。
6. **`app-ui:goto` 精确指向 `mainWindow`，不走广播。**
7. **不引入** robotjs / nut.js / 把 Playwright 接到自己的 renderer。

---

## 6. 目标架构（完整，分期落地）

```
                    ┌─ 完整目标 ──────────────────────────────────┐
  外部 AI / 技能     │  lumii-ui CLI → 127.0.0.1 + token 文件      │  ← 二期
                    └─────────────────┬───────────────────────────┘
                                      │
  Lumii Agent 循环 ── app_screenshot / app_goto / app_act
                                      │  ← MVP 只走这条（进程内）
                                      ▼
                           main/app-ui-control/
                             capture / snapshot / goto / act / coords
                                      │
                   ┌──────────────────┼──────────────────┐
                   ▼                  ▼                  ▼
            capturePage        mainWindow.webContents   sendInputEvent
            + DOM 快照         .send('app-ui:goto')      （click / 二期 type）
            （新写）            （精确，非广播）

                   ▲ executeJavaScript 回读
                   │
            window.__LUMII_APP_UI_STATE__()
            渲染进程挂的同步读取函数，主进程直接读，无需渲染配合 invoke
```

窗口支持：`main` | `pet`（二期）| `preview`（二期）。MVP 只支持 `main`，未知 target 报错。

---

## 7. MVP（一期重点）

### 7.1 只做两件事

| 功能 | 工具 | 做什么 | 不做什么 |
|------|------|--------|----------|
| **看** | `app_screenshot` | 截主窗；返回 JPEG base64 + image 块 + refs + 当前 `view/hub` | 桌宠/预览、SoM 默认关、region |
| **动** | `app_goto` + `app_act`（仅 click） | 打开 dashboard/chat/Hub Tab/设置分类；按 ref 单击 | type/key/scroll、坐标、右键、CLI |

### 7.2 MVP 用户故事（验收即这些）

1. 「截一张当前界面」→ 时间线缩略图，模型能描述侧栏/主区。
2. 「打开设置里的语音」→ Hub 打开、分类 `voice`；executeJavaScript 回读确认；再截图能看到语音相关文案。
3. 「打开技能页」→ Hub `tab=skills`；截图能看到技能列表。
4. 在技能页按 ref 点一个非 composer 控件 → 界面有可见变化，再截图确认。
5. 点自己的输入框/发送 → `blocked_composer`，会话不被污染。
6. 无视觉模型：只凭 refs / goto 回读值仍能打开设置。

### 7.3 MVP 明确砍掉

- `lumii-ui`、本机 HTTP、token 文件、写入 PATH
- `type` / `key` / `scroll` / 坐标点击
- pet / preview
- 设置项里多余开关（只留一个总开关，默认开）
- 给每个页面补齐 `data-app-ui`（只打侧栏设置按钮、Hub Tab、设置左侧分类；其余靠通用选择器）

### 7.4 MVP 数据流

```
用户 → Agent
  A: app_goto({ view: "skills" })
  主进程: mainWindow.webContents.send('app-ui:goto', { view: "skills" })
  渲染进程: openHub('skills') → 挂 window.__LUMII_APP_UI_STATE__
  主进程: executeJavaScript 读取 → { view: activeView, hub: { open, tab, category } }
  工具返回: { ok: true, view: "skills", hub: { open: true, tab: "skills", category: null } }

  A: app_screenshot()
  主进程: mainWindow.webContents.capturePage() → JPEG → base64
  主进程: mainWindow.webContents.executeJavaScript(SNAPSHOT_SCRIPT) → refs[]
  工具返回: text JSON + image 内容块
  Agent → 用户: 描述技能列表
```

### 7.5 MVP 工具契约

**`app_goto`**

```ts
{
  view: 'dashboard' | 'chat' | 'settings' | 'skills' | 'mcp'
      | 'cron' | 'memories' | 'agents' | 'plugins'
  category?: 'general' | 'workspace' | 'modelConfig' | 'voice'
           | 'channels' | 'codingDev' | 'pet' | 'usage' | 'privacy' | 'aboutAndUpdate'
}
```

- `dashboard` / `chat`：发 `app-ui:goto`，渲染层关 Hub 切主视图。
- 其余：发 `app-ui:goto`，渲染层 `openHub(tab, category)`。
- 发完后 `await executeJavaScript('window.__LUMII_APP_UI_STATE__?.()')` 回读真实状态。
- 返回 `{ ok, view, hub: { open, tab, category } }`，此值为**真实渲染状态**。
- `isReadOnly: false`，`needsPermission: false`。

**`app_screenshot`**

```ts
{ annotate?: boolean }  // MVP 默认 false
```

返回 text JSON + image 内容块（`{ type: 'image', data: base64jpeg, mimeType: 'image/jpeg' }`）：

```ts
{
  ok: true
  snapshotId: string          // 单调递增字符串 id，点击时用于校验过期
  view: string
  hub: { open: boolean, tab: string | null, category: string | null }
  width: number
  height: number
  refs: Array<{ ref: string, role: string, name: string, x: number, y: number, w: number, h: number }>
  truncated: boolean          // refs 是否因上限 80 被截断
}
```

截图文件：落在 `~/.lumii/temp/screenshots/` 下，文件名带 snapshotId 和时间戳，启动时清空整个目录。工具执行时只用内存 base64 返回，不长期持有文件路径。

**`app_act`（MVP）**

```ts
{ action: 'click', ref: string, snapshotId?: string }
```

- 必须有 `ref`。
- `snapshotId` 不匹配当前 → `{ ok: false, error: 'stale_snapshot' }`。
- 命中 `[data-app-ui-block="composer"|"runtime"]` → `{ ok: false, error: 'blocked_composer' }`。
- 点击前 `scrollIntoView`，重测 rect，再 `mainWindow.webContents.sendInputEvent` 单击（mousedown → mouseup → click）。
- `needsPermission: true`（可"始终允许"；记忆仅本进程内有效，重启失效，工具 description 需说明）。

### 7.6 DOM 快照脚本（注入 executeJavaScript）

```js
// 在 mainWindow.webContents.executeJavaScript 中运行
// 收集可见可交互节点，上限 80
const SELECTORS = [
  'button', 'a[href]', 'input', 'textarea', 'select',
  '[role=button]', '[role=tab]', '[role=menuitem]', '[role=switch]',
  '[contenteditable=true]', '[data-app-ui]', '[tabindex]:not([tabindex="-1"])'
].join(',')

// 跳过：disabled / aria-hidden / 零尺寸 / 视口外 / [data-app-ui-ignore]
// 按面积降序排列，取前 80
// 返回 Array<{ ref, role, name, x, y, w, h }>
```

- `ref` 格式：`e{index}`（如 `e1`、`e2`），每次截图重新生成，与 `snapshotId` 绑定。
- 主入口补 `data-app-ui="nav-settings|hub-tab|hub-category"`，保证 goto 之外仍能被点到。
- 快照 id 用全局递增计数器，与截图一一对应。

### 7.7 文件落点

| 路径 | 职责 |
|------|------|
| `apps/windows/src/main/app-ui-control/capture.ts` | `capturePage` + JPEG 压缩（长边 ≤ 1280），返回 base64 |
| `apps/windows/src/main/app-ui-control/snapshot.ts` | `executeJavaScript` 注入快照脚本，返回 refs + snapshotId |
| `apps/windows/src/main/app-ui-control/goto.ts` | 发 `app-ui:goto` → `executeJavaScript` 读 `window.__LUMII_APP_UI_STATE__` |
| `apps/windows/src/main/app-ui-control/act.ts` | ref 解析 → `sendInputEvent` click；composer block 检查 |
| `apps/windows/src/main/app-ui-control/types.ts` | 共享类型（`AppUiRef`、`AppUiState`、`GotoParams` 等） |
| `apps/windows/src/main/app-ui-control/screenshot-cleanup.ts` | 启动时清空 `~/.lumii/temp/screenshots/` |
| `bridge-app-ui-tools.ts` + `BridgeToolRegistrar.registerAll()` | 注册三工具 |
| `apps/windows/src/renderer/App.tsx` | 监听 `app-ui:goto` → `handleViewChange` / `openHub`；挂 `window.__LUMII_APP_UI_STATE__ = () => JSON.stringify({ view, hub })` |
| `apps/windows/src/renderer/pages/ChatPage/components/ChatInput/index.tsx` | 根元素加 `data-app-ui-block="composer"` |
| Sidebar 设置按钮 | `data-app-ui="nav-settings"` |
| Hub Tab 按钮行 | `data-app-ui="hub-tab"` |
| 设置分类导航项 | `data-app-ui="hub-category"` |
| preload `index.ts` | **只在现有通道接不进时才新增一条**；优先复用 `electronAPI.on` / `electronAPI.agentRuntime.sendCommand` |

### 7.8 回读通道设计（新增，v0.3 缺失）

```
主进程                              渲染进程
─────────────────────────────────────────────────────────
app_goto.execute():
  mainWindow.webContents
    .send('app-ui:goto', payload) ──────────────────→  App.tsx 监听 'app-ui:goto'
                                                        执行 handleViewChange / openHub
                                                        （同步 setState，React 批处理）

  // 等待一帧让 React 完成 setState
  await new Promise(r => setTimeout(r, 100))

  // 通过 executeJavaScript 读取渲染层暴露的状态
  const stateJson = await mainWindow.webContents
    .executeJavaScript('window.__lumiiAppUiState?.()')

  return JSON.parse(stateJson)
─────────────────────────────────────────────────────────
渲染层：App.tsx 在 window 上挂一个同步读取函数：
  window.__lumiiAppUiState = () => JSON.stringify({
    view: activeView,
    hub: { open: hubState.open, tab: hubState.tab, category: hubState.category }
  })
```

**为何不用 `ipcMain.handle('app-ui:query-state')`**：该方案要求渲染进程主动 `ipcRenderer.invoke`，需修改 preload 并在渲染层添加逻辑。`executeJavaScript` 读取已有先例（`index.ts:1097-1114` 读取 localStorage），语义更简单：主进程主动读，无需渲染配合 invoke。延迟 100ms 等待 React `setState` 批处理完成，不够则可增到 150ms（ponytail: 固定延迟，若 Hub 动画变慢可改为轮询+超时）。

### 7.9 配额计数器（新增，v0.3 缺失）

挂在 `bridge-app-ui-tools.ts` 注册时的 per-turn 闭包，无需新文件：

```ts
// 在 registerAll() 内，随 agent turn 生命周期创建
const counters = { screenshot: 0, act: 0, goto: 0 }
const LIMITS = { screenshot: 8, act: 20, goto: 20 }

// 每个工具 execute 开头：
counters[tool]++
if (counters[tool] > LIMITS[tool]) return errorResult('quota_exceeded')

// agent:turn:end 事件触发时重置：
bridgeRendererIpcChannel.on('turn:end', () => {
  counters.screenshot = counters.act = counters.goto = 0
})
```

注意：turn 边界由 `agent:turn:start/end` 事件标记，`bridge-agent-instance-events.ts` 已有事件转发，可挂 listener。

---

## 8. 完整规格（二期及以后）

> 2026-08-14 补充：MVP（Part A/B）已实现并验收通过（`feat/agent-app-ui-control` 分支 9 commits）。以下二期设计在 §8.5 补了代码事实核查，其余章节按核查结果修正。

### 8.1 `app_act` 完整 action

`click | type | key | scroll`

中文 type 必须用 native value setter：

```js
Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, text)
el.dispatchEvent(new Event('input', { bubbles: true }))
```

再辅以 `insertText`。禁止 keyCode 打拼音。

全仓库核查（`packages/browser-control/src` 及 `app-ui-control/`）确认：**没有任何现成的受控输入注入实现**可参考，`browser_type` 走的是 Playwright CDP `Input.insertText`，与 `app_act type` 要用的 native value setter + dispatchEvent 是完全不同的两套代码，不能抽公共函数，只能在 `act.ts` 里独立实现并单测中文输入。

`scroll` 复用 `buildClickPrepareScript`（`act.ts:62`）里已有的 `elementFromPoint` 定位逻辑，改成 `el.scrollBy(dx, dy)`，不需要新的坐标换算。

`key` 白名单只收 `Enter | Escape | Tab | Backspace | Delete | ArrowUp/Down/Left/Right`，用 `sendInputEvent({ type: 'keyDown'|'keyUp', keyCode })`，禁止任意 keyCode（防止拼音注入绕过 `type` 的 native setter 路径）。

### 8.2 CLI（二期）

```
lumii-ui screenshot [--annotate]
lumii-ui goto --view skills
lumii-ui click --ref 3
lumii-ui type --ref 7 --text "..." --clear
```

stdout JSON；应用未运行 exit 3；不自动拉起客户端。

**运行时依赖（代码事实核查后修正）**：v0.2 假设的"打包时带 node 或用 `Lumii.exe` 当运行时"其实已有现成方案，不需要新设计——`apps/windows/src/main/runtime-env.ts` 的 `resolveNodeExec()`（第 68-72 行）就是这个问题的答案：

```ts
// runtime-env.ts:68-72，已存在，直接复用
export function resolveNodeExec(): { command: string; env: Record<string, string> } {
  const system = detectSystemNode()
  if (system) return { command: system, env: {} }
  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
}
```

系统有 node 就用系统的；没有就用 `Lumii.exe` 自己的 `process.execPath` 配 `ELECTRON_RUN_AS_NODE=1` 当纯 Node 跑——这正是 mcp-client.ts 已经在用的模式，`lumii-ui` 不需要发明新机制。

CLI 的 shim 生成直接照抄 `writeShimPair()`（`runtime-env.ts:84-118`）的做法：安装时把 `lumii-ui.mjs`（零依赖 ESM 脚本，放 `apps/windows/resources/app-ui-cli/`）与一对 shim（`lumii-ui` sh 脚本 + `lumii-ui.cmd`）一起写到 `getShimDir()`（`~/.lumii/runtimes/bin`，已在 PATH 末尾），shim 的 target 用 `resolveNodeExec()` 算出的 command/env 去 `exec` 这个 `.mjs`。这样用户装完客户端、跑过一次 `initScriptRuntimes()` 之后，`lumii-ui` 命令在任意终端都能跑，不需要额外的 extraFiles 打包节点。

**控制口**：复用 `packages/browser-control` 已有的端口探测模式而不是"随机端口"——`findAvailablePort(startPort, label)`（`packages/browser-control/src/browser/control-service.ts:144`，`apps/windows/src/main/browser-service.ts` 有相同实现）以 `+10` 步长重试 3 次，找不到就落到 `startPort + 3*10`。`app-ui` 控制口起始端口另分配一个不冲突的默认值（避开 CDP `DEFAULT_CDP_PORT` 与 extension relay 端口），同样只监听 `127.0.0.1`（参考 `extension-relay.ts:166` 的 `isLoopbackHost` 校验，拒绝非 loopback host）。

**Token**：用 `node:crypto` 的 `randomUUID()`（已有先例：`voice-temp-ref.ts:7,24`），每次应用启动生成一个，写入 `resolveWindowsClientDataRoot()/runtime/app-ui.json`（即 `~/.lumii/runtime/app-ui.json`，用已有的 `resolveWindowsClientDataRoot()` 而不是硬编码 `~/.lumii`，保证 `LUMII_CLIENT_DATA_DIR` 覆盖时行为一致）。CLI 请求头带 `Authorization: Bearer <token>`，控制口校验不通过返回 401。

打包方案（修正）：**不需要** extraFiles 带 node，也不需要用 `Lumii.exe` 加子命令模式——上面的 shim + `resolveNodeExec()` 组合已经覆盖"不依赖系统 node"这个 v0.2 关键漏洞。`electron-builder.json` 目前没有为此新增任何 extraResources 条目；`lumii-ui.mjs` 走 `files` 里已有的 `out/**/*` 或单独加一条 `resources/app-ui-cli` 到 `extraResources`（二期开工时定，不改变现有 asar/asarUnpack 结构）。

### 8.3 桌宠 / 预览

截图：`target=pet|preview`，画布也能 `capturePage`。

**窗口获取方式（代码事实核查）**：pet 窗口不是通过 `getMainWindow()` 拿到的，要经 `apps/windows/src/main/pet/pet-mode-ipc.ts:57` 的 `getPetWindowManager()`，再调 `PetWindowManager.getPetBrowserWindow()`（`pet-window-manager.ts:115-117`，内部已判 `isDestroyed()`）。`createAppUiController` 的 `deps.getMainWindow` 签名需要扩展成按 `target` 分发的 `getWindow(target)`，`main` 走原逻辑，`pet`/`preview` 走 `getPetWindowManager()?.getPetBrowserWindow() ?? null`，找不到窗口时返回与 `app_not_running` 同结构的 error（如 `pet_not_running`）。

这与 goto 的隔离思路一致（§4.2/§7.8 提到的"不走会镜像到 pet 窗口的 `forwardIpcEvent`，而是精确 send"）：截图同样不该走任何广播通道，是"按 target 精确取窗口 → 直接 capturePage"，天然不会误伤。

点击：pet 用画布 DIP 坐标，三期，不做 DOM ref（pet 渲染是 pixi.js canvas，没有 DOM 树可供 `SNAPSHOT_SCRIPT` 遍历）。

### 8.4 与 `browser_*` / 外部软件 CLI 的分界

| 对象 | 工具 |
|------|------|
| Lumii 自己的窗 | `app_*` / `lumii-ui`（app-ui-control 范围） |
| 外部网页 | `browser_*` |
| 其它桌面软件 | **不走 app-ui-control**；走内置技能 `cli-hub`（CLI-Anything / CLI-Hub），Agent 用 `bash` 调 `cli-hub` / `cli-anything-*` |

Lumii Agent **禁止**用 `bash lumii-ui` 代替进程内工具。  
外部软件 harness 的安装与调用见 `apps/windows/bundled-skills/技能管理/cli-hub/SKILL.md` 与 `docs/design/2026-08-15-cli-hub-external-software-design.md`。

---

## 9. 安全

| 能力 | 只读 | 权限提示 | MVP |
|------|------|---------|-----|
| `app_screenshot` | 是 | 否 | ✓ |
| `app_goto` | 否 | 否 | ✓ |
| `app_act click` | 否 | 是（可始终允许；仅本进程内有效） | ✓ |
| `app_act type/key` | 否 | 是 | 二期 |
| CLI | — | 开关控制 | 二期 |

拦截：`[data-app-ui-block="composer"]`、runtime 停止键、系统原生文件对话框（`blocked_native_dialog`，二期）。  
总开关关闭：三工具 `guardAppUiTool()` 直接返回 `{ ok: false, error: 'disabled' }`（`bridge-app-ui-tools.ts:90-98`，已实现）。

---

## 10. 分期

| 期 | 目标 | 交付 |
|----|------|------|
| **MVP / 一期** | 闭环可演示 | 主窗 screenshot + goto（executeJavaScript 回读）+ click(ref)；data-app-ui 主入口；composer 拦截；时间线缩略图；截图临时目录清理 |
| **二期** | 对外 AI + 完整交互 | CLI+控制口（自带运行时）、type/key/scroll、坐标、SoM、桌宠/预览截图 |
| **三期** | CLI 作为统一对外控制面 | 命令总线整体转发 + 碎片能力白名单 + 设置写通道 + 来源标识与权限护栏；详见 **§14** |
| 以后 | 系统级 Computer Use、桌宠画布点击 | 单独评审 |

YAGNI（完整目标也不做）：录屏、暴露 CSS/XPath、`app_eval`、自动启动 Lumii。

---

## 11. 测试与验收

### 11.1 MVP 单测

- `capture.ts`：窗口隐藏时 `capturePage` 是否返回有效图像（需 e2e，单测用 mock）
- `goto.ts`：合法 view/category；非法 view 返回 error；`executeJavaScript` 超时处理
- `snapshot.ts`：隐藏/零尺寸/ignore 节点过滤；上限 80；`data-app-ui` 节点优先保留
- `act.ts`：缺 ref、stale snapshotId、composer block；click 坐标换算 DIP
- 配额：连续调用超过限额后返回 `quota_exceeded`；turn 结束后重置

### 11.2 MVP 手工（§7.2 六条）

### 11.3 完整目标另增

- CLI 无应用 exit 3；错 token 401
- 中文 type 进入 React 受控框
- 关总开关后工具消失

---

## 12. 风险

| 风险 | 缓解 |
|------|------|
| `capturePage` 在托盘隐藏窗口返回空白 | 截图前确认 `win.isVisible() || win.webContents.isPainting()`，必要时临时 `show()` 再隐藏 |
| `executeJavaScript` 读取状态有延迟 | 固定等待 100ms（ponytail: 可升级为轮询+超时 500ms） |
| Hub 动画未完成时读到中间态 | Hub 打开动画时长 < 100ms，可接受；若动画拉长需调整 |
| 快照漏控件 | 主入口 data-app-ui；上限内按面积优先 |
| 视觉模型点偏 | MVP 只接受 ref；坐标二期 |
| 截图撑上下文 | JPEG 长边 ≤ 1280；annotate 默认关 |
| pet 窗口收到 goto 事件 | goto 走 `mainWindow.webContents.send` 精确发送，不走 forwardIpcEvent |
| permission memory 重启失效用户误解 | 工具 description 和 UI 文案写明"本次运行有效" |
| 截图文件累积 | 启动时清空 `~/.lumii/temp/screenshots/` |

---

## 13. 附录

### 13.1 工具名

```
app_screenshot
app_goto
app_act
```

CLI（二期）：`lumii-ui`  
分类：`agent`

### 13.2 给模型的分工（写入工具 description）

```
看界面：app_screenshot
打开页面：app_goto（设置/技能/定时等用这个，不要点侧栏）
点控件：app_act click（先截图拿 ref，ref 不跨 snapshotId 复用）
改思考级别/会话/技能执行/定时：用已有 settings_think、session_*、skill_*、cron_*
外部网页：browser_*
做完写操作后必须再截图或查询确认
禁止点聊天输入框和发送键
app_act click "始终允许"仅本次运行有效，重启后重置
```

### 13.3 版本

| 版本 | 日期 | 说明 |
|------|------|------|
| v0.1 | 2026-08-13 | 两工具 + Electron 注入 |
| v0.2 | 2026-08-14 | CLI 作主契约（一期过重） |
| v0.3 | 2026-08-14 | 完整目标 + 能力全景 + 闭环；MVP 收成 screenshot + goto/click；CLI 改二期 |
| v0.4 | 2026-08-14 | 代码事实核查后修正：补回读通道（executeJavaScript）、修正 pet 误伤、补配额落点、补截图清理、修正 browser_* 复用边界 |
| v0.5 | 2026-08-14 | MVP（Part A/B）验收通过并已合并至 `feat/agent-app-ui-control`；补全二期设计代码事实核查：CLI 运行时复用 `runtime-env.ts` 的 `resolveNodeExec()`/`writeShimPair()`（不需要 extraFiles 带 node）、控制口端口探测复用 `browser-control` 的 `findAvailablePort()`、token 用 `randomUUID()` 落 `resolveWindowsClientDataRoot()`；pet/preview 截图窗口改经 `getPetWindowManager().getPetBrowserWindow()`，非 `getMainWindow()`；type 补 native value setter 与 browser_type 不可复用的核查结论；修正正文中残留的 v0.3 期 `ipcRenderer.invoke('app-ui:query-state')` 措辞，统一为已实现的 `executeJavaScript` 回读 |
| v0.6 | 2026-08-15 | 三期目标改为「CLI 作为统一对外控制面」（尽量把能封装的都封装成 CLI）。新增 §14：核查出 `agent-runtime-commands.ts` 是 **92** 命令 + `AgentRuntimeCommandResult` 返回类型映射的完整类型化总线，CLI 主体可做**泛化转发**而非逐个手写；原三期 4 个"待建声明式 API"全部已存在（`cron:run`、`skills:setEnabled`、`session:preferredModel:set`、`PET_IPC.switchMode`），三期性质从"造 API"变为"暴露既有 API"；唯一真实缺口是设置**只能读不能写** |
| v0.7 | 2026-08-15 | §14 二次核查修正（v0.6 有 9 处不闭环）：① `handleCommand`/`ipcBridgeRef` 是模块私有，A 层"直接复用"不成立，补 §14.2.0 导出地基；② 命令联合类型 92 个成员**无 origin 字段**，origin 是对话轮次维度不是命令维度，注入方案否决；③ `getForOrigin` 只在 `agent-instance.ts:555` 的 prompt 路径生效，给 `CapabilityRegistry` 加 `external_cli` 是**运行时空转的假护栏**，整条否决；④ 黑名单改**白名单**——原方案默认开放 76 条，其中 `mcp:writeConfigFile` 等价 RCE、`files:*` 与"不暴露文件操作"自相矛盾、`storage:exportJsonl` 可导出全部会话；⑤ 命令总线**无 `skills:*`**，`skill list` 从 A 层改 B 层；⑥ B 层 handler 是匿名闭包捕获模块私有变量，需补 accessor，且 `setEnabled` 必须复现 `skillWatcher.refresh()` 副作用；⑦ settings merge 移入注入脚本内避免 read-modify-write 竞态，删除死代码与双重转义不一致；⑧ 补总开关自举防护（`allowAgentAppUiControl` 不可经 CLI 写）；⑨ 补 `/command` 串行化（HTTP 并发打破 `agent-runtime-ipc.ts:2447` 声明的串行不变量）、CLI 速率限制（per-turn 配额对 CLI 不适用）、Windows 下 `chmod 600` 无效的诚实说明、`model set` 的 `sessionKey` 必填未决问题 |

---

## 14. 三期：CLI 作为统一对外控制面

### 14.1 为何 CLI 是三期核心

原三期计划的 4 个「待建声明式 API」经代码核查**全部已存在**：

| 能力 | 已存在于 | 代码位置 |
|------|---------|---------|
| `cron:run`（立即执行定时任务） | 命令总线 | `agent-runtime-ipc.ts:852` |
| `skills:setEnabled`（启用/禁用技能） | 独立 `ipcMain.handle` | `index.ts:2154` |
| `session:preferredModel:set`（切换模型） | 命令总线 | `AgentRuntimeCommand` union |
| `pet:switchMode`（桌宠模式切换） | 独立 `ipcMain.handle` | `pet-mode-ipc.ts:121` |

三期性质因此从**「造 API」变为「暴露既有 API」**。新建工作有四件：
1. **打通调用地基**：`handleCommand` 与 `ipcBridgeRef` 目前都是 `agent-runtime-ipc.ts` 的**模块私有**符号（该文件只导出 `LOCAL_USER_ID:299` 和 `registerAgentRuntimeIPC:536`），`server.ts` 无法调用。必须先导出，见 §14.2.0
2. **设置写通道**：主进程目前只有读，无写路径
3. **CLI 命令集扩展**：Task 10 只规划了 screenshot/goto/click 3 条
4. **服务端白名单**：`bash → lumii-ui` 可绕过权限管线，防线只能落在控制口自身，见 §14.4

**已排除的方案（核查后否决）：**

| 方案 | 否决原因 |
|------|---------|
| 往命令里注入 `origin: 'external_cli'` | `AgentRuntimeCommand` 的 92 个成员**无一带 origin 字段**。origin 是「对话轮次」维度（`AgentTurnRequest`、`agentInstance.prompt(msg, images, origin)`），不是「命令」维度。要加需改 92 个类型或套包装层，收益不匹配 |
| 靠 `CapabilityRegistry.isAllowedForOrigin` 拦 CLI | `getForOrigin` 的唯一生产调用点是 `agent-instance.ts:555`，只在 **prompt 时**过滤能力清单。控制口 `/command` 不经过 `agent-instance`，加 `external_cli` 分支**对 CLI 调用不生效**，会写出「测试通过但运行时空转」的假护栏 |

---

### 14.2 能力分层架构

```
lumii-ui CLI
    │  HTTP POST 127.0.0.1:<port>  Authorization: Bearer <token>
    ▼
app-ui-control/server.ts（控制口）
    │  ① 总开关 ② token ③ 速率限制
    ├── POST /command      → COMMAND_ALLOWLIST 过滤 → 串行队列 → handleCommand(bridge, cmd)
    │                        A 层：命令总线转发（白名单，默认拒绝）
    ├── POST /settings/*   → executeJavaScript（脚本内 merge）+ 受保护字段黑名单
    │                        C 层：设置读写通道
    ├── POST /ipc/skills/* → getSkillRuntime().setLocalEnabled() + skillWatcher.refresh()
    │                        B 层：碎片能力白名单
    └── POST /ipc/pet/*    → switchPetMode() / getPetWindowManager()
                             B 层：碎片能力白名单
```

三层都建立在两个前置改造上：`handleCommand` 与 bridge accessor 的导出（§14.2.0），以及 `skillRuntime` accessor 的导出。

#### 14.2.0 前置：导出调用地基

`server.ts` 要转发命令，必须先让 `agent-runtime-ipc.ts` 暴露两样东西：

```ts
// agent-runtime-ipc.ts 新增导出
export { handleCommand }                              // 现为 module-private async function（560 行）
export function getAgentRuntimeBridge(): AgentRuntimeBridge | null { return ipcBridgeRef }
```

`ipcBridgeRef`（305 行）保持私有，通过 getter 读取，避免外部改写。这一步是三期地基，Task 14 之前必须完成。

**并发不变量**：`agent-runtime-ipc.ts:2447` 的注释声明「所有调用方（handleCommand）均在同一 IPC 任务中串行执行」。HTTP 并发请求会打破该假设，因此 `/command` 路由必须串行化——用一个 `Promise` 链把请求排队，见 §14.2.1。

#### 14.2.1 A 层：命令总线转发（白名单）

`AgentRuntimeCommand`（`shared/agent-runtime-commands.ts:779`）是 92 成员的判别联合类型，对应 `AgentRuntimeCommandResult<T>` 精确返回类型映射。控制口收到 `POST /command` 后串行调用已导出的分发函数：

```ts
// server.ts — /command 路由核心（伪代码）
let queue: Promise<unknown> = Promise.resolve()
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)   // 前一个失败也继续排队
  queue = next.catch(() => {})
  return next
}

if (!COMMAND_ALLOWLIST.has(command?.type)) {
  return { ok: false, error: 'not_exposed' }
}
const result = await enqueue(() => handleCommand(getAgentRuntimeBridge()!, command))
```

**白名单而非黑名单。** 92 条命令中默认全部拒绝，只放开明确评审过的：

| 分组 | 开放命令 | 说明 |
|------|---------|------|
| 定时任务 | `cron:list`、`cron:runs`、`cron:run`、`cron:create`、`cron:update`、`cron:delete` | 三期主场景 |
| 工具开关 | `tools:list`、`tools:toggle` | 只影响本机工具可见性 |
| 会话偏好 | `session:preferredModel:set`、`session:thinkingPrefs:set` | 需 `sessionKey`，见 §14.3 注 |
| 会话只读 | `conversation:list`、`conversation:messages`、`conversation:contextUsage` | 只读 |
| 运行时只读 | `runtime:ping`、`runtime:enabled`、`runtime:featureFlags:get`、`agentDefinitions:list`、`agentInstance:list`、`commands:list`、`tasks:list` | 只读探针 |
| 记忆 | `agentMemories:list`、`agentMemories:export`、`agentMemories:provenance` | 只读；`delete`/`update`/`clear` 不开放 |
| MCP 只读 | `mcp:status` | 见下方拒绝理由 |
| 存储只读 | `storage:stats`、`storage:listBackups`、`storage:auditRecent` | 只读 |
| 编码后端 | `codingDev:getBackend`、`codingDev:listBackends`、`codingDev:setBackend` | 本机开发环境切换 |

**明确不开放且需记录理由的高危项**（即便看起来"只是配置"）：

| 命令 | 拒绝原因 |
|------|---------|
| `mcp:writeConfigFile` | content 是任意字符串，写入后可注入任意 stdio server 命令，**等价于任意代码执行** |
| `mcp:upsert` / `mcp:import` / `mcp:remove` / `mcp:setEnabled` / `mcp:reconnect` | 同上，MCP 配置面全部关闭 |
| `files:delete` / `files:import` / `files:saveAs` / `files:open` | 文件系统写与外部程序打开；与 §14.2.2「B 层不暴露文件操作」保持一致，A 层同样不开 |
| `files:list` / `files:search` / `files:readPreview*` | 可枚举与读取用户文件内容，属信息泄露面，三期不开 |
| `user:send` / `user:steer` / `user:abort` | CLI 不得成为隐蔽注入对话的通道 |
| `user:permissionRespond` / `user:askUserRespond` | 可自动批准权限弹窗，直接击穿权限管线 |
| `storage:clearMalformed` / `storage:restore*` / `storage:deleteBackup` / `storage:exportJsonl` | 破坏性操作；export 可导出全部会话内容 |
| `agentInstance:create` / `createById` / `destroy` / `prompt` / `abort` | 生命周期与对话触发属 UI 职责 |
| `message:delete` / `message:edit` / `message:editAndResend` / `conversation:fork` / `conversation:delete` | 会话内容破坏性修改 |
| `runtime:featureFlags:set` / `runtime:modelCatalog:set` | 实验性开关，保留内部调试 |
| `image:generate` / `image:recognize` / `image:process` | 消耗额度且产生外部 API 调用，三期不开 |
| `skill:confirmDraft` / `rejectDraft` / `deprecate` | 技能草稿审批是人类决策点 |
| `agentDefinition:*`（sync/cache 系列） | 缓存与同步属内部维护 |

新增命令默认落入拒绝，**扩白名单必须走评审**。

#### 14.2.2 B 层：碎片能力白名单

166 个 `ipcMain.handle` 分布在 7 个文件（`index.ts` 126、`pet-mode-ipc.ts` 17、`skillnet-store` 10、`updater-service` 8、`preview-window-ipc` 3、`agent-runtime-ipc` 1、`voice-ipc` 1）。

**关键约束：这些 handler 是 `ipcMain.handle` 的匿名回调，捕获了各自模块的私有变量，外部无法直接调用。** 每条 B 层路由都要确认底层业务函数是否可导出：

| 控制口路由 | 底层业务函数 | 可达性 | 备注 |
|-----------|------------|-------|------|
| `POST /ipc/skills/list` | `skillRuntime.listLocalInstalled()` | 需补 accessor | handler 在 `index.ts:2047`，依赖模块私有 `skillRuntime`（241 行） |
| `POST /ipc/skills/setEnabled` | `skillRuntime.setLocalEnabled()`（`skill-runtime.ts:1159`） | 需补 accessor | handler（`index.ts:2154`）额外做了参数校验 + `skillWatcher.refresh()`，**server 侧必须复现这两个副作用**，否则技能列表不刷新 |
| `POST /ipc/pet/switchMode` | `switchPetMode()`（`pet-mode-ipc.ts:74`） | ✅ 已 export | 直接调用 |
| `POST /ipc/pet/getMode` | `getPetWindowManager()?.getMode()` | ✅ 经 `getPetWindowManager()`（`pet-mode-ipc.ts:57`） | handler 本身是匿名闭包，走 manager |
| `POST /ipc/pet/listModels` | `getPetWindowManager()` 相关方法 | ✅ 同上 | — |

`index.ts` 需新增一个 accessor 导出 `skillRuntime`（如 `export function getSkillRuntime(): ClientSkillRuntime | null`）与 `skillWatcher`，否则 skills 两条路由无法落地。

原则：**不在 B 层暴露任何文件系统操作、渠道登录、技能安装/卸载、更新器（`updater-service`）、语音（`voice-ipc`）**。

#### 14.2.3 C 层：设置写通道

主进程无设置写路径（`localStorage.getItem` 仅 2 处：`bridge-tool-registrar.ts:1634`、`index.ts:1117`）。控制口通过 `executeJavaScript` 在渲染进程内完成读写。

**读**：
```ts
mainWindow.webContents.executeJavaScript(
  `localStorage.getItem('mtbot-assistant-settings')`
)
```

**写**：merge 必须在**注入脚本内部**完成，一次 `executeJavaScript` 内读改写，避免 read-modify-write 竞态（主进程先读、再 merge、再写的话，期间用户在设置页点保存会被覆盖——`useSettings.saveSettings`（`useSettings.ts:314`）是整对象覆盖式 `setItem`，没有版本号或 CAS）：

```ts
const PATCH_SCRIPT = (patchJson: string) => `(() => {
  const KEY = 'mtbot-assistant-settings'
  const deepMerge = (t, s) => { /* 参照 useSettings.ts:85-112 */ }
  const current = JSON.parse(localStorage.getItem(KEY) || '{}')
  const next = deepMerge(current, ${patchJson})
  localStorage.setItem(KEY, JSON.stringify(next))
  window.dispatchEvent(new CustomEvent('mtbot-settings-update', { detail: next }))
  return JSON.stringify(next)
})()`

await mainWindow.webContents.executeJavaScript(PATCH_SCRIPT(JSON.stringify(patch)))
```

`patchJson` 由 `JSON.stringify(patch)` 生成后**直接内嵌**（它已是合法 JS 字面量，不需要二次 `JSON.stringify` 转义）。`useSettings.ts:228-229` 的监听器收到 `mtbot-settings-update` 后 React 立即生效，无需重启。

**自举防护**：`privacy.allowAgentAppUiControl` 是 App UI 控制总开关（`enabled.ts` 读它）。若允许 CLI 写这个字段，Agent 可以在开关关闭时通过 `lumii-ui settings set privacy.allowAgentAppUiControl true` 自行开启。因此 C 层维护一份**不可写字段黑名单**，至少包含 `privacy.allowAgentAppUiControl`，命中直接返回 `{ ok: false, error: 'field_protected' }`。

---

### 14.3 lumii-ui CLI 命令集（三期扩展）

Task 10（二期）已规划 `screenshot` / `goto` / `click`。三期追加：

| 命令 | 控制口路由 | 对应能力 | 层 |
|------|-----------|---------|---|
| `lumii-ui command <type> [--data <json>]` | `POST /command` | 命令总线透传（受白名单约束） | A |
| `lumii-ui settings get [<key.path>]` | `POST /settings/read` | 读 localStorage | C |
| `lumii-ui settings set <key.path> <value>` | `POST /settings/write` | 注入脚本内 merge + dispatch | C |
| `lumii-ui cron list` | `POST /command {"type":"cron:list"}` | A 层白名单 | A |
| `lumii-ui cron run <id>` | `POST /command {"type":"cron:run","id":"..."}` | `agent-runtime-ipc.ts:852` | A |
| `lumii-ui model set <modelId> [--session <key>]` | `POST /command {"type":"session:preferredModel:set"}` | A 层白名单 | A |
| `lumii-ui tools list` | `POST /command {"type":"tools:list"}` | A 层白名单 | A |
| `lumii-ui tools toggle <name> <on\|off>` | `POST /command {"type":"tools:toggle"}` | `agent-runtime-ipc.ts:963` | A |
| `lumii-ui skill list` | `POST /ipc/skills/list` | `index.ts:2047`（**B 层**，命令总线无 `skills:*`） | B |
| `lumii-ui skill enable <id>` | `POST /ipc/skills/setEnabled` | `index.ts:2154` | B |
| `lumii-ui skill disable <id>` | `POST /ipc/skills/setEnabled` | `index.ts:2154` | B |
| `lumii-ui pet mode <modeName>` | `POST /ipc/pet/switchMode` | `switchPetMode()`（`pet-mode-ipc.ts:74`） | B |
| `lumii-ui pet modes` | `POST /ipc/pet/listModels` | `pet-mode-ipc.ts:129` | B |

`lumii-ui command` 是泛化入口，可访问 §14.2.1 白名单内的命令，白名单外返回 `not_exposed`。具名子命令是高频操作的快捷封装，参数更友好。

**`model set` 的 sessionKey 问题**：`SessionPreferredModelSetCommand`（`agent-runtime-commands.ts:117`）的 `sessionKey` 是**必填**，CLI 无法凭空构造。`--session` 缺省时的行为需先确认「当前活跃会话」在主进程侧如何取得（渲染进程持有会话状态，主进程未必有）；确认前 `--session` 视为必填，不做隐式默认。

命名说明：handler 实际调用 `bridge.primeSessionModelCompaction()`，函数名像是"压缩预热"，但实现（`bridge-session-model-catalog.ts:138-148`）确实写入 `sessionPreferredModelRaw` 并 `applyCompactionForSession`，语义等于"设置会话首选模型"，可用。

stdout 统一输出控制口返回的 JSON 原样；`--data` 接受 JSON 字符串或 `-`（从 stdin 读）。

---

### 14.3.1 命令注册表与 help（单一事实来源）

CLI 命令若在「参数解析」「help 文本」「工具 description」三处分别硬编码，必然漂移。因此 `lumii-ui.mjs` 内维护一份**声明式注册表**，同时驱动三件事：分发、help 输出、能力发现。

```js
// lumii-ui.mjs — 注册表结构
const COMMANDS = [
  {
    name: 'screenshot',
    group: '看',
    usage: 'screenshot [--annotate] [--target main|pet]',
    summary: '截取当前界面，返回 JPEG 与可交互元素 refs',
    layer: 'ui',
    route: { method: 'POST', path: '/screenshot' },
    options: [
      { flag: '--annotate', desc: '在截图上标注元素编号（SoM）' },
      { flag: '--target <t>', desc: 'main（默认）| pet' },
    ],
    // 把 argv 映射成请求体；返回 null 表示参数不合法
    build: (args) => ({ annotate: args.annotate === true, target: args.target }),
  },
  // … goto / click / command / settings / cron / model / tools / skill / pet
]
```

**派生出的三种输出：**

| 入口 | 用途 | 形态 |
|------|------|------|
| `lumii-ui help` / `lumii-ui`（无参数）/ `--help` | 人读总览 | 按 `group` 分组的命令表 |
| `lumii-ui help <command>` | 人读单条详情 | usage + options + 示例 |
| `lumii-ui help --json` | **Agent 能力发现** | 注册表的 JSON 序列化（去掉 `build` 函数） |

`help --json` 是关键设计：Agent 不必把全部命令写进 system prompt，只需要知道「跑 `lumii-ui help --json` 能拿到完整命令清单」。这样 CLI 扩命令时**无需同步改工具 description**。

**总览输出示意：**

```
lumii-ui — Lumii 客户端控制 CLI

用法: lumii-ui <command> [options]

看
  screenshot [--annotate] [--target main|pet]   截取当前界面，返回 JPEG 与 refs

动
  goto --view <v> [--category <c>]              打开指定页面
  click --ref <r> [--snapshot-id <id>]          点击 ref 对应控件

设置
  settings get [<key.path>]                     读取设置（省略则返回全部）
  settings set <key.path> <value>               写入设置并立即生效

定时任务
  cron list                                     列出定时任务
  cron run <id>                                 立即执行一次

技能
  skill list                                    列出已安装技能
  skill enable|disable <id>                     启用/禁用技能

模型与工具
  model set <modelId> --session <key>           设置会话首选模型
  tools list                                    列出工具
  tools toggle <name> on|off                    启用/禁用工具

桌宠
  pet modes                                     列出桌宠模型
  pet mode <modeName>                           切换桌宠模式

底层
  command <type> [--data <json>]                直接投递命令总线（受白名单约束）

help [<command>] [--json]                       查看帮助；--json 输出机器可读清单

退出码: 0 成功 | 2 参数错误 | 3 应用未运行 | 4 认证失败 | 5 被拒绝(not_exposed/disabled)
```

**退出码约定**（Task 10 只定义了 `exit 3`，此处补全，便于 Agent 与脚本判断）：

| 码 | 含义 |
|----|------|
| 0 | 成功 |
| 2 | 参数错误（未知命令、缺必填参数） |
| 3 | 应用未运行（token 文件缺失或连接失败） |
| 4 | 认证失败（401） |
| 5 | 被拒绝（`not_exposed` / `disabled` / `field_protected`） |
| 1 | 其它错误 |

**与工具 description 的关系**：`app_act` 等工具的 description 只写一句「客户端设置与控制走 `lumii-ui`，跑 `lumii-ui help` 查看可用命令」，不再罗列命令清单，避免两处漂移。

---

### 14.4 来源标识与权限护栏

#### 14.4.1 bash 绕过风险

in-client Agent 可通过 `bash lumii-ui …` 调用控制口，从而绕过 6 步权限管线（`permission-checker.ts`），因为：
- `bash-tool.ts` 对命令字符串内容**无任何检查**（直接 spawn）
- `ToolParamConstraint`（`param-permission-parser.ts`）可配置前缀黑名单，但需用户手动配置，非默认生效
- `SkillRunner.execute` 同样无 `SkillPermissions` 强制执行（`skill-runtime.ts:121-135` 定义但未校验）

#### 14.4.2 唯一有效防线：服务端白名单

不依赖「禁止 Agent 调用 bash」——该假设不可靠，Skill 同样无约束（`SkillPermissions` 在 `skill-runtime.ts:121-135` 有定义但 `ShellRunner.execute` 从不校验）。

也**不依赖 origin 机制**：如 §14.1 所述，命令类型无 origin 字段，且 `getForOrigin` 只在 prompt 路径生效，对 `/command` 无作用。加 `external_cli` 只会产生假护栏。

真实防线只有控制口自身的四层：

1. **白名单**（主防线）：`/command` 在调用 `handleCommand` 前检查 `COMMAND_ALLOWLIST`，白名单外一律 `not_exposed`。新命令默认拒绝
2. **C 层字段保护**：`privacy.allowAgentAppUiControl` 等字段不可写，防止自举开启总开关
3. **loopback 绑定**：只监听 `127.0.0.1`，拒绝非 loopback bind（参照 `extension-relay.ts:166` 的 `isLoopbackHost`）
4. **token**：`~/.lumii/runtime/app-ui.json` 内 `randomUUID()`，请求需带 `Authorization: Bearer`

**关于文件权限的诚实说明**：token 文件在 Windows/NTFS 上**无法用 `fs.chmod(0o600)` 有效保护**（Node 在 Windows 上只映射只读位，不实现 POSIX mode）。同机同用户的任何进程都能读取该文件。因此 token 的作用是**防止跨用户与网络访问**，不能防御同用户下的本地进程——而 Agent 本身就跑在同用户下。这进一步说明：**白名单是唯一实质边界，token 不是**。

若需要更强隔离，可选方案（三期不做，记录备选）：把 token 只放进内存并通过环境变量传给 shim，不落盘。

#### 14.4.3 配额与总开关对 CLI 的适配

- **配额**：MVP 的 per-turn 配额（`bridge-app-ui-tools.ts` 的 `turnQuotas`）挂在 `agent:turn:end` 重置。CLI 调用**没有 turn 概念**，该计数器对控制口不适用。三期为控制口单独设置**滑动窗口速率限制**（如 60 秒内 100 次请求），与 per-turn 配额相互独立
- **总开关**：`isAppUiControlEnabled()` 同样约束控制口全部路由。开关关闭时 `/command`、`/settings/*`、`/ipc/*` 一并返回 `{ ok: false, error: 'disabled' }`，且该状态**不可通过 CLI 自行解除**（见 §14.2.3 字段保护）

---

### 14.5 三期文件清单（对 Task 10 的增量）

| 文件 | 变更类型 | 内容 |
|------|---------|------|
| `apps/windows/src/main/ipc/agent-runtime-ipc.ts` | Modify | **导出 `handleCommand`；新增 `getAgentRuntimeBridge()` accessor**（§14.2.0，三期地基） |
| `apps/windows/src/main/index.ts` | Modify | 新增 `getSkillRuntime()` / `getSkillWatcher()` accessor，供 B 层 skills 路由使用 |
| `apps/windows/src/main/app-ui-control/command-allowlist.ts` | Create | `COMMAND_ALLOWLIST` 常量 + 拒绝理由注释（§14.2.1） |
| `apps/windows/src/main/app-ui-control/settings-channel.ts` | Create | 注入脚本内 merge 的读写实现 + 受保护字段黑名单（§14.2.3） |
| `apps/windows/src/main/app-ui-control/settings-channel.test.ts` | Create | 深 merge、受保护字段拒绝、脚本转义测试 |
| `apps/windows/src/main/app-ui-control/server.ts` | Modify | 追加 `/command`（白名单 + 串行队列）、`/settings/read`、`/settings/write`、`/ipc/skills/*`、`/ipc/pet/*`；速率限制 |
| `apps/windows/src/main/app-ui-control/server.test.ts` | Modify | 补白名单过滤、串行化、速率限制、B 层路由测试 |
| `apps/windows/resources/app-ui-cli/commands.mjs` | Create | 声明式命令注册表 `COMMANDS`（§14.3.1），driving 分发 + help + `help --json` |
| `apps/windows/resources/app-ui-cli/lumii-ui.mjs` | Modify | 改为按注册表分发；实现 `help` / `help <cmd>` / `help --json`；统一退出码（零依赖，纯 fetch） |

**不做**（原 v0.6 草案曾列入，核查后否决）：`AgentTurnOrigin` 加 `external_cli`、`CapabilityRegistry` 改动。理由见 §14.1 与 §14.4.2。

**三期不新建 dispatch 逻辑**——`handleCommand` 已存在，只需导出。
