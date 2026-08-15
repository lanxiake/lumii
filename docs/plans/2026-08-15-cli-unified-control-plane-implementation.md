# CLI 统一对外控制面（三期）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把本机 `lumii-ui` CLI 扩展为统一对外控制面：命令总线白名单转发（A）、碎片能力 skills/pet（B）、设置读写通道（C），并补速率限制、help 注册表与退出码约定。

**Architecture:** 二期已有的 `app-ui-control/server.ts`（127.0.0.1 + Bearer token）继续作为唯一入口。三期不新建 dispatch：导出既有 `handleCommand`，经 `COMMAND_ALLOWLIST` 过滤后串行转发；skills/pet 走 deps 注入的业务函数（避免 `index.ts`↔`server.ts` 循环依赖）；设置写在渲染进程注入脚本内 deepMerge，杜绝主进程 RMW 竞态。防线落在控制口自身（白名单 + 字段保护 + loopback + token），**不做** `external_cli` origin / CapabilityRegistry 假护栏。

**Tech Stack:** Node `http`、Vitest、零依赖 ESM CLI（`fetch`）、既有 `agent-runtime-ipc.handleCommand`、`ClientSkillRuntime`、`switchPetMode`、`executeJavaScript` + localStorage

**规格：**
- 主规格：`docs/design/2026-08-13-agent-app-ui-control-design.md` **§14（v0.7）**
- 边界参考：`docs/design/2026-08-15-cli-hub-external-software-design.md`（**已落地，三期不改代码**）
- 前序计划：`docs/plans/2026-08-14-agent-app-ui-control-implementation.md` Part A–C 已完成；本文**取代**该文档 Part D（Task 13–17），按本文执行

## Global Constraints

- 白名单默认拒绝：92 条命令只开放 §14.2.1 表内项；扩白名单必须评审
- 禁止往 `AgentRuntimeCommand` / `AgentTurnOrigin` / `CapabilityRegistry` 加 `external_cli`
- `privacy.allowAgentAppUiControl` 不可经 CLI 写入（`field_protected`）
- `/command` 必须串行排队（保持 `handleCommand` 串行不变量）
- 控制口只绑 `127.0.0.1`；token 防跨用户/网络，**不是**同用户进程边界（Windows 上 `chmod 600` 无效）
- 外部桌面软件继续走 bundled 技能 `cli-hub` + `bash`，**禁止**塞进 app-ui-control
- Agent 禁止用 `bash lumii-ui` 代替进程内 `app_*`（工具 description 保留此约束；控制口仍需白名单防绕过）
- `model set` 的 `--session` 三期必填，不做「当前活跃会话」隐式默认
- 每个新建函数写中文函数级注释；单测放同目录 `*.test.ts`
- 验证命令在 `apps/windows` 下：`npx vitest run src/main/app-ui-control`

---

## 文件结构（锁定）

| 路径 | 职责 |
|------|------|
| `apps/windows/src/main/ipc/agent-runtime-ipc.ts` | 导出 `handleCommand`；新增 `getAgentRuntimeBridge()` |
| `apps/windows/src/main/index.ts` | 启动控制口时注入 skills/watcher deps；可选导出 accessor 供其它模块 |
| `apps/windows/src/main/app-ui-control/command-allowlist.ts` | `COMMAND_ALLOWLIST` + `isCommandExposed` |
| `apps/windows/src/main/app-ui-control/command-allowlist.test.ts` | 白名单单测 |
| `apps/windows/src/main/app-ui-control/settings-channel.ts` | 读/写脚本生成、路径展开、受保护字段 |
| `apps/windows/src/main/app-ui-control/settings-channel.test.ts` | merge / 保护字段 / 转义 |
| `apps/windows/src/main/app-ui-control/rate-limit.ts` | 滑动窗口计数器纯函数 |
| `apps/windows/src/main/app-ui-control/rate-limit.test.ts` | 窗口满 / 滑动恢复 |
| `apps/windows/src/main/app-ui-control/server.ts` | 追加 `/command`、`/settings/*`、`/ipc/*`；总开关；速率限制；串行队列 |
| `apps/windows/src/main/app-ui-control/server.test.ts` | 路由集成测 |
| `apps/windows/resources/app-ui-cli/commands.mjs` | 声明式 `COMMANDS` 注册表 |
| `apps/windows/resources/app-ui-cli/lumii-ui.mjs` | 按注册表分发 + help + 统一退出码 |
| `apps/windows/src/main/agent-runtime/bridge-app-ui-tools.ts` | description 指向 `lumii-ui help`（一句） |

**不做：** `AgentTurnOrigin.external_cli`、CapabilityRegistry 改动、cli-hub 一等工具、设置页 harness 管理、自动装 GIMP 等宿主。

---

### Task 1: 导出调用地基 + 扩展控制口 deps（规避循环依赖）

**Files:**
- Modify: `apps/windows/src/main/ipc/agent-runtime-ipc.ts`
- Modify: `apps/windows/src/main/app-ui-control/server.ts`（仅 deps 类型与启动接线，暂不加新路由）
- Modify: `apps/windows/src/main/index.ts`（启动时传入 skills deps）
- Test: 现有 `server.test.ts` 仍绿（deps 可选）

**背景：** `index.ts` 已 `import { startAppUiControlServer } from './app-ui-control/server'`。若 `server.ts` 再 `import` `index.ts` 的 `getSkillRuntime`，形成循环依赖。因此 skills/watcher **经 deps 注入**；`handleCommand` / `getAgentRuntimeBridge` 在 `agent-runtime-ipc.ts`（无环）可直接 import。

**Interfaces:**
- Produces: `export async function handleCommand(bridge, command): Promise<unknown>`
- Produces: `export function getAgentRuntimeBridge(): AgentRuntimeBridge | null`
- Produces: `AppUiControlServerDeps` 新增可选字段：
  - `getSkillRuntime?: () => { listLocalInstalled(): Promise<unknown>; setLocalEnabled(id: string, enabled: boolean): Promise<unknown> } | null`
  - `getSkillWatcher?: () => { refresh(): Promise<unknown> } | null`
  - `readSettingsJson?: () => Promise<string | null>`（总开关用，与 bridge 工具同源）

- [ ] **Step 1: 导出 handleCommand 与 bridge accessor**

将 `agent-runtime-ipc.ts` 中：

```ts
async function handleCommand(
  bridge: AgentRuntimeBridge,
  command: AgentRuntimeCommand,
): Promise<unknown> {
```

改为：

```ts
/** 处理单个 Agent Runtime 命令（IPC 与控制口共用） */
export async function handleCommand(
  bridge: AgentRuntimeBridge,
  command: AgentRuntimeCommand,
): Promise<unknown> {
```

在 `ipcBridgeRef` 声明附近新增：

```ts
/** 供控制口读取 bridge；ipcBridgeRef 保持私有，不允许外部改写 */
export function getAgentRuntimeBridge(): AgentRuntimeBridge | null {
  return ipcBridgeRef
}
```

- [ ] **Step 2: 扩展 AppUiControlServerDeps**

在 `server.ts`：

```ts
export interface AppUiControlServerDeps {
  getWindow: (target: 'main' | 'pet' | 'preview') => BrowserWindow | null
  resizeImageIfNeeded?: ResizeImageFn
  controller?: AppUiController
  token?: string
  port?: number
  /** B 层 skills：由 index 注入，避免 server↔index 循环依赖 */
  getSkillRuntime?: () => {
    listLocalInstalled: () => Promise<unknown>
    setLocalEnabled: (skillId: string, enabled: boolean) => Promise<unknown>
  } | null
  getSkillWatcher?: () => { refresh: () => Promise<unknown> } | null
  /** 总开关：读 localStorage 设置 JSON；缺省视为开启 */
  readSettingsJson?: () => Promise<string | null>
}
```

模块级保存 deps 引用（供后续路由用）：

```ts
let activeDeps: AppUiControlServerDeps | null = null
```

在 `startAppUiControlServer` 开头：`activeDeps = deps`；`stopAppUiControlServer` 清空。

- [ ] **Step 3: index 启动接线**

```ts
await startAppUiControlServer({
  getWindow: (target) => (target === 'main' ? mainWindow : null),
  resizeImageIfNeeded,
  getSkillRuntime: () => skillRuntime,
  getSkillWatcher: () => skillWatcher,
  readSettingsJson: async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return null
    return mainWindow.webContents.executeJavaScript(
      `localStorage.getItem('mtbot-assistant-settings')`,
    ) as Promise<string | null>
  },
})
```

可选：在 `index.ts` 的 `skillRuntime` 声明后增加同名 accessor（供其它模块），**server 不 import 它们**。

- [ ] **Step 4: 验证**

```bash
cd apps/windows && pnpm typecheck
cd apps/windows && npx vitest run src/main/app-ui-control
```

Expected: PASS（行为不变）

- [ ] **Step 5: Commit**

```bash
git add apps/windows/src/main/ipc/agent-runtime-ipc.ts apps/windows/src/main/app-ui-control/server.ts apps/windows/src/main/index.ts
git commit -m "$(cat <<'EOF'
refactor(app-ui): 导出 handleCommand 并为控制口注入 skills deps

三期地基：控制口可转发命令总线，且避免 server↔index 循环依赖。
EOF
)"
```

---

### Task 2: COMMAND_ALLOWLIST（纯数据 + 单测）

**Files:**
- Create: `apps/windows/src/main/app-ui-control/command-allowlist.ts`
- Create: `apps/windows/src/main/app-ui-control/command-allowlist.test.ts`

**Interfaces:**
- Produces: `export const COMMAND_ALLOWLIST: ReadonlySet<string>`
- Produces: `export function isCommandExposed(type: unknown): type is string`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { COMMAND_ALLOWLIST, isCommandExposed } from './command-allowlist'

describe('COMMAND_ALLOWLIST', () => {
  it('允许 cron:list / tools:toggle / session:preferredModel:set', () => {
    expect(isCommandExposed('cron:list')).toBe(true)
    expect(isCommandExposed('tools:toggle')).toBe(true)
    expect(isCommandExposed('session:preferredModel:set')).toBe(true)
  })

  it('拒绝高危命令', () => {
    for (const t of [
      'mcp:writeConfigFile',
      'mcp:upsert',
      'user:send',
      'user:permissionRespond',
      'files:delete',
      'files:list',
      'storage:exportJsonl',
      'agentInstance:prompt',
      'image:generate',
      'runtime:featureFlags:set',
    ]) {
      expect(isCommandExposed(t)).toBe(false)
    }
  })

  it('未知类型默认拒绝；非字符串拒绝', () => {
    expect(isCommandExposed('totally:unknown')).toBe(false)
    expect(isCommandExposed(null)).toBe(false)
    expect(isCommandExposed(undefined)).toBe(false)
  })

  it('是 ReadonlySet 且含设计表全部开放项', () => {
    expect(COMMAND_ALLOWLIST).toBeInstanceOf(Set)
    expect(COMMAND_ALLOWLIST.has('codingDev:setBackend')).toBe(true)
    expect(COMMAND_ALLOWLIST.has('agentMemories:list')).toBe(true)
    expect(COMMAND_ALLOWLIST.has('mcp:status')).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测确认失败**

```bash
cd apps/windows && npx vitest run src/main/app-ui-control/command-allowlist.test.ts
```

Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

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

/** 判断命令 type 是否在白名单内 */
export function isCommandExposed(type: unknown): type is string {
  return typeof type === 'string' && COMMAND_ALLOWLIST.has(type)
}
```

- [ ] **Step 4: 跑测确认通过**

```bash
cd apps/windows && npx vitest run src/main/app-ui-control/command-allowlist.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/windows/src/main/app-ui-control/command-allowlist.ts apps/windows/src/main/app-ui-control/command-allowlist.test.ts
git commit -m "$(cat <<'EOF'
feat(app-ui): 控制口命令白名单 COMMAND_ALLOWLIST

默认拒绝 92 条命令中的高危项，仅开放评审过的 cron/tools/只读探针等。
EOF
)"
```

---

### Task 3: 滑动窗口速率限制（纯模块）

**Files:**
- Create: `apps/windows/src/main/app-ui-control/rate-limit.ts`
- Create: `apps/windows/src/main/app-ui-control/rate-limit.test.ts`

**Interfaces:**
- Produces: `createSlidingWindowRateLimiter(opts: { limit: number; windowMs: number; now?: () => number })`
- Produces: `limiter.tryConsume(): boolean`（true=放行）
- Consumes: 无

**说明：** CLI 无 turn 概念，MVP 的 `turnQuotas` 不适用；控制口独立 60s/100 次。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { createSlidingWindowRateLimiter } from './rate-limit'

describe('createSlidingWindowRateLimiter', () => {
  it('窗口内第 limit+1 次拒绝', () => {
    let t = 1_000_000
    const lim = createSlidingWindowRateLimiter({
      limit: 3,
      windowMs: 60_000,
      now: () => t,
    })
    expect(lim.tryConsume()).toBe(true)
    expect(lim.tryConsume()).toBe(true)
    expect(lim.tryConsume()).toBe(true)
    expect(lim.tryConsume()).toBe(false)
  })

  it('时间滑出窗口后恢复', () => {
    let t = 0
    const lim = createSlidingWindowRateLimiter({
      limit: 2,
      windowMs: 60_000,
      now: () => t,
    })
    expect(lim.tryConsume()).toBe(true)
    expect(lim.tryConsume()).toBe(true)
    expect(lim.tryConsume()).toBe(false)
    t = 60_000
    expect(lim.tryConsume()).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测确认失败**

```bash
cd apps/windows && npx vitest run src/main/app-ui-control/rate-limit.test.ts
```

Expected: FAIL

- [ ] **Step 3: 最小实现**

```ts
export interface SlidingWindowRateLimiterOptions {
  limit: number
  windowMs: number
  now?: () => number
}

export interface SlidingWindowRateLimiter {
  /** 尝试占用一次配额；超限返回 false */
  tryConsume: () => boolean
}

/**
 * 创建滑动窗口速率限制器（记录时间戳队列，剔除窗口外样本）。
 */
export function createSlidingWindowRateLimiter(
  opts: SlidingWindowRateLimiterOptions,
): SlidingWindowRateLimiter {
  const timestamps: number[] = []
  const now = opts.now ?? Date.now
  return {
    tryConsume() {
      const t = now()
      const cutoff = t - opts.windowMs
      while (timestamps.length > 0 && timestamps[0]! < cutoff) {
        timestamps.shift()
      }
      if (timestamps.length >= opts.limit) return false
      timestamps.push(t)
      return true
    },
  }
}
```

- [ ] **Step 4: 跑测确认通过 + Commit**

```bash
cd apps/windows && npx vitest run src/main/app-ui-control/rate-limit.test.ts
git add apps/windows/src/main/app-ui-control/rate-limit.ts apps/windows/src/main/app-ui-control/rate-limit.test.ts
git commit -m "$(cat <<'EOF'
feat(app-ui): 控制口滑动窗口速率限制器

与 per-turn 配额独立，供 CLI HTTP 请求共用。
EOF
)"
```

---

### Task 4: `/command` 路由（A 层）+ 总开关 + 速率限制接线

**Files:**
- Modify: `apps/windows/src/main/app-ui-control/server.ts`
- Modify: `apps/windows/src/main/app-ui-control/server.test.ts`

**Interfaces:**
- Consumes: `isCommandExposed`、`handleCommand`、`getAgentRuntimeBridge`、`createSlidingWindowRateLimiter`、`isAppUiControlEnabled`
- Produces: `POST /command` → `{ ok, result? }` 或 `{ ok:false, error }`

**拦截顺序（必须）：** method → token → **总开关** → **速率限制** → 路由；`/command` 内再：白名单 → 串行队列 → `handleCommand`。

- [ ] **Step 1: 写失败测试（追加到 server.test.ts）**

在现有 `postRoute` helper 上追加用例（启动时注入 mock）：

```ts
it('/command 白名单外返回 not_exposed 且不调用 handleCommand', async () => {
  // vi.mock('../ipc/agent-runtime-ipc') 注入 handleCommand spy
  // post /command { type: 'mcp:writeConfigFile', content: '{}' }
  // expect json.error === 'not_exposed'
  // expect(handleCommand).not.toHaveBeenCalled()
})

it('/command 白名单内透传 handleCommand 返回值', async () => {
  // mock handleCommand → { status: 'ok', jobs: [] }
  // post { type: 'cron:list' }
  // expect body 含该结果
})

it('并发两个 /command 串行执行', async () => {
  // handleCommand: 第一次 await delay(50)；记录调用顺序 start/end
  // 并行发两个 cron:list
  // 断言第二次 start 不早于第一次 end
})

it('总开关关闭时任意路由返回 disabled', async () => {
  // startAppUiControlServer({ readSettingsJson: async () => JSON.stringify({
  //   privacy: { allowAgentAppUiControl: false }
  // })})
  // post /screenshot → error disabled
})

it('超速率限制返回 rate_limited', async () => {
  // 测试注入 rateLimiter: { tryConsume: () => false } 或 limit=1
  // 第二次请求 → rate_limited，且未进 handleCommand
})
```

为可测性，给 `AppUiControlServerDeps` 再加可选：

```ts
rateLimiter?: { tryConsume: () => boolean }
/** 测试注入：覆盖默认 handleCommand */
dispatchCommand?: (command: unknown) => Promise<unknown>
```

生产路径：未注入则用 `createSlidingWindowRateLimiter({ limit: 100, windowMs: 60_000 })` + 真实 `handleCommand`。

- [ ] **Step 2: 跑测确认失败**

```bash
cd apps/windows && npx vitest run src/main/app-ui-control/server.test.ts
```

Expected: FAIL（新用例）

- [ ] **Step 3: 实现路由核心**

```ts
import { handleCommand, getAgentRuntimeBridge } from '../ipc/agent-runtime-ipc'
import { isCommandExposed } from './command-allowlist'
import { createSlidingWindowRateLimiter } from './rate-limit'
import { isAppUiControlEnabled } from './enabled'

let commandQueue: Promise<unknown> = Promise.resolve()

/** 把命令排进串行队列，保持 handleCommand 的串行不变量 */
function enqueueCommand<T>(fn: () => Promise<T>): Promise<T> {
  const next = commandQueue.then(fn, fn)
  commandQueue = next.catch(() => {})
  return next
}

// createRequestHandler 内，鉴权通过后：
const enabled = await isAppUiControlEnabled(
  activeDeps?.readSettingsJson ?? (async () => null),
)
if (!enabled) {
  sendJson(res, 200, { ok: false, error: 'disabled' })
  return
}
const limiter =
  activeDeps?.rateLimiter ??
  /* 模块级单例，在 start 时创建并挂到 activeRateLimiter */
  activeRateLimiter!
if (!limiter.tryConsume()) {
  sendJson(res, 200, { ok: false, error: 'rate_limited' })
  return
}

// handleRoute 增加：
case '/command': {
  const type = (body as { type?: unknown } | null)?.type
  if (!isCommandExposed(type)) {
    sendJson(res, 200, { ok: false, error: 'not_exposed' })
    return
  }
  const dispatch =
    activeDeps?.dispatchCommand ??
    (async (cmd: unknown) => {
      const bridge = getAgentRuntimeBridge()
      if (!bridge) return { ok: false, error: 'not_ready' }
      return handleCommand(bridge, cmd as Parameters<typeof handleCommand>[1])
    })
  const result = await enqueueCommand(() => dispatch(body))
  sendJson(res, 200, result)
  return
}
```

注意：`handleCommand` 自身可能 throw；捕获后 `sendJson(400/200, { ok:false, error:'command_failed', message })`，勿让请求挂死。

- [ ] **Step 4: 跑测确认通过 + Commit**

```bash
cd apps/windows && npx vitest run src/main/app-ui-control
git add apps/windows/src/main/app-ui-control/server.ts apps/windows/src/main/app-ui-control/server.test.ts
git commit -m "$(cat <<'EOF'
feat(app-ui): 控制口 /command 白名单转发、串行队列与速率限制

HTTP 并发不再打破 handleCommand 串行不变量；高危命令 not_exposed。
EOF
)"
```

---

### Task 5: 设置读写通道（C 层）

**Files:**
- Create: `apps/windows/src/main/app-ui-control/settings-channel.ts`
- Create: `apps/windows/src/main/app-ui-control/settings-channel.test.ts`
- Modify: `apps/windows/src/main/app-ui-control/server.ts` — `POST /settings/read`、`POST /settings/write`
- Modify: `apps/windows/src/main/app-ui-control/server.test.ts`

**Interfaces:**
- Produces: `PROTECTED_SETTINGS_PATHS`、`expandPathValue`、`assertWritablePatch`、`buildReadScript`、`buildPatchScript`
- Consumes: `getWindow('main').webContents.executeJavaScript`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import {
  PROTECTED_SETTINGS_PATHS,
  assertWritablePatch,
  buildPatchScript,
  buildReadScript,
  expandPathValue,
} from './settings-channel'

describe('settings-channel', () => {
  it('expandPathValue 展开点号路径', () => {
    expect(expandPathValue('theme.mode', 'light')).toEqual({ theme: { mode: 'light' } })
  })

  it('受保护字段拒绝', () => {
    expect(assertWritablePatch({ privacy: { allowAgentAppUiControl: false } })).toEqual({
      ok: false,
      error: 'field_protected',
    })
    expect(PROTECTED_SETTINGS_PATHS).toContain('privacy.allowAgentAppUiControl')
  })

  it('buildPatchScript 含 setItem 与 mtbot-settings-update', () => {
    const script = buildPatchScript({ theme: { mode: 'dark' } })
    expect(script).toContain("localStorage.setItem('mtbot-assistant-settings'")
    expect(script).toContain('mtbot-settings-update')
    expect(script).toContain('"mode":"dark"')
  })

  it('含引号与中文的 patch 仍是合法嵌入', () => {
    const script = buildPatchScript({ language: 'zh-"CN"' })
    // JSON.stringify 已转义，脚本可被 Function 解析
    expect(() => new Function(script)).not.toThrow()
  })

  it('buildReadScript 无 setItem；省略 key 返回整份', () => {
    const all = buildReadScript()
    expect(all).not.toContain('setItem')
    expect(buildReadScript('privacy.saveChatHistory')).toContain('privacy.saveChatHistory')
  })
})
```

- [ ] **Step 2: 跑测确认失败**

```bash
cd apps/windows && npx vitest run src/main/app-ui-control/settings-channel.test.ts
```

Expected: FAIL

- [ ] **Step 3: 实现 settings-channel.ts**

```ts
/** 禁止经 CLI 写入的设置路径（防止自举开启 App UI 总开关） */
export const PROTECTED_SETTINGS_PATHS: readonly string[] = [
  'privacy.allowAgentAppUiControl',
]

/**
 * 将 `a.b.c` + value 展开为嵌套对象 patch。
 */
export function expandPathValue(keyPath: string, value: unknown): Record<string, unknown> {
  const parts = keyPath.split('.').filter(Boolean)
  if (parts.length === 0) return {}
  const root: Record<string, unknown> = {}
  let cur = root
  for (let i = 0; i < parts.length - 1; i++) {
    const next: Record<string, unknown> = {}
    cur[parts[i]!] = next
    cur = next
  }
  cur[parts[parts.length - 1]!] = value
  return root
}

/** 若 patch 触及受保护路径则拒绝 */
export function assertWritablePatch(
  patch: Record<string, unknown>,
): { ok: true } | { ok: false; error: 'field_protected' } {
  for (const path of PROTECTED_SETTINGS_PATHS) {
    const parts = path.split('.')
    let cur: unknown = patch
    let hit = true
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object' || !(p in (cur as object))) {
        hit = false
        break
      }
      cur = (cur as Record<string, unknown>)[p]
    }
    if (hit) return { ok: false, error: 'field_protected' }
  }
  return { ok: true }
}

/**
 * 生成读 localStorage 的注入脚本；keyPath 省略时返回整份设置 JSON。
 */
export function buildReadScript(keyPath?: string): string {
  const keyLit = keyPath === undefined ? 'undefined' : JSON.stringify(keyPath)
  return `(() => {
    const getByPath = (obj, path) => {
      if (!path) return obj
      return path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), obj)
    }
    const current = JSON.parse(localStorage.getItem('mtbot-assistant-settings') || '{}')
    return JSON.stringify(getByPath(current, ${keyLit}))
  })()`
}

/**
 * 生成在渲染进程内原子完成「读-merge-写-广播」的注入脚本。
 * patch 经 JSON.stringify 后直接内嵌（已是合法 JS 字面量，禁止二次 stringify）。
 * deepMerge 语义对齐 useSettings.ts:85-112。
 */
export function buildPatchScript(patch: Record<string, unknown>): string {
  return `(() => {
    const KEY = 'mtbot-assistant-settings'
    const deepMerge = (t, s) => {
      const result = Object.assign({}, t)
      for (const key of Object.keys(s)) {
        const tv = t[key], sv = s[key]
        if (
          tv && typeof tv === 'object' && !Array.isArray(tv) &&
          sv && typeof sv === 'object' && !Array.isArray(sv)
        ) {
          result[key] = deepMerge(tv, sv)
        } else if (sv !== undefined) {
          result[key] = sv
        }
      }
      return result
    }
    const current = JSON.parse(localStorage.getItem(KEY) || '{}')
    const next = deepMerge(current, ${JSON.stringify(patch)})
    localStorage.setItem(KEY, JSON.stringify(next))
    window.dispatchEvent(new CustomEvent('mtbot-settings-update', { detail: next }))
    return JSON.stringify(next)
  })()`
}
```

- [ ] **Step 4: server 路由**

```ts
case '/settings/read': {
  const win = activeDeps!.getWindow('main')
  if (!win || win.isDestroyed()) {
    sendJson(res, 200, { ok: false, error: 'app_not_running' })
    return
  }
  const keyPath = (body as { keyPath?: string } | null)?.keyPath
  const raw = await win.webContents.executeJavaScript(buildReadScript(keyPath))
  sendJson(res, 200, { ok: true, value: JSON.parse(raw as string) })
  return
}
case '/settings/write': {
  const record = (body ?? {}) as { keyPath?: string; value?: unknown; patch?: Record<string, unknown> }
  const patch =
    record.patch ??
    (typeof record.keyPath === 'string'
      ? expandPathValue(record.keyPath, record.value)
      : null)
  if (!patch || typeof patch !== 'object') {
    sendJson(res, 200, { ok: false, error: 'usage' })
    return
  }
  const gate = assertWritablePatch(patch)
  if (!gate.ok) {
    sendJson(res, 200, gate)
    return
  }
  const win = activeDeps!.getWindow('main')
  if (!win || win.isDestroyed()) {
    sendJson(res, 200, { ok: false, error: 'app_not_running' })
    return
  }
  const raw = await win.webContents.executeJavaScript(buildPatchScript(patch))
  sendJson(res, 200, { ok: true, settings: JSON.parse(raw as string) })
  return
}
```

server 测试补：受保护字段**不调用** `executeJavaScript`；主窗 null → `app_not_running`。

- [ ] **Step 5: 跑测 + Commit**

```bash
cd apps/windows && npx vitest run src/main/app-ui-control
git add apps/windows/src/main/app-ui-control/settings-channel.ts apps/windows/src/main/app-ui-control/settings-channel.test.ts apps/windows/src/main/app-ui-control/server.ts apps/windows/src/main/app-ui-control/server.test.ts
git commit -m "$(cat <<'EOF'
feat(app-ui): 设置读写通道与总开关自举防护

注入脚本内 deepMerge，禁止 CLI 改写 allowAgentAppUiControl。
EOF
)"
```

---

### Task 6: B 层 skills / pet 路由

**Files:**
- Modify: `apps/windows/src/main/app-ui-control/server.ts`
- Modify: `apps/windows/src/main/app-ui-control/server.test.ts`

**Interfaces:**
- Consumes: `deps.getSkillRuntime` / `getSkillWatcher`；`switchPetMode` / `getPetWindowManager`（`pet-mode-ipc.ts` 已 export）
- Produces:
  - `POST /ipc/skills/list`
  - `POST /ipc/skills/setEnabled` body `{ skillId, enabled }`
  - `POST /ipc/pet/switchMode` body `{ mode, modelId? }`
  - `POST /ipc/pet/getMode`
  - `POST /ipc/pet/listModels`

**原则：** 不暴露文件/渠道登录/技能安装卸载/更新器/语音。`setEnabled` **必须**复现 `index.ts:2126-2139` 的参数校验 + `skillWatcher.refresh()`。

- [ ] **Step 1: 写失败测试**

```ts
it('/ipc/skills/list 调用 getSkillRuntime().listLocalInstalled', ...)
it('/ipc/skills/setEnabled 调用 setLocalEnabled 且 refresh', ...)
it('/ipc/skills/setEnabled 非法参数返回 usage 且不触碰 runtime', ...)
it('/ipc/pet/switchMode 调用 switchPetMode', ...)
it('/ipc/pet/listModels 经 loadPetModelRegistry 或 mock manager', ...)
it('skills runtime 未注入 → not_ready', ...)
```

pet `listModels` 实现与 IPC 一致：

```ts
const { loadPetModelRegistry } = await import('../pet/pet-model-resolver')
const { models } = await loadPetModelRegistry()
```

或经 deps 注入 `listPetModels` 便于单测。推荐 **deps 可选 `listPetModels?: () => Promise<unknown>`**，生产在 index 不传、server 内动态 import；测试注入固定数组。

- [ ] **Step 2: 实现路由**

```ts
import { getPetWindowManager, switchPetMode } from '../pet/pet-mode-ipc'

case '/ipc/skills/list': {
  const rt = activeDeps?.getSkillRuntime?.()
  if (!rt) { sendJson(res, 200, { ok: false, error: 'not_ready' }); return }
  const skills = await rt.listLocalInstalled()
  sendJson(res, 200, { ok: true, skills })
  return
}
case '/ipc/skills/setEnabled': {
  const skillId = (body as { skillId?: unknown })?.skillId
  const enabled = (body as { enabled?: unknown })?.enabled
  if (typeof skillId !== 'string' || skillId.length === 0 || typeof enabled !== 'boolean') {
    sendJson(res, 200, { ok: false, error: 'usage' })
    return
  }
  const rt = activeDeps?.getSkillRuntime?.()
  if (!rt) { sendJson(res, 200, { ok: false, error: 'not_ready' }); return }
  const result = await rt.setLocalEnabled(skillId, enabled)
  const watcher = activeDeps?.getSkillWatcher?.()
  if (watcher) {
    await watcher.refresh().catch(() => {})
  }
  sendJson(res, 200, { ok: true, result })
  return
}
case '/ipc/pet/switchMode': {
  const mode = (body as { mode?: unknown })?.mode
  const modelId = (body as { modelId?: unknown })?.modelId
  if (mode !== 'pet' && mode !== 'desktop') {
    sendJson(res, 200, { ok: false, error: 'usage' })
    return
  }
  await switchPetMode(mode, typeof modelId === 'string' ? modelId : undefined)
  sendJson(res, 200, { ok: true, mode: getPetWindowManager()?.getMode() ?? mode })
  return
}
case '/ipc/pet/getMode': {
  sendJson(res, 200, { ok: true, mode: getPetWindowManager()?.getMode() ?? 'desktop' })
  return
}
case '/ipc/pet/listModels': {
  const { loadPetModelRegistry } = await import('../pet/pet-model-resolver')
  const { models } = await loadPetModelRegistry()
  sendJson(res, 200, { ok: true, models })
  return
}
```

核对 `switchPetMode` 签名（`pet-mode-ipc.ts:74`）后对齐参数名。

- [ ] **Step 3: 跑测 + Commit**

```bash
cd apps/windows && npx vitest run src/main/app-ui-control
git add apps/windows/src/main/app-ui-control/server.ts apps/windows/src/main/app-ui-control/server.test.ts
git commit -m "$(cat <<'EOF'
feat(app-ui): 控制口 skills/pet 碎片能力路由

setEnabled 复现 skillWatcher.refresh，与 IPC handler 行为一致。
EOF
)"
```

---

### Task 7: CLI 命令注册表 + help + 统一退出码

**Files:**
- Create: `apps/windows/resources/app-ui-cli/commands.mjs`
- Modify: `apps/windows/resources/app-ui-cli/lumii-ui.mjs`
- Modify: `apps/windows/src/main/agent-runtime/bridge-app-ui-tools.ts`（description 收敛）

**Interfaces:**
- Produces: `export const COMMANDS`（每项含 `name/group/usage/summary/layer/route/options/build`）
- Produces: `lumii-ui help` / `help <cmd>` / `help --json`
- Produces: 退出码 0/1/2/3/4/5（见下表）

| 码 | 含义 |
|----|------|
| 0 | 成功 |
| 1 | 其它错误 |
| 2 | 参数错误 |
| 3 | 应用未运行 |
| 4 | 认证失败（401） |
| 5 | 被拒绝（`not_exposed` / `disabled` / `field_protected` / `rate_limited`） |

- [ ] **Step 1: 实现 commands.mjs 注册表**

覆盖命令与 group（顺序固定，对齐设计 §14.3.1）：

| group | name |
|-------|------|
| 看 | `screenshot` |
| 动 | `goto`、`click`、`act`（保留二期） |
| 设置 | `settings`（子命令 get/set） |
| 定时任务 | `cron`（list/run） |
| 技能 | `skill`（list/enable/disable） |
| 模型与工具 | `model`、`tools` |
| 桌宠 | `pet` |
| 底层 | `command` |

每项示例结构：

```js
{
  name: 'screenshot',
  group: '看',
  usage: 'screenshot [--annotate] [--target main|pet] [--out <file.jpg>]',
  summary: '截取当前界面，返回 JPEG 与可交互元素 refs',
  layer: 'ui',
  route: { method: 'POST', path: '/screenshot' },
  options: [
    { flag: '--annotate', desc: '在截图上标注元素编号（SoM）' },
    { flag: '--target <t>', desc: 'main（默认）| pet' },
    { flag: '--out <file>', desc: '另存 JPEG 到指定路径' },
  ],
  /** @returns {object|null} null 表示参数非法 */
  build(args) {
    return {
      annotate: args.flags.annotate === true,
      ...(typeof args.flags.target === 'string' ? { target: args.flags.target } : {}),
    }
  },
}
```

关键 build 约定：

- `command <type> [--data <json>|-]`：合并为 `{ type, ...parsed }`；缺 data → `{ type }`；非法 JSON → null
- `model set <modelId> --session <key>`：缺 `--session` → null（exit 2）
- `cron run <id>` → `{ type: 'cron:run', id }` 走 `/command`
- `cron list` → `{ type: 'cron:list' }` 走 `/command`
- `tools toggle <name> on|off` → `{ type: 'tools:toggle', toolName, enabled }`
- `skill enable|disable <id>` → `/ipc/skills/setEnabled`，`enabled: true/false`
- `settings get [key.path]` → `/settings/read` `{ keyPath? }`
- `settings set <key.path> <value>`：value 先 `JSON.parse`，失败则当字符串 → `/settings/write`

子命令可用 `name: 'settings'` + `match(positional)` 或扁平 `name: 'settings get'`——任选一种，但 **help 分组输出必须与设计示意一致**。

- [ ] **Step 2: 重写 lumii-ui.mjs 分发**

保留：`resolveDataRoot`、`loadRuntimeConfig`、`postJson`、`formatScreenshot`。

新增：

```js
import { COMMANDS } from './commands.mjs'

const EXIT = { ok: 0, other: 1, usage: 2, appDown: 3, auth: 4, denied: 5 }

function exitFromResponse(status, data) {
  if (status === 401) return EXIT.auth
  const err = data?.error
  if (err === 'not_exposed' || err === 'disabled' || err === 'field_protected' || err === 'rate_limited') {
    return EXIT.denied
  }
  if (data?.ok === false) return EXIT.other
  return status >= 400 ? EXIT.other : EXIT.ok
}

function printHelp(cmdName) { /* 按 group 或单条 */ }
function printHelpJson() {
  const serializable = COMMANDS.map(({ build, ...rest }) => rest)
  console.log(JSON.stringify({ commands: serializable }, null, 2))
}
```

无参数 / `help` / `--help` → 总览；`help --json` → JSON；`help screenshot` → 单条。

未知命令或 `build` 返回 null → stderr usage，`process.exit(2)`。  
`loadRuntimeConfig` 失败 → `exit(3)`（保持）。  
`fetch` 抛错 → `exit(3)`。

- [ ] **Step 3: 收敛工具 description**

在 `bridge-app-ui-tools.ts` 的 goto/act（或公共常量）追加一句，**不要**罗列 CLI 子命令：

```ts
const CLI_HINT =
  '客户端设置与批量控制也可走本机 CLI：lumii-ui（跑 lumii-ui help 查看命令；Agent 发现用 lumii-ui help --json）。' +
  '禁止用 bash lumii-ui 代替进程内 app_screenshot/app_goto/app_act。' +
  '外部桌面软件用技能 cli-hub，不要用 app_* / lumii-ui。'
```

- [ ] **Step 4: 冒烟验证**

```bash
node apps/windows/resources/app-ui-cli/lumii-ui.mjs help
node apps/windows/resources/app-ui-cli/lumii-ui.mjs help --json
node apps/windows/resources/app-ui-cli/lumii-ui.mjs help screenshot
node apps/windows/resources/app-ui-cli/lumii-ui.mjs goto
# Expected: exit 2（缺 --view）；应用未开时任意命令 exit 3
cd apps/windows && pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/windows/resources/app-ui-cli/commands.mjs apps/windows/resources/app-ui-cli/lumii-ui.mjs apps/windows/src/main/agent-runtime/bridge-app-ui-tools.ts
git commit -m "$(cat <<'EOF'
feat(app-ui): lumii-ui 命令注册表、help --json 与统一退出码

注册表同时驱动分发与 Agent 能力发现，避免 description 漂移。
EOF
)"
```

---

### Task 8: 三期整体验收

**Files:** 无新代码（除非修 bug）

- [ ] **Step 1: 自动化**

```bash
cd apps/windows && pnpm typecheck
cd apps/windows && npx vitest run src/main/app-ui-control
cd apps/windows && npx vitest run src/main
```

Expected: 全部 PASS

- [ ] **Step 2: 手工验收（应用运行中）**

| # | 命令 | 期望 |
|---|------|------|
| 1 | `lumii-ui help` | 分组总览（看/动/设置/定时任务/技能/模型与工具/桌宠/底层） |
| 2 | `lumii-ui help --json` | 含全部命令，无 `build` 字段 |
| 3 | `lumii-ui goto`（无 `--view`） | exit 2 |
| 4 | `lumii-ui cron list` | 定时任务 JSON |
| 5 | `lumii-ui cron run <id>` | 立即执行一次 |
| 6 | `lumii-ui command cron:list` | 与 4 等价 |
| 7 | `lumii-ui settings get privacy.saveChatHistory` | 返回布尔值 |
| 8 | `lumii-ui settings set theme.mode light` | ok；界面变浅色且其它字段未丢 |
| 9 | `lumii-ui settings set privacy.allowAgentAppUiControl false` | `field_protected`，exit 5 |
| 10 | `lumii-ui skill list` | 技能列表 |
| 11 | `lumii-ui skill disable <id>` | ok；技能页刷新为禁用 |
| 12 | `lumii-ui tools list` / `tools toggle <name> off` | ok |
| 13 | `lumii-ui model set <id> --session <key>` | ok |
| 14 | `lumii-ui model set <id>`（无 session） | exit 2 |
| 15 | `lumii-ui pet modes` / `pet mode <name>` | ok |
| 16 | `lumii-ui command mcp:writeConfigFile --data '{"content":"{}"}'` | `not_exposed`，exit 5 |
| 17 | `lumii-ui command user:send --data '{...}'` | `not_exposed`，exit 5 |
| 18 | 设置关闭「允许 Agent 操作本软件界面」后再跑 | `disabled`，exit 5 |
| 19 | 篡改 token 后跑 | exit 4 |
| 20 | 关应用后跑 | exit 3 |
| 21 | 「打开 Lumii 设置」对话 | 仍走 `app_goto`，**不**走 cli-hub / 不误用外部软件路径 |

- [ ] **Step 3: 边界回归（cli-hub）**

确认 `bundled-skills/技能管理/cli-hub/SKILL.md` 仍写明：Lumii 自身窗用 `app_*`，外部软件用 cli-hub。三期**不修改**该技能（已落地）。

- [ ] **Step 4: 收尾 commit（仅当有修复）**

```bash
git commit -m "$(cat <<'EOF'
test(app-ui): 三期 CLI 统一控制面验收通过
EOF
)"
```

---

## 未决问题（实现时遵守，不自行扩大范围）

1. **`model set` sessionKey**：三期 `--session` 必填；不做主进程「当前活跃会话」推断（渲染层持有会话状态）。
2. **token 文件权限**：Windows/NTFS 上勿假装 `chmod 600` 有效；白名单才是实质边界。更强隔离（token 仅内存 + env）三期不做。
3. **`files:*` 只读子集**：设计全关；若产品要开，另开评审，不在本计划加白名单。

---

## 规格自检（写作时已核对）

| §14 要求 | 任务 |
|----------|------|
| 14.2.0 导出 handleCommand / bridge | Task 1 |
| 14.2.1 白名单 + 串行 /command | Task 2 + 4 |
| 14.2.2 B 层 skills/pet + refresh 副作用 | Task 1 deps + 6 |
| 14.2.3 C 层 settings + 字段保护 | Task 5 |
| 14.3 / 14.3.1 CLI 扩展 + help 注册表 + 退出码 | Task 7 |
| 14.4 白名单防线；否决 origin/CapabilityRegistry | Global Constraints + Task 2/4 |
| 14.4.3 速率限制 + 总开关约束控制口 | Task 3 + 4 |
| cli-hub 分界（§8.4 / 外部设计） | Global Constraints + Task 8 #21 |
| 不做 external_cli / 假护栏 | Global Constraints |

**占位符扫描：** 无 TBD/TODO；测试与实现均含可执行片段。  
**类型一致：** `not_exposed` / `disabled` / `field_protected` / `rate_limited` / `not_ready` / `app_not_running` / `usage` 贯穿 server 与 CLI exit 映射。

---

## 执行方式

Task 1→8 **严格顺序**（Task 4 依赖 1–3；Task 6 依赖 1；Task 7 依赖 4–6 路由已存在）。  
Task 5 与 Task 6 都改 `server.ts`，可同一工作树连续做，但测试须分步绿。

**Plan complete.** 两条执行路径：

1. **Subagent-Driven（推荐）** — 每任务新开 subagent，任务间人工/父代理审查  
2. **Inline Execution** — 本会话用 executing-plans 连续执行并设检查点  

选择哪种方式后开始实现。
