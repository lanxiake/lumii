# Agent 操作客户端自身 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 Lumii Agent 能看见并操作本客户端界面：先交付 MVP 闭环（主窗截图 + 声明式导航 + 按 ref 点击），完整能力按设计分期补齐。

**Architecture:** 主进程 `app-ui-control` 唯一引擎；MVP 只注册进程内工具 `app_screenshot` / `app_goto` / `app_act(click)`。导航复用渲染已有 `handleViewChange` / `openHub`。二期再给同一引擎套本机控制口与 `lumii-ui` CLI。

**Tech Stack:** Electron `capturePage` + `sendInputEvent`、TypeBox 工具、现有 IPC 事件前转、Vitest、JPEG `resizeImageIfNeeded`

**规格：** `docs/design/2026-08-13-agent-app-ui-control-design.md`（v0.3）

**范围锁：** 下列任务 1–8 是 MVP。任务 9+ 是完整规划，未完成 MVP 前不要做。

---

## MVP 任务

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

- `AppUiRef` / `AppUiViewState` / `GotoInput` / `ActInput` 类型  
- 注入脚本字符串 `SNAPSHOT_SCRIPT`（在页面里跑，返回原始节点）  
- `filterSnapshotNodes(raw, { limit: 80 })`  
- 每个函数写中文函数级注释  

**Step 4: 测试通过后提交**

```bash
git add apps/windows/src/main/app-ui-control
git commit -m "feat(app-ui): 快照过滤与类型，供 Agent 看界面"
```

---

### Task 2: goto 校验与 click 策略纯函数

**Files:**
- Create: `apps/windows/src/main/app-ui-control/goto.ts`
- Create: `apps/windows/src/main/app-ui-control/goto.test.ts`
- Create: `apps/windows/src/main/app-ui-control/act.ts`
- Create: `apps/windows/src/main/app-ui-control/act.test.ts`
- Create: `apps/windows/src/main/app-ui-control/coords.ts`
- Create: `apps/windows/src/main/app-ui-control/coords.test.ts`

**内容：**

- `parseGotoInput`：合法 `ViewType` + 可选 `MergedSettingsCategory`；非法返回 `usage`  
- `assertClickAllowed({ ref, snapshotId, current, blockRoles })`：缺 ref / stale / composer → 对应 error 码  
- `devicePixelsToDip`：为 capture 与 click 对齐打底  

跑：`npx vitest run apps/windows/src/main/app-ui-control`

提交：`feat(app-ui): goto/click 参数与过期校验`

---

### Task 3: 主进程控制器（mock BrowserWindow）

**Files:**
- Create: `apps/windows/src/main/app-ui-control/controller.ts`
- Create: `apps/windows/src/main/app-ui-control/controller.test.ts`

**内容：**

- `createAppUiController(deps)`：`getMainWindow`、`resizeImageIfNeeded`、截图输出目录  
- `screenshot()`：`capturePage` → JPEG ≤1280 长边 → 写 `workspace/outputs/YYYYMMDD/app-screenshot_*.jpg` → 跑快照脚本 → 缓存 `{ snapshotId, refs, viewState, bounds }`  
- `click({ ref, snapshotId })`：校验 → `executeJavaScript` scrollIntoView+rect → `sendInputEvent` mouseDown/Up  
- 无主窗 → `app_not_running`  
- 测试用 fake `webContents`  

提交：`feat(app-ui): 主窗截图与按 ref 点击控制器`

---

### Task 4: 渲染导航 `app-ui:goto`

**Files:**
- Modify: `apps/windows/src/renderer/App.tsx`（已有 `mtbot:navigate-request` / `openHub`）
- Modify: `apps/windows/src/main/ipc/agent-runtime-ipc.ts` 或现有 `forwardIpcEvent` 通道  
- Modify: preload **仅当没有可复用事件时**（先搜 `session:create-request` 怎么到渲染的，照抄）
- Modify: `apps/windows/src/renderer/components/layout/Sidebar/Sidebar.tsx` — 设置按钮 `data-app-ui="nav-settings"`  
- Modify: `SettingsHubModal.tsx` — Tab `data-app-ui="hub-tab"`  
- Modify: 设置左侧分类项 `data-app-ui="hub-category"`  
- Modify: `ChatInput` 根 `data-app-ui-block="composer"`  

**行为：**

主进程 `controller.goto` 发事件到主窗；渲染调用已有 `handleViewChange` / `openHub(tab, category)`；回传当前 `{ view, hub }`（可用 `executeJavaScript` 读 `window.__LUMII_APP_UI_STATE__` 或一次性 IPC reply）。

选 **更小的一种**：渲染把状态挂到 `window.__LUMII_APP_UI_STATE__`（goto 后主进程 executeJavaScript 读取），避免新 IPC 三处同步。若加 IPC，必须 preload + 类型 + handler 一起改。

提交：`feat(app-ui): 声明式导航打开 Hub/主视图`

---

### Task 5: 注册三个 Agent 工具

**Files:**
- Create: `apps/windows/src/main/agent-runtime/bridge-app-ui-tools.ts`
- Modify: `apps/windows/src/main/agent-runtime/bridge-tool-registrar.ts` — `registerAll()` 始终注册  
- Modify: 工具 description 使用设计 §13.2 分工原文  
- Modify: `permission-types.ts` 或等价名单 — `app_act` 可被「始终允许」记住  
- Test: `bridge-app-ui-tools.test.ts`（mock controller）

**MVP 参数：**

- `app_screenshot`：`annotate` 可选，忽略或默认 false  
- `app_goto`：`view` + 可选 `category`  
- `app_act`：只接受 `action=click` + `ref` + 可选 `snapshotId`；其它 action 返回 `usage`（为二期留口）

`app_screenshot` 的 `content` 必须含 text JSON + `{ type: 'image', data, mimeType: 'image/jpeg' }`。

提交：`feat(app-ui): 注册 app_screenshot/app_goto/app_act`

---

### Task 6: 时间线缩略图

**Files:**
- Modify: `apps/windows/src/renderer/pages/ChatPage/components/ToolCallCard/toolTaxonomy.ts`
- Modify: `apps/windows/src/renderer/pages/ChatPage/components/ToolCallCard/index.tsx`  
  将 `image_generate` 预览分支扩展到 `app_screenshot`（读 result.path 或 image 块）

提交：`feat(app-ui): 截图工具卡显示缩略图`

---

### Task 7: 总开关与配额

**Files:**
- Modify: 设置「通用」或隐私区加「允许 Agent 操作本软件界面」，默认 true  
- `isEnabled()` 读该开关  
- controller 内单轮计数：screenshot 8 / act 20 / goto 20（按当前 runId 或简单进程滑动窗；MVP 可用实例级计数）

提交：`feat(app-ui): 操作本软件总开关与配额`

---

### Task 8: MVP 验收

**跑：**

```bash
pnpm --filter @mtbot/windows typecheck
npx vitest run apps/windows/src/main/app-ui-control apps/windows/src/main/agent-runtime/bridge-app-ui-tools.test.ts
```

**手工（设计 §7.2）：**

1. 「截一张当前界面」  
2. 「打开设置 → 语音」再截图  
3. 「打开技能页」再截图  
4. 按 ref 点一个非输入框控件  
5. 点发送键应被拦截  
6. 无视觉模型仅凭 goto + refs 仍能打开设置  

全部通过才算 MVP 完成。不要开始 Task 9。

---

## 完整规划（MVP 之后）

### Task 9: 本机控制口 + `lumii-ui` CLI（二期）

- `server.ts` 绑 `127.0.0.1` 随机端口，写 `~/.lumii/runtime/app-ui.json`  
- `apps/windows/scripts/lumii-ui.mjs` 零依赖；**打包必须带运行时，禁止假设系统有 node**（用 `Lumii.exe` 子命令或 extraFiles node）  
- 命令：`screenshot` / `goto` / `click`，stdout JSON，exit 码见设计 v0.2/v0.3  
- 应用未开 exit 3，不自动启动  

### Task 10: 完整 `app_act`（二期）

- type：React native value setter + `insertText`  
- key 白名单、scroll、坐标 click、右键/双击  
- 单测中文受控输入  

### Task 11: SoM 与多窗（二期）

- `annotate=true` 在截图副本上画编号  
- `target=pet|preview` 仅截图  
- `app_ui_state` 只读工具  

### Task 12: 声明式能力补齐（三期）

按设计 §4.4 逐个加，优先：

1. `skill_set_enabled`  
2. `settings_chat_model`  
3. `cron_run_now`  
4. `pet_mode_set`  

每加一个，工具描述里写「不要用 click 做这件事」。

### Task 13: 桌宠点击（三期）

画布 DIP 坐标；不做 DOM ref。

---

## 执行方式

MVP 用 executing-plans **按 Task 1→8 顺序**，每任务测试过再进下一个。  
Task 9+ 等产品确认「要 CLI / 要输入」后再开。
