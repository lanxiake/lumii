# Agent 操作客户端自身 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 Lumii Agent 能看见并操作本客户端界面：先交付 MVP 闭环（主窗截图 + 声明式导航 + 按 ref 点击），完整能力按设计分期补齐。

**Architecture:** 主进程 `app-ui-control` 唯一引擎；MVP 只注册进程内工具 `app_screenshot` / `app_goto` / `app_act(click)`。导航复用渲染已有 `handleViewChange` / `openHub`，回读走 `executeJavaScript` 读 `window.__LUMII_APP_UI_STATE__`（不新增 IPC 通道）。二期再给同一引擎套本机控制口与 `lumii-ui` CLI。

**Tech Stack:** Electron `capturePage` + `sendInputEvent` + `executeJavaScript`、TypeBox 工具、现有 IPC 事件前转、Vitest、JPEG `resizeImageIfNeeded`

**规格：** `docs/design/2026-08-13-agent-app-ui-control-design.md`（v0.5，MVP 验收通过 + 二期代码核查修正版）

**范围锁：** 任务 1–9 是 MVP，已完成实现与验收（`feat/agent-app-ui-control` 分支）。任务 10–12 是二期（Part C），任务 13–14 是三期（Part D），按下方 Part C/D 详细步骤执行。

**为何拆两部分（MVP 内部）**：v0.4 核查发现 goto 的回读机制、pet 窗口隔离、配额计数器都是新代码而非复用，风险集中在「动」这一半。把「看」单独跑通（截图闭环已经是可演示、可验收的功能），再叠「动」，任何一部分卡住不影响另一部分先交付。

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

## Part C：二期（Task 10–12，对外 CLI + 完整交互 + 多窗）

> MVP（Task 1–9）已实现验收通过，见 `feat/agent-app-ui-control` 分支。以下按设计 v0.5 §8 的代码事实核查（`runtime-env.ts` 的 `resolveNodeExec()`、`browser-control` 的端口探测、`pet-window-manager.ts` 的窗口获取）拆到可执行粒度。三份任务相对独立，可并行但建议先做 Task 11（完整 `app_act`），因为 Task 10 的 CLI 命令要复用它。

### Task 10: 本机控制口 + `lumii-ui` CLI

**Files:**
- Create: `apps/windows/src/main/app-ui-control/server.ts`
- Create: `apps/windows/src/main/app-ui-control/server.test.ts`
- Create: `apps/windows/resources/app-ui-cli/lumii-ui.mjs`
- Modify: `apps/windows/src/main/runtime-env.ts` — 复用现有 `writeShimPair()`（84-118 行）为 `lumii-ui` 生成一对 shim，target 用 `resolveNodeExec()` 的 command/env 去 exec `lumii-ui.mjs`
- Modify: `apps/windows/electron-builder.json` — `extraResources` 加一条 `resources/app-ui-cli` → `app-ui-cli`（不改 asar/asarUnpack 结构）
- Modify: `apps/windows/src/main/index.ts` 或 app 启动流程 — 应用启动时调用 `server.ts` 的 start，随主进程生命周期关闭

**内容：**

1. `server.ts`：
   - 端口探测直接照抄 `packages/browser-control/src/browser/control-service.ts:144` 的 `findAvailablePort(startPort, label)` 模式（`+10` 步长、重试 3 次、都占用则落到 `startPort + 3*10`），不要重新发明随机端口逻辑；起始端口另分配（避开 `DEFAULT_CDP_PORT` 和 extension relay 端口，三个常量放一起方便比对）
   - `createServer` 只监听 `127.0.0.1`（参照 `extension-relay.ts:166` 的 `isLoopbackHost` 校验思路，拒绝非 loopback bind）
   - token：`randomUUID()`（`node:crypto`，先例 `voice-temp-ref.ts:7,24`），启动时生成，写入 `path.join(resolveWindowsClientDataRoot(), 'runtime', 'app-ui.json')`（用已有的 `resolveWindowsClientDataRoot()`，不要硬编码 `~/.lumii`）
   - 路由：`POST /screenshot`、`POST /goto`、`POST /click` 直接调 `createAppUiController()` 现有的 `screenshot()/goto()/click()`（Task 1-9 已实现，不要重复写业务逻辑），校验 `Authorization: Bearer <token>` 不通过 401
   - 应用关闭时 `server.close()`

2. `lumii-ui.mjs`（零依赖 ESM，纯 `fetch` 调本机 HTTP）：
   - 读 `~/.lumii/runtime/app-ui.json` 拿 port/token；文件不存在或连不上 → `exit 3`（应用未运行，不自动拉起）
   - 命令：`screenshot [--annotate]` / `goto --view <v> [--category <c>]` / `click --ref <r> [--snapshot-id <id>]`
   - stdout 输出工具返回的 JSON 原样；HTTP 层错误单独包一层 `{ ok: false, error: 'connection_failed' }`

3. shim：在 `writeShims()`（`runtime-env.ts:126`）里补一段，用 `writeShimPair(dir, 'lumii-ui', target, [scriptPath], envFromResolveNodeExec)` 写 `lumii-ui` + `lumii-ui.cmd`，`target`/`env` 来自 `resolveNodeExec()`（68-72 行，已存在，不要重新判断系统 node）

**测试：**

```bash
npx vitest run apps/windows/src/main/app-ui-control/server.test.ts
```
mock `createAppUiController`，只测路由/token 校验/端口探测重试逻辑，不测真实 HTTP。

**手工验收：**
1. 应用运行中，终端跑 `lumii-ui screenshot` → 收到 JSON + 能确认截图文件生成
2. 关闭应用后跑 `lumii-ui goto --view chat` → `exit 3`
3. 改错 token 文件内容后跑 → 401

提交：`feat(app-ui): 本机控制口 + lumii-ui CLI`

---

### Task 11: 完整 `app_act`（type / key / scroll）

**Files:**
- Modify: `apps/windows/src/main/app-ui-control/act.ts` — 加 `buildTypeScript` / `buildScrollScript`，key 白名单常量
- Modify: `apps/windows/src/main/app-ui-control/act.test.ts`
- Modify: `apps/windows/src/main/app-ui-control/controller.ts` — `click()` 旁加 `type()` / `key()` / `scroll()`，复用现有 `assertClickAllowed` 的 ref/snapshot 校验逻辑（校验部分不区分 action）
- Modify: `apps/windows/src/main/agent-runtime/bridge-app-ui-tools.ts` — `app_act` 的 `action` 枚举从只接受 `click` 扩展为 `click | type | key | scroll`

**内容（设计 §8.1）：**

- `type`：注入脚本用 native value setter，不能用 `el.value = text` 直接赋值（React 受控组件检测不到）：
  ```js
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, text)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  ```
  参数 `{ action: 'type', ref, text, clear?: boolean }`；`clear=true` 先设空字符串再设新值。禁止用 `sendInputEvent` 敲 keyCode 模拟中文输入（拼音会被打成乱码）。
- `key`：白名单 `Enter | Escape | Tab | Backspace | Delete | ArrowUp/Down/Left/Right`，非白名单返回 `{ ok: false, error: 'usage' }`；用 `sendInputEvent({ type: 'keyDown' })` + `keyUp`
- `scroll`：复用 `buildClickPrepareScript`（`act.ts:62`）里 `elementFromPoint` 定位元素的逻辑，改造成新函数返回元素后跑 `el.scrollBy(dx, dy)`；参数 `{ action: 'scroll', ref, dx?: number, dy?: number }`
- 全部复用现有 `assertClickAllowed` 做 ref/snapshotId/composer 校验（这部分与 action 类型无关，不要重复写）

**测试重点：** 中文字符串（含多字节 emoji）通过 native setter 写入后 `input` 元素的值和 React state 是否同步——需要一个真实渲染的测试页面或 mock `dispatchEvent` 校验调用参数，不能只测字符串本身。

跑：
```bash
npx vitest run apps/windows/src/main/app-ui-control
```

提交：`feat(app-ui): app_act 补 type/key/scroll`

---

### Task 12: SoM 编号图 + pet/preview 截图

**Files:**
- Modify: `apps/windows/src/main/app-ui-control/controller.ts` — `AppUiControllerDeps.getMainWindow` 扩展成 `getWindow(target: 'main' | 'pet' | 'preview')`；`screenshot()` 加 `annotate` 参数
- Modify: `apps/windows/src/main/app-ui-control/annotate.ts`（新建）— 在 JPEG 上画编号，纯函数：输入 refs + 图片 buffer，输出画好编号的新 buffer
- Modify: `apps/windows/src/main/app-ui-control/annotate.test.ts`
- Modify: `apps/windows/src/main/agent-runtime/bridge-app-ui-tools.ts` — `app_screenshot` 参数加 `target?: 'main' | 'pet' | 'preview'`（默认 `main`），`annotate` 从「忽略」改为真正接入

**内容：**

- pet/preview 窗口获取：**不能**用 `getMainWindow()`。要经 `apps/windows/src/main/pet/pet-mode-ipc.ts` 的 `getPetWindowManager()`，再调 `PetWindowManager.getPetBrowserWindow()`（`pet-window-manager.ts:115-117`，内部已处理 `isDestroyed()`）。`target=pet` 但 pet 窗口未开 → 返回 `{ ok: false, error: 'pet_not_running' }`（新错误码，与 `app_not_running` 区分）
- `target=preview` 二期先占位返回 `usage`（预览窗当前代码里没有独立可截图的窗口概念，需要先确认是哪个窗口，不在本任务内臆造）
- SoM：`annotate=true` 时截图流程末尾调 `annotate.ts` 的函数，在每个 ref 的 `(x, y, w, h)` 左上角画半透明编号（数字文本 + 背景色块），复用截图已有的 JPEG buffer，不额外截一次图
- pet 截图同样不走 `forwardIpcEvent` 广播，直接拿到窗口后 `capturePage`，与 goto 的隔离思路一致（Task 6 已定的模式）

**测试：** `annotate.ts` 纯函数用固定 refs + 假 buffer 测试编号位置计算是否正确（不需要真的验证图片像素，验证传给绘图库的坐标参数）；`controller.test.ts` mock `getPetWindowManager` 返回 null/mock window 两种场景。

跑：
```bash
npx vitest run apps/windows/src/main/app-ui-control
```

提交：`feat(app-ui): SoM 编号图 + pet/preview 截图`

---

## Part D：三期（Task 13–14，声明式补齐 + 桌宠点击）

以下两项依赖产品对「哪些声明式 API 优先」「桌宠点击是否真的需要」的确认，暂不细化到 Files/Step 粒度，先给方向：

### Task 13: 声明式能力补齐

按设计 §4.4 逐个加，优先：

1. `skill_set_enabled`
2. `settings_chat_model`
3. `cron_run_now`
4. `pet_mode_set`

每加一个，工具描述里写「不要用 click 做这件事」，且要在 `app_act` 的 description 里同步提示，避免模型绕开声明式 API 硬点。

### Task 14: 桌宠点击

画布 DIP 坐标；不做 DOM ref（pixi.js canvas 没有 DOM 树）。点击目标需要桌宠侧提供命中测试 API（当前 `pet-core` 是否已有类似接口需先确认，可能是本任务里最大的未知项）。

---

## 执行方式

Part A（Task 1→4）先跑通并手工验收，可独立演示「看」的闭环。  
Part B（Task 5→9）在 Part A 基础上叠「动」，全部完成才算 MVP——**已完成**。  
Part C（Task 10→12）是二期，三个任务相对独立，建议先做 Task 11（后续 CLI 复用它），用 executing-plans 逐任务跑测试。  
Part D（Task 13→14）等产品确认优先级后再排期，不要在没有明确需求信号时开工。
