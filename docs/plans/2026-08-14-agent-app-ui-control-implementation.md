# Agent 操作客户端自身 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 Lumii Agent 能看见并操作本客户端界面：先交付 MVP 闭环（主窗截图 + 声明式导航 + 按 ref 点击），完整能力按设计分期补齐。

**Architecture:** 主进程 `app-ui-control` 唯一引擎；MVP 只注册进程内工具 `app_screenshot` / `app_goto` / `app_act(click)`。导航复用渲染已有 `handleViewChange` / `openHub`，回读走 `executeJavaScript` 读 `window.__LUMII_APP_UI_STATE__`（不新增 IPC 通道）。二期再给同一引擎套本机控制口与 `lumii-ui` CLI。

**Tech Stack:** Electron `capturePage` + `sendInputEvent` + `executeJavaScript`、TypeBox 工具、现有 IPC 事件前转、Vitest、JPEG `resizeImageIfNeeded`

**规格：** `docs/design/2026-08-13-agent-app-ui-control-design.md`（v0.4，代码核查后修正版）

**范围锁：** 下列任务 1–9 是 MVP，**拆成两部分独立可交付**：Part A（任务 1–4）只做「看」，Part B（任务 5–9）在 A 之上做「动」。任务 10+ 是完整规划，未完成 MVP 前不要做。

**为何拆两部分**：v0.4 核查发现 goto 的回读机制、pet 窗口隔离、配额计数器都是新代码而非复用，风险集中在「动」这一半。把「看」单独跑通（截图闭环已经是可演示、可验收的功能），再叠「动」，任何一部分卡住不影响另一部分先交付。

---

## Part A：看（截图闭环，任务 1–4）

### Task 1: 引擎类型与快照纯函数

**Files:**
- Create: `apps/windows/src/main/app-ui-control/types.ts`
- Create: `apps/windows/src/main/app-ui-control/snapshot.ts`
- Create: `apps/windows/src/main/app-ui-control/snapshot.test.ts`
- Create: `apps/windows/src/main/app-ui-control/index.ts`

**Step 1: 写失败测试**

覆盖：过滤 hidden/零尺寸/`data-app-ui-ignore`；保留 `data-app-ui` 与 button；上限 80 且 `truncated`；生成递增 `snapshotId` 的纯函数可测部分（节点过滤不依赖 DOM 的话，把「原始节点描述 → 过滤结果」抽成纯函数）。

**Step 2: 跑测试确认失败**

```bash
npx vitest run apps/windows/src/main/app-ui-control/snapshot.test.ts
```

**Step 3: 最小实现**

- `AppUiRef` / `AppUiViewState` 类型（goto/act 的输入类型放到 Part B 的 Task 5，这里只定义「看」需要的）
- 注入脚本字符串 `SNAPSHOT_SCRIPT`（在页面里跑，返回原始节点）
- `filterSnapshotNodes(raw, { limit: 80 })`
- 每个函数写中文函数级注释

**Step 4: 测试通过后提交**

```bash
git add apps/windows/src/main/app-ui-control
git commit -m "feat(app-ui): 快照过滤与类型，供 Agent 看界面"
```

---

### Task 2: 截图控制器（mock BrowserWindow，仅 screenshot）

**Files:**
- Create: `apps/windows/src/main/app-ui-control/controller.ts`
- Create: `apps/windows/src/main/app-ui-control/controller.test.ts`
- Create: `apps/windows/src/main/app-ui-control/screenshot-cleanup.ts`

**内容：**

- `createAppUiController(deps)`：`getMainWindow`、`resizeImageIfNeeded`
- `screenshot()`：
  1. 无主窗或已销毁 → 返回 `{ ok: false, error: 'app_not_running' }`
  2. `mainWindow.webContents.capturePage()` → JPEG（长边 ≤1280，复用 `resizeImageIfNeeded`）→ base64
  3. `executeJavaScript(SNAPSHOT_SCRIPT)` 拿原始节点 → `filterSnapshotNodes` → `refs`
  4. 递增内存计数器生成 `snapshotId`，缓存 `{ snapshotId, refs, viewState, bounds }`（点击校验用，Part B 消费）
  5. 图片**只落一份临时文件**用于 `ToolCallCard` 缩略图预览，路径 `~/.lumii/temp/screenshots/{snapshotId}.jpg`；工具返回值内联 base64，不返回文件路径给模型
- `screenshot-cleanup.ts`：应用启动时清空 `~/.lumii/temp/screenshots/` 整个目录（ponytail: 目录级清空，比按时间戳判断简单，没有其它进程会写这个目录）
- 测试用 fake `webContents`（`capturePage` 返回假 `NativeImage`，`executeJavaScript` 返回固定节点数组）

**验证要点（设计 §12 风险）**：截图前检查 `win.isVisible()`；若窗口隐藏到托盘，`capturePage` 在部分 Electron 版本返回空白图，需要手工验证一次隐藏状态下的真实截图结果，不能只靠 mock 测试通过就算完成。

提交：`feat(app-ui): 主窗截图控制器 + 临时文件清理`

---

### Task 3: 注册 `app_screenshot` 工具

**Files:**
- Create: `apps/windows/src/main/agent-runtime/bridge-app-ui-tools.ts`
- Modify: `apps/windows/src/main/agent-runtime/bridge-tool-registrar.ts` — `registerAll()` 注册
- Modify: 工具 description 写清楚「只截图，不操作」
- Test: `bridge-app-ui-tools.test.ts`（mock controller）

**MVP 参数：**

```ts
{ annotate?: boolean }  // 忽略或默认 false，先不接
```

`content` 必须含 text JSON（`{ ok, snapshotId, view, hub, width, height, refs, truncated }`）+ `{ type: 'image', data: base64, mimeType: 'image/jpeg' }`。

`isReadOnly: true`，`needsPermission: false`（参考 `browser_screenshot`，`bridge-browser-tools.ts:62-68`）。

提交：`feat(app-ui): 注册 app_screenshot`

---

### Task 4: 时间线缩略图 + Part A 验收

**Files:**
- Modify: `apps/windows/src/renderer/pages/ChatPage/components/ToolCallCard/toolTaxonomy.ts`
- Modify: `apps/windows/src/renderer/pages/ChatPage/components/ToolCallCard/index.tsx`
  将 `image_generate` 预览分支（`ImageGeneratePreview`，`index.tsx:463-494`）扩展到 `app_screenshot`：走同样的 `files:read-preview-by-path` 读取模式，`filePath` 指向 `~/.lumii/temp/screenshots/{snapshotId}.jpg`

**跑：**

```bash
pnpm --filter @mtbot/windows typecheck
npx vitest run apps/windows/src/main/app-ui-control apps/windows/src/main/agent-runtime/bridge-app-ui-tools.test.ts
```

**手工验收（Part A 范围，对应设计 §7.2 第 1 条）：**

1. 「截一张当前界面」→ 时间线出现缩略图，模型能描述侧栏/主区
2. 隐藏窗口到托盘后再截图，确认不是空白图（Task 2 遗留验证点）

两条都过，Part A 完成，可独立交付演示。**不要开始 Part B 之前先确认这两条真的手工跑过。**

---

## Part B：动（导航 + 点击，任务 5–9）

Part B 建立在 Part A 的 `controller.ts` 之上，新增 goto/click 能力。核心风险是 v0.4 修正过的两点：goto 回读走 `executeJavaScript` 而不是新 IPC handle；`app-ui:goto` 精确发给主窗口，不走会自动镜像到 pet 窗口的 `forwardIpcEvent`。

### Task 5: goto 校验与 click 策略纯函数

**Files:**
- Create: `apps/windows/src/main/app-ui-control/goto.ts`
- Create: `apps/windows/src/main/app-ui-control/goto.test.ts`
- Create: `apps/windows/src/main/app-ui-control/act.ts`
- Create: `apps/windows/src/main/app-ui-control/act.test.ts`
- Create: `apps/windows/src/main/app-ui-control/coords.ts`
- Create: `apps/windows/src/main/app-ui-control/coords.test.ts`
- Modify: `apps/windows/src/main/app-ui-control/types.ts` — 补 `GotoInput` / `ActInput`

**内容：**

- `parseGotoInput`：合法 `ViewType`（对齐 `Router.tsx:18-27`）+ 可选 `MergedSettingsCategory`（对齐 `SettingsHub/types.ts:20-30`）；非法返回 `usage`
- `assertClickAllowed({ ref, snapshotId, current, blockRoles })`：缺 ref / `stale_snapshot` / `blocked_composer` → 对应 error 码
- `devicePixelsToDip`：为 click 坐标换算打底

跑：`npx vitest run apps/windows/src/main/app-ui-control`

提交：`feat(app-ui): goto/click 参数与过期校验`

---

### Task 6: 控制器扩展 goto/click + 渲染回读通道

**Files:**
- Modify: `apps/windows/src/main/app-ui-control/controller.ts` — 加 `goto()` / `click()`
- Modify: `apps/windows/src/main/app-ui-control/controller.test.ts`
- Modify: `apps/windows/src/renderer/App.tsx` — 监听 `app-ui:goto`，调用已有 `handleViewChange` / `openHub(tab, category)`；挂 `window.__LUMII_APP_UI_STATE__ = () => JSON.stringify({ view, hub })`
- Modify: `apps/windows/src/renderer/components/layout/Sidebar/Sidebar.tsx` — 设置按钮 `data-app-ui="nav-settings"`
- Modify: `SettingsHubModal.tsx` — Tab 按钮行 `data-app-ui="hub-tab"`
- Modify: 设置左侧分类导航项 `data-app-ui="hub-category"`
- Modify: `ChatInput` 根元素 `data-app-ui-block="composer"`

**goto 行为（设计 §7.8）：**

```
controller.goto(input):
  mainWindow.webContents.send('app-ui:goto', input)   // 精确发主窗，不走 forwardIpcEvent（避免镜像到 pet）
  await sleep(100)                                     // 等 React setState 落定
  const json = await mainWindow.webContents.executeJavaScript('window.__LUMII_APP_UI_STATE__?.()')
  return json ? JSON.parse(json) : { view: null, hub: null }
```

不新增 preload 方法、不新增 `ipcMain.handle` 通道——`executeJavaScript` 已有先例（`index.ts:1105` 读 localStorage），比三处同步的 IPC 更小。

**click 行为：**

- 校验（Task 5 的 `assertClickAllowed`）
- `executeJavaScript` 用 `snapshotId` 对应的 ref 坐标做 `scrollIntoView` + 重新测 rect
- `sendInputEvent` mousedown → mouseup（DIP 坐标，走 `coords.ts`）

跑：`npx vitest run apps/windows/src/main/app-ui-control`

提交：`feat(app-ui): 声明式导航 + 按 ref 点击（回读走 executeJavaScript）`

---

### Task 7: 注册 `app_goto` / `app_act` 工具

**Files:**
- Modify: `apps/windows/src/main/agent-runtime/bridge-app-ui-tools.ts` — 加两个工具
- Modify: 工具 description 使用设计 §13.2 分工原文（含"始终允许仅本次运行有效"提示）
- Modify: `permission-types.ts` 或等价名单 — `app_act` 可被「始终允许」记住（进程内，参考 `permission-checker.ts:106-121` 的 `allowIfRemembered`）
- Modify: `bridge-app-ui-tools.test.ts` — 补两个工具的测试

**MVP 参数：**

- `app_goto`：`view` + 可选 `category`；`isReadOnly: false`，`needsPermission: false`
- `app_act`：只接受 `action=click` + `ref` + 可选 `snapshotId`；其它 action 返回 `usage`（为二期留口）；`isReadOnly: false`，`needsPermission: true`

提交：`feat(app-ui): 注册 app_goto/app_act`

---

### Task 8: 总开关与配额

**Files:**
- Modify: 设置「通用」或隐私区加「允许 Agent 操作本软件界面」，默认 true
- `isEnabled()` 读该开关，三工具共用
- `bridge-app-ui-tools.ts` 内挂 per-turn 计数器闭包：`screenshot 8 / act 20 / goto 20`，监听 `agent:turn:end` 重置（参考 `bridge-agent-instance-events.ts` 的事件转发,不新建独立状态文件）

提交：`feat(app-ui): 操作本软件总开关与配额`

---

### Task 9: MVP 整体验收（Part A + B）

**跑：**

```bash
pnpm --filter @mtbot/windows typecheck
npx vitest run apps/windows/src/main/app-ui-control apps/windows/src/main/agent-runtime/bridge-app-ui-tools.test.ts
```

**手工（设计 §7.2 全部六条）：**

1. 「截一张当前界面」→ 时间线缩略图（Part A 已验收，此处回归）
2. 「打开设置 → 语音」→ Hub 打开、分类 voice；`app_goto` 返回的 `hub` 与实际一致；再截图确认
3. 「打开技能页」→ Hub tab=skills；截图能看到技能列表
4. 按 ref 点一个非 composer 控件 → 界面有可见变化，再截图确认
5. 点自己的输入框/发送 → `blocked_composer`，会话不被污染
6. 无视觉模型：只凭 refs / goto 返回值仍能打开设置

全部通过才算 MVP 完成。不要开始 Task 10。

---

## 完整规划（MVP 之后）

### Task 10: 本机控制口 + `lumii-ui` CLI（二期）

- `server.ts` 绑 `127.0.0.1` 随机端口，写 `~/.lumii/runtime/app-ui.json`  
- `apps/windows/scripts/lumii-ui.mjs` 零依赖；**打包必须带运行时，禁止假设系统有 node**（用 `Lumii.exe` 子命令或 extraFiles node）  
- 命令：`screenshot` / `goto` / `click`，stdout JSON，exit 码见设计 §8.2  
- 应用未开 exit 3，不自动启动  

### Task 11: 完整 `app_act`（二期）

- type：React native value setter + `insertText`  
- key 白名单、scroll、坐标 click、右键/双击  
- 单测中文受控输入  

### Task 12: SoM 与多窗（二期）

- `annotate=true` 在截图副本上画编号  
- `target=pet|preview` 仅截图（pet 截图与 goto 隔离处理方式相同：直接指定窗口，不走广播通道）
- `app_ui_state` 只读工具  

### Task 13: 声明式能力补齐（三期）

按设计 §4.4 逐个加，优先：

1. `skill_set_enabled`  
2. `settings_chat_model`  
3. `cron_run_now`  
4. `pet_mode_set`  

每加一个，工具描述里写「不要用 click 做这件事」。

### Task 14: 桌宠点击（三期）

画布 DIP 坐标；不做 DOM ref。

---

## 执行方式

Part A（Task 1→4）先跑通并手工验收，可独立演示「看」的闭环。  
Part B（Task 5→9）在 Part A 基础上叠「动」，全部完成才算 MVP。  
用 executing-plans **按 Task 1→9 顺序**，每任务测试过再进下一个。  
Task 10+ 等产品确认「要 CLI / 要输入」后再开。
