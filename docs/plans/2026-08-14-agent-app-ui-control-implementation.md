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

## Part D：三期（Task 13–17，CLI 统一控制面）

> **规格：** 设计 v0.7 §14（`docs/design/2026-08-13-agent-app-ui-control-design.md`）。  
> **前提：** Part C（Task 10–12）全部验收通过，`server.ts` 控制口已运行，`lumii-ui.mjs` 含 screenshot/goto/click 三条命令。  
> **核心认知：** 原三期计划的 4 个声明式 API 全部已存在，任务本质是「暴露」而非「创建」。但 v0.6 草案有 9 处不闭环，v0.7 已修正，本 Part 按 v0.7 执行。

**v0.6 → v0.7 的关键否决项（不要照旧计划做）：**

| 原计划 | 否决原因 |
|--------|---------|
| 给 `AgentTurnOrigin` 加 `external_cli` | 92 个命令类型**无 origin 字段**，origin 是对话轮次维度 |
| 给 `CapabilityRegistry.isAllowedForOrigin` 加分支 | `getForOrigin` 只在 `agent-instance.ts:555` 的 prompt 路径生效，对 `/command` **运行时空转**，是假护栏 |
| `/command` 用黑名单 | 默认开放 76 条，含 `mcp:writeConfigFile`（等价 RCE）、`files:*`、`storage:exportJsonl`，必须改白名单 |

---

### Task 13: 导出调用地基（三期前置）

**背景：** `handleCommand`（`agent-runtime-ipc.ts:560`）与 `ipcBridgeRef`（305 行）都是模块私有；该文件只导出 `LOCAL_USER_ID:299` 和 `registerAgentRuntimeIPC:536`。`server.ts` 目前**无法调用命令总线**。同理 `skillRuntime`（`index.ts:241`）也是私有，B 层 skills 路由无从下手。这一步不做，Task 14/15 直接卡死。

**Files:**
- Modify: `apps/windows/src/main/ipc/agent-runtime-ipc.ts` — `handleCommand` 加 `export`；新增 `getAgentRuntimeBridge()` accessor
- Modify: `apps/windows/src/main/index.ts` — 新增 `getSkillRuntime()` / `getSkillWatcher()` accessor

**Step 1: 实现**

```ts
// agent-runtime-ipc.ts
export async function handleCommand(          // 原为 async function（560 行）
  bridge: AgentRuntimeBridge,
  command: AgentRuntimeCommand,
): Promise<unknown> { /* 原实现不动 */ }

/** 供控制口读取 bridge；ipcBridgeRef 保持私有，不允许外部改写 */
export function getAgentRuntimeBridge(): AgentRuntimeBridge | null {
  return ipcBridgeRef
}
```

```ts
// index.ts
export function getSkillRuntime(): ClientSkillRuntime | null { return skillRuntime }
export function getSkillWatcher(): SkillWatcher | null { return skillWatcher }
```

**Step 2: 验证不破坏现有构建**

`handleCommand` 内部是大 switch，改 export 不影响穷尽性检查，但仍需全量确认：

```bash
pnpm --filter @mtbot/windows typecheck
npx vitest run apps/windows/src/main
```

**注意：** `index.ts` 是 3000+ 行巨型入口，新增 export 前确认 accessor 定义位置在 `skillRuntime` 声明之后，避免 TDZ。

提交：`refactor(app-ui): 导出 handleCommand 与 bridge/skillRuntime accessor`

---

### Task 14: 命令白名单 + `/command` 路由（A 层）

**Files:**
- Create: `apps/windows/src/main/app-ui-control/command-allowlist.ts`
- Create: `apps/windows/src/main/app-ui-control/command-allowlist.test.ts`
- Modify: `apps/windows/src/main/app-ui-control/server.ts` — 追加 `POST /command`
- Modify: `apps/windows/src/main/app-ui-control/server.test.ts`

**Step 1: 写失败测试**

`command-allowlist.test.ts` 覆盖：
- 白名单内命令（`cron:list`、`tools:toggle`）→ 允许
- 高危命令（`mcp:writeConfigFile`、`user:send`、`storage:exportJsonl`、`files:delete`、`user:permissionRespond`）→ 拒绝
- 未知命令类型 → 拒绝（默认拒绝语义）
- 白名单是 `ReadonlySet<string>`，不可运行时增删

`server.test.ts` 覆盖：
- 白名单外命令返回 `{ ok: false, error: 'not_exposed' }`，且**不调用** mock 的 `handleCommand`
- 白名单内命令透传 `handleCommand` 的返回值
- 并发两个请求时 `handleCommand` 调用**串行**（第二次开始时第一次已 resolve）

```bash
npx vitest run apps/windows/src/main/app-ui-control
```

**Step 2: 最小实现**

`command-allowlist.ts` 按设计 §14.2.1 的分组表写，每组带中文注释说明放开理由；**拒绝项写进注释而非代码**，避免维护两份清单：

```ts
/**
 * 控制口可转发的命令白名单（默认拒绝语义）
 *
 * 拒绝的高危项及理由见设计 §14.2.1，其中特别注意：
 * - mcp:writeConfigFile：content 为任意字符串，可注入 stdio server 命令，等价 RCE
 * - files:*：文件系统读写与枚举，与 B 层「不暴露文件操作」保持一致
 * - user:permissionRespond：可自动批准权限弹窗，直接击穿权限管线
 * - storage:exportJsonl：可导出全部会话内容
 *
 * 新增命令默认落入拒绝，扩白名单必须走评审。
 */
export const COMMAND_ALLOWLIST: ReadonlySet<string> = new Set([
  // 定时任务
  'cron:list', 'cron:runs', 'cron:run', 'cron:create', 'cron:update', 'cron:delete',
  // 工具开关
  'tools:list', 'tools:toggle',
  // 会话偏好
  'session:preferredModel:set', 'session:thinkingPrefs:set',
  // 会话只读
  'conversation:list', 'conversation:messages', 'conversation:contextUsage',
  // 运行时只读
  'runtime:ping', 'runtime:enabled', 'runtime:featureFlags:get',
  'agentDefinitions:list', 'agentInstance:list', 'commands:list', 'tasks:list',
  // 记忆只读
  'agentMemories:list', 'agentMemories:export', 'agentMemories:provenance',
  // MCP 只读
  'mcp:status',
  // 存储只读
  'storage:stats', 'storage:listBackups', 'storage:auditRecent',
  // 编码后端
  'codingDev:getBackend', 'codingDev:listBackends', 'codingDev:setBackend',
])
```

`server.ts` 的 `/command` 路由（串行队列是必须的——`agent-runtime-ipc.ts:2447` 的注释声明「所有调用方均在同一 IPC 任务中串行执行」，HTTP 并发会打破该不变量）：

```ts
let commandQueue: Promise<unknown> = Promise.resolve()
/** 把命令排进串行队列，保持 handleCommand 的串行不变量 */
function enqueueCommand<T>(fn: () => Promise<T>): Promise<T> {
  const next = commandQueue.then(fn, fn)
  commandQueue = next.catch(() => {})
  return next
}
```

路由体：总开关 → token → 速率限制 → 白名单 → 队列 → `handleCommand`。bridge 为 null 时返回 `{ ok: false, error: 'not_ready' }`。

**Step 3: 测试通过后提交**

提交：`feat(app-ui): 控制口 /command 白名单转发与串行队列`

---

### Task 15: 设置读写通道（C 层）+ 碎片能力（B 层）

**Files:**
- Create: `apps/windows/src/main/app-ui-control/settings-channel.ts`
- Create: `apps/windows/src/main/app-ui-control/settings-channel.test.ts`
- Modify: `apps/windows/src/main/app-ui-control/server.ts` — 追加 `/settings/*` 与 `/ipc/*` 路由
- Modify: `apps/windows/src/main/app-ui-control/server.test.ts`

**Step 1: 写失败测试**

`settings-channel.test.ts`：
- `buildPatchScript(patch)` 生成的脚本含 `localStorage.setItem` 与 `dispatchEvent`
- 深 merge 不丢失未修改字段（嵌套对象逐层保留）
- 受保护字段 `privacy.allowAgentAppUiControl` → `{ ok: false, error: 'field_protected' }`
- `patch` 含引号/换行/中文时脚本仍是合法 JS（转义正确）
- 点号路径 `theme.mode` → `{ theme: { mode: value } }` 的展开正确

`server.test.ts`：
- `/ipc/skills/setEnabled` 调用 `getSkillRuntime().setLocalEnabled()` **且**调用 `getSkillWatcher().refresh()`
- `/ipc/skills/setEnabled` 参数非法（skillId 空、enabled 非布尔）→ 400，不触碰 runtime
- `/ipc/pet/switchMode` 调用 `switchPetMode()`
- pet 窗口未运行时 → `pet_not_running`
- 总开关关闭时以上路由全部 `disabled`

**Step 2: 最小实现**

**C 层要点（设计 §14.2.3）：merge 必须在注入脚本内部完成**，不能主进程先读再 merge 再写——`useSettings.saveSettings`（`useSettings.ts:314`）是整对象覆盖式 `setItem`，无 CAS，主进程侧 merge 会与用户在设置页的保存互相覆盖。

```ts
/** 受保护字段：禁止经 CLI 写入，防止 Agent 自行开启 App UI 控制总开关 */
const PROTECTED_PATHS: readonly string[] = ['privacy.allowAgentAppUiControl']

/** 生成在渲染进程内原子完成「读-merge-写-广播」的注入脚本 */
function buildPatchScript(patch: Record<string, unknown>): string {
  return `(() => {
    const KEY = 'mtbot-assistant-settings'
    const deepMerge = (t, s) => { /* 参照 useSettings.ts:85-112 */ }
    const current = JSON.parse(localStorage.getItem(KEY) || '{}')
    const next = deepMerge(current, ${JSON.stringify(patch)})
    localStorage.setItem(KEY, JSON.stringify(next))
    window.dispatchEvent(new CustomEvent('mtbot-settings-update', { detail: next }))
    return JSON.stringify(next)
  })()`
}
```

`JSON.stringify(patch)` 的结果已是合法 JS 字面量，**直接内嵌，不要二次 stringify**。

**B 层要点（设计 §14.2.2）：`skills:setEnabled` 的 handler（`index.ts:2154`）除了调 `setLocalEnabled` 还做了参数校验和 `skillWatcher.refresh()`**。server 侧必须复现这两个副作用，否则技能列表不刷新，界面与实际状态不一致。

pet 侧 `switchPetMode` 在 `pet-mode-ipc.ts:74` 已 export，直接调用；`getMode`/`listModels` 的 handler 是匿名闭包，走 `getPetWindowManager()`（`pet-mode-ipc.ts:57`）。

**Step 3: 测试通过后提交**

提交：`feat(app-ui): settings 读写通道与 skills/pet 碎片能力路由`

---

### Task 16: CLI 命令注册表 + help

**背景：** 命令若在「参数解析」「help 文本」「工具 description」三处分别硬编码必然漂移。用一份声明式注册表同时驱动分发、help、能力发现。

**Files:**
- Create: `apps/windows/resources/app-ui-cli/commands.mjs`
- Modify: `apps/windows/resources/app-ui-cli/lumii-ui.mjs` — 改为按注册表分发
- Modify: `apps/windows/src/main/agent-runtime/bridge-app-ui-tools.ts` — 工具 description 改为指向 `lumii-ui help`

**Step 1: 实现注册表（设计 §14.3.1）**

`commands.mjs` 导出 `COMMANDS` 数组，每项含 `name` / `group` / `usage` / `summary` / `layer` / `route` / `options` / `build(args)`。`build` 返回 `null` 表示参数不合法（→ exit 2）。

覆盖命令：`screenshot`、`goto`、`click`、`settings get|set`、`cron list|run`、`model set`、`tools list|toggle`、`skill list|enable|disable`、`pet modes|mode`、`command`。

**Step 2: 实现 help 三种形态**

| 入口 | 输出 |
|------|------|
| `lumii-ui help` / 无参数 / `--help` | 按 `group` 分组的命令总览（含退出码说明） |
| `lumii-ui help <command>` | 单条 usage + options + 示例 |
| `lumii-ui help --json` | 注册表 JSON（剔除 `build` 函数），供 Agent 能力发现 |

`help --json` 是关键：Agent 无需把命令清单写进 system prompt，跑一次即可发现全部能力；CLI 扩命令时**不必同步改工具 description**。

**Step 3: 统一退出码**

Task 10 只定义了 `exit 3`，此处补全：

| 码 | 含义 |
|----|------|
| 0 | 成功 |
| 1 | 其它错误 |
| 2 | 参数错误（未知命令、缺必填参数） |
| 3 | 应用未运行（token 文件缺失或连接失败） |
| 4 | 认证失败（401） |
| 5 | 被拒绝（`not_exposed` / `disabled` / `field_protected`） |

**Step 4: 收敛工具 description**

`bridge-app-ui-tools.ts` 的 description 只留一句「客户端设置与控制走 `lumii-ui`，跑 `lumii-ui help` 查看可用命令」，删掉命令罗列，避免两处漂移。

**验证：**

```bash
node apps/windows/resources/app-ui-cli/lumii-ui.mjs help
node apps/windows/resources/app-ui-cli/lumii-ui.mjs help --json
pnpm --filter @mtbot/windows typecheck
```

提交：`feat(app-ui): lumii-ui 命令注册表、help 与统一退出码`

---

### Task 17: 速率限制 + 三期整体验收

**Files:**
- Modify: `apps/windows/src/main/app-ui-control/server.ts` — 滑动窗口速率限制
- Modify: `apps/windows/src/main/app-ui-control/server.test.ts`

**Step 1: 速率限制**

MVP 的 per-turn 配额（`bridge-app-ui-tools.ts` 的 `turnQuotas`）挂在 `agent:turn:end` 重置，CLI 调用**没有 turn 概念**，该计数器对控制口不适用。控制口自建滑动窗口（如 60 秒 100 次），超限返回 `{ ok: false, error: 'rate_limited' }`。两套配额相互独立。

**Step 2: 手工验收**

应用运行中：

| 验收项 | 期望 |
|--------|------|
| `lumii-ui help` | 输出分组命令总览 |
| `lumii-ui help --json` | 输出机器可读注册表 |
| `lumii-ui cron list` | 返回定时任务列表 JSON |
| `lumii-ui command cron:list` | 与上一条等价 |
| `lumii-ui settings get privacy.saveChatHistory` | 返回 `true` |
| `lumii-ui settings set theme.mode light` | ok；界面立即变浅色，**且其它设置字段未丢失** |
| `lumii-ui settings set privacy.allowAgentAppUiControl false` | `field_protected`，exit 5 |
| `lumii-ui skill list` | 返回技能列表 |
| `lumii-ui skill disable <id>` | ok；技能页**列表已刷新**为禁用态 |
| `lumii-ui pet modes` | 返回桌宠模型列表 |
| `lumii-ui command mcp:writeConfigFile --data '{"content":"{}"}'` | `not_exposed`，exit 5 |
| `lumii-ui command user:send --data '{...}'` | `not_exposed`，exit 5 |
| 设置里关闭「允许 Agent 操作本软件界面」后跑任意命令 | `disabled`，exit 5 |
| 篡改 `~/.lumii/runtime/app-ui.json` 的 token 后跑命令 | 401，exit 4 |
| 关闭应用后跑任意命令 | exit 3 |

**Step 3: 自动化**

```bash
pnpm --filter @mtbot/windows typecheck
npx vitest run apps/windows/src/main/app-ui-control
npx vitest run apps/windows/src/main
```

全部通过才算三期完成。

提交：`feat(app-ui): 控制口速率限制 + 三期整体验收`

---

### Part D 未决问题（开工前需确认）

1. **`model set` 的 sessionKey**：`SessionPreferredModelSetCommand`（`agent-runtime-commands.ts:117`）的 `sessionKey` 必填，CLI 无法凭空构造。「当前活跃会话」的会话状态在渲染进程，主进程未必持有。确认前 `--session` 视为必填，不做隐式默认。
2. **token 在 Windows 上无法用 `chmod 600` 保护**（NTFS 不实现 POSIX mode，Node 只映射只读位）。同用户下任何进程都能读该文件，而 Agent 就跑在同用户下。这意味着 **token 防的是跨用户与网络，白名单才是唯一实质边界**。若需更强隔离，可考虑 token 只驻内存、经环境变量传给 shim（三期不做）。
3. **`files:*` 是否要开放只读子集**：设计当前全关（含 `files:list`/`files:search`），理由是可枚举读取用户文件内容。若产品要 CLI 管文件，需单独评审。

---

## 执行方式

Part A（Task 1→4）先跑通并手工验收，可独立演示「看」的闭环。  
Part B（Task 5→9）在 Part A 基础上叠「动」，全部完成才算 MVP——**已完成**。  
Part C（Task 10→12）是二期，三个任务相对独立，建议先做 Task 11（后续 CLI 复用它），用 executing-plans 逐任务跑测试。  
Part D（Task 13→16）是三期，四个任务依序执行：先打 origin 护栏（Task 13），再扩展控制口 A 层（Task 14），再扩展 B/C 层（Task 15），最后扩展 CLI 并整体验收（Task 16）。Task 14 和 Task 15 的 server.ts 修改可合并一次提交，但测试须分步确认。
