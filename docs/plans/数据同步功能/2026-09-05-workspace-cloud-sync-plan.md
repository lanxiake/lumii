# 工作空间云同步（GitCode）开发计划

- 日期：2026-09-05
- 关联设计：`docs/design/数据同步功能/2026-09-05-workspace-cloud-sync-design.md`
- 作用范围：`apps/windows/src/main/cloud-sync/`（新增）+ 少量既有文件接线
- 原则：小步验证，每步可单独跑通；复用 workspace-vcs，不新建仓库/忽略规则/文件遍历

---

## 0. 与设计目标的对应

| 设计文档结论 | 本计划落地位置 |
|---|---|
| 复用现有 workspace 仓库，不新建 | §3 `getGitParams()` 暴露 isomorphic-git 参数，云同步直接操作同一 repo |
| 排除 projects/temp/.gitignore | 现有 `vcs-ignore.ts` 已满足，零新增（仅确认复用） |
| 后台静默同步 | §8 定时 + Turn 快照防抖，全静默，不弹窗 |
| 冲突交给 Agent | §9 `resolve_sync_conflict` 工具 + 冲突通知 |
| GitCode 优先，预留扩展 | §6 `GitProvider` 接口 + 注册表 |
| token 加密落盘 | §5 复用 provider-config safeStorage 模式 |

---

## 1. 现状调研结论（决定接线方式的关键事实）

以下为代码调研后确认的既有能力，直接复用，不在云同步模块里重复实现：

1. **共享仓库实例**：`workspace-vcs/vcs-snapshot.ts:84` 的 `getWorkspaceVcs(workspaceDir)` 按目录缓存 `WorkspaceVcs` 实例，并维护 per-workspace 串行队列。云同步必须走它，避免与 Turn 快照并发撕裂仓库。
2. **本地提交去重**：`vcs-repo.ts:225` `commit()` 无变更返回 `null`，不产生空提交。
3. **忽略规则已完备**：`vcs-ignore.ts` 的 `.gitignore`（`projects/`、`temp/`、`node_modules/`、`uploads/**` 大文件）与 `shouldSkipWalkDir`（遍历阶段剪枝）已满足需求里"排除 projects、temp、.gitignore 排除项"全部要求。
4. **配置双轨制**：`ConfigManager` 管 `app.json`（不含密钥）；`provider-config.ts` 管 `provider.json`（含 safeStorage 加密密钥）。云同步配置含 token，**走 provider 模式**，独立 `cloud-sync.json`，不塞进 AppConfig。
5. **IPC 三件套**：`ipc/*-ipc.ts` 的 `setXxxIpcDeps` + `registerXxxIpcHandlers`，在 `ipc/ipc-handlers-registry.ts` 的 `registerAllIpcHandlers` 里接线；preload 侧 `api/*.ts` + `api/index.ts` + `preload/index.ts` 三处同步。
6. **事件推送**：preload 已有 `createEventListener`（`preload/index.ts:1159`），渲染侧订阅 `onXxx(cb) => 取消函数` 模式已成熟（参照 `autonomousApi`、`updater`）。
7. **Agent 通知通道**：`getAgentRuntimeBridge()` 从 `ipc/agent-runtime-ipc.ts:504` 可拿 bridge；autonomous-ipc 已有 `notifyAutonomousGoalApproved` 注入模式可参照。
8. **日志**：`main/logger.ts` 的 `createLogger(namespace)`，中文消息 + `[函数名]` 前缀（符合 coding-style 规范）。
9. **设置页**：`SettingsPage.tsx` 的 `CATEGORIES` + `renderCategoryContent` switch；分类类型 `MergedSettingsCategory` 定义在 `components/SettingsHub/types.ts:20`。

---

## 2. 模块结构

```
apps/windows/src/main/cloud-sync/
├── types.ts              # CloudSyncConfig / SyncState / SyncStatus / ConflictInfo
├── git-provider.ts       # GitProvider 接口 + 注册表 getProvider()
├── gitcode-provider.ts   # GitCode 实现（本期唯一）
├── sync-config.ts        # 配置读写 + token safeStorage 加密（照 provider-config 模式）
├── sync-manager.ts       # 同步主流程（唯一有分支逻辑的模块）
├── sync-scheduler.ts     # 定时 + 变更防抖触发
└── sync-ipc.ts           # 设置页 IPC + 状态推送

apps/windows/src/main/workspace-vcs/vcs-repo.ts   # 改：加 getGitParams() 公开访问器
apps/windows/src/main/agent-runtime/bridge-tool-registrar-sync.ts  # 新增：resolve_sync_conflict 工具
```

不建新目录层级，不抽通用库。同步只跑在主进程（无渲染进程逻辑，UI 只读状态）。

---

## 3. workspace-vcs 最小改动（第 1 步）

`WorkspaceVcs` 的三个字段 `gitfs` / `workspaceDir` / `gitdir` 是 private。云同步要操作同一个 repo 的 remote/fetch/merge/push，需要 isomorphic-git 的 `{ fs, dir, gitdir }` 三元组。用 bracket hack（`vcs['gitfs']`）是编译期技巧，不干净。加一个公开访问器：

```ts
// vcs-repo.ts 新增（约 6 行）
/** 供云同步复用同一仓库实例的 isomorphic-git 通用参数 */
getGitParams(): { fs: PromiseFsClient; dir: string; gitdir: string } {
  return { fs: this.gitfs, dir: this.workspaceDir, gitdir: this.gitdir }
}
```

> 唯一改动。不动 commit/merge 之外的任何现有逻辑。isomorphic-git 的 remote/fetch/merge/push 都在 cloud-sync 里做，不污染 VCS 类。

**验证**：现有 `vcs-repo.test.ts` 全绿 + 新增一条断言 getGitParams 返回路径正确。

---

## 4. 类型定义

```ts
// cloud-sync/types.ts
export type GitProviderType = 'gitcode' | 'github' | 'gitee'

export interface CloudSyncConfig {
  enabled: boolean
  provider: GitProviderType
  repoUrl: string          // 形如 https://gitcode.com/<user>/<repo>.git
  branch: string           // 默认 'main'
  intervalMinutes: number  // 静默同步间隔，默认 15
  /** 持久化时为 safeStorage 密文（或 plain: 前缀明文兜底），绝不明文落盘 */
  tokenEnc?: string
}

/** 渲染进程可见视图：token 只给掩码，不回传明文 */
export interface CloudSyncConfigView extends Omit<CloudSyncConfig, 'tokenEnc'> {
  tokenMasked: string
  workspaceDir: string
}

export type SyncState = 'idle' | 'syncing' | 'conflict' | 'error'

export interface SyncStatus {
  state: SyncState
  lastSyncAt?: number
  lastError?: string
  message?: string
  conflict?: ConflictInfo
}

export interface ConflictInfo {
  files: string[]
  localOid: string
  remoteOid: string
  baseOid: string
}
```

---

## 5. 配置读写（第 1 步）

独立文件 `~/.lumii/config/cloud-sync.json`，照 `provider-config.ts:159` 的加解密模式：

```ts
// cloud-sync/sync-config.ts
import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import { resolveWindowsClientDataRoot } from '../client-data-root'

const CONFIG_FILE = () => path.join(resolveWindowsClientDataRoot(), 'config', 'cloud-sync.json')

export const DEFAULT_CLOUD_SYNC_CONFIG: CloudSyncConfig = {
  enabled: false, provider: 'gitcode', repoUrl: '', branch: 'main', intervalMinutes: 15,
}

function encryptToken(token: string): string {
  if (!token) return ''
  if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(token).toString('base64')
  return `plain:${token}`
}
function decryptToken(enc?: string): string {
  if (!enc) return ''
  if (enc.startsWith('plain:')) return enc.slice(6)
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')) } catch { return '' }
}

export function loadCloudSyncConfig(): CloudSyncConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf-8')) as Partial<CloudSyncConfig>
    return { ...DEFAULT_CLOUD_SYNC_CONFIG, ...raw }
  } catch { return { ...DEFAULT_CLOUD_SYNC_CONFIG } }
}

export function saveCloudSyncConfig(cfg: CloudSyncConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_FILE()), { recursive: true })
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify(cfg, null, 2), 'utf-8')
}

export function toConfigView(cfg: CloudSyncConfig): CloudSyncConfigView {
  const token = decryptToken(cfg.tokenEnc)
  const masked = token.length <= 4 ? (token ? '****' : '') : `${token.slice(0, 4)}****${token.slice(-4)}`
  return { enabled: cfg.enabled, provider: cfg.provider, repoUrl: cfg.repoUrl,
           branch: cfg.branch, intervalMinutes: cfg.intervalMinutes,
           tokenMasked: masked, workspaceDir: '' /* 由 IPC 填充 */ }
}
```

> 与 provider-config 的差异：只有 `enabled/provider/repoUrl/branch/intervalMinutes/tokenEnc` 六个字段，无迁移逻辑（新功能无旧数据）。加解密函数 8 行，直接复制，不抽公共 crypto 模块——只有两个调用方时抽象是过度设计。

**验证**：`sync-config.test.ts` —— token 加解密往返、`plain:` 兜底、缺文件返回默认值。

---

## 6. 提供商抽象（第 2 步）

接口按"平台间真实差异"收窄——三家在 isomorphic-git 视角只差认证头拼法与 URL 校验，不做泛化 SDK 层：

```ts
// cloud-sync/git-provider.ts
import type { GitProviderType } from './types'

export interface GitProvider {
  readonly type: GitProviderType
  /** isomorphic-git onAuth 回调返回值 */
  auth(token: string): { username: string; password: string }
  /** 校验 repoUrl 是否属于本平台，返回人话错误 */
  validateUrl(repoUrl: string): { ok: true } | { ok: false; error: string }
}

// cloud-sync/gitcode-provider.ts
export const gitcodeProvider: GitProvider = {
  type: 'gitcode',
  auth: (token) => ({ username: token, password: 'x-oauth-basic' }),
  validateUrl: (url) =>
    /^https:\/\/gitcode\.com\/[^/]+\/[^/]+?(\.git)?$/.test(url.trim())
      ? { ok: true }
      : { ok: false, error: '仓库地址应形如 https://gitcode.com/用户名/仓库名.git' },
}

const providers: Partial<Record<GitProviderType, GitProvider>> = { gitcode: gitcodeProvider }
export function getProvider(type: GitProviderType): GitProvider {
  const p = providers[type]
  if (!p) throw new Error(`未实现的 Git 提供商: ${type}`)
  return p
}
```

**验证**：`gitcode-provider.test.ts` 测 validateUrl 接受/拒绝样例。

---

## 7. 同步主流程（第 3 步，核心）

`sync-manager.ts` 是唯一有分支逻辑的文件。复用同一 `WorkspaceVcs` 实例 + 其串行队列（防止与 Turn 快照并发撕裂仓库）。

```ts
// cloud-sync/sync-manager.ts
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import { EventEmitter } from 'node:events'
import { getWorkspaceVcs, resetWorkspaceVcs } from '../workspace-vcs/vcs-snapshot'
import { createLogger } from '../logger'
import { getProvider } from './git-provider'
import type { CloudSyncConfig, SyncState, SyncStatus, ConflictInfo } from './types'

const logger = createLogger('cloud-sync/manager')

export class CloudSyncManager extends EventEmitter {
  private cfg: CloudSyncConfig | null = null
  private state: SyncState = 'idle'
  private status: SyncStatus = { state: 'idle' }

  constructor(private workspaceDir: string) {
    super()
    // workspace 切换时由外部调用 reset，下轮 sync 用新目录
  }

  setConfig(cfg: CloudSyncConfig): void { this.cfg = cfg }

  getStatus(): SyncStatus { return this.status }

  getConflict(): ConflictInfo | undefined { return this.status.conflict }

  /** 唯一同步入口，进程内串行；syncing 期间重入直接返回 */
  async sync(): Promise<{ success: boolean; state: SyncState }> {
    const cfg = this.cfg
    if (!cfg?.enabled || !cfg.repoUrl || !cfg.tokenEnc) {
      this.emit('status', { state: 'idle', message: '云同步未启用' })
      return { success: false, state: 'idle' }
    }
    if (this.state === 'conflict') {
      // 冲突未解决不重试，避免反复 merge 刷日志
      return { success: false, state: 'conflict' }
    }
    if (this.state === 'syncing') return { success: false, state: 'syncing' }

    this.setState('syncing', '开始同步')
    try {
      const repo = getWorkspaceVcs(this.workspaceDir)
      const p = repo.getGitParams()
      const provider = getProvider(cfg.provider)
      const auth = () => provider.auth(decryptToken(cfg.tokenEnc))
      const url = cfg.repoUrl.trim()
      const branch = cfg.branch || 'main'

      // 1. 本地未提交变更先落成 commit
      await repo.ensureInitialized()
      await repo.commit({ author: 'user', message: '云同步自动提交' })

      // 2. 确保 remote origin（URL 变更时先删后加）
      await this.ensureRemote(p, url)

      // 3. fetch 远程（远程分支不存在 → 视为首推）
      let remoteOid: string | null
      try {
        await git.fetch({ ...p, http, remote: 'origin', ref: branch, onAuth: auth })
        remoteOid = await git.resolveRef({ ...p, ref: `refs/remotes/origin/${branch}` })
      } catch {
        remoteOid = null // 首推
      }

      // 4. 判定 commit 图关系
      const localOid = await git.resolveRef({ ...p, ref: 'HEAD' })
      if (remoteOid !== null) {
        if (remoteOid === localOid) {
          this.setState('idle', '已是最新')
          return { success: true, state: 'idle' }
        }
        const base = await git.findMergeBase({ ...p, refs: [localOid, remoteOid] })
        if (base === remoteOid) {
          // 仅本地新 → 直接 push
        } else if (base === localOid) {
          // 仅远程新 → fast-forward，无需 push
          await git.fastForward({ ...p, ref: 'HEAD', remote: `refs/remotes/origin/${branch}` })
          this.setState('idle', '已拉取远程变更')
          return { success: true, state: 'idle' }
        } else {
          // 双方都新 → 尝试 merge
          await git.merge({
            ...p, ours: 'HEAD', theirs: `refs/remotes/origin/${branch}`,
            author: { name: 'Lumii CloudSync', email: 'sync@lumii.local' },
            message: '合并远程变更',
          })
        }
      }

      // 5. push（被拒不强推，下个周期重来）
      try {
        await git.push({ ...p, http, remote: 'origin', ref: branch, onAuth: auth })
      } catch (err) {
        if (this.isRejectedPush(err)) {
          logger.warn('[sync] 远程有更新，下轮重试')
          this.setState('idle', '远程有更新，等待下轮同步')
          return { success: false, state: 'idle' }
        }
        throw err
      }

      this.setState('idle', '同步完成')
      return { success: true, state: 'idle' }
    } catch (err) {
      // git.merge 抛 MergeConflictError → 冲突态
      if (this.isMergeConflict(err)) {
        return this.enterConflict(err)
      }
      const reason = err instanceof Error ? err.message : String(err)
      logger.error(`[sync] 同步失败: ${this.sanitize(reason)}`)
      this.setState('error', reason)
      return { success: false, state: 'error' }
    }
  }
}
```

关键决策（对齐设计文档）：

- **先 commit 再 fetch**：本地脏工作区先落 commit，后续判断全在 commit 图上做。
- **永不 force**：`isRejectedPush`（错误含 `[rejected]` / `non-fast-forward`）→ 记日志等下轮。
- **冲突态阻断**：`state==='conflict'` 时 `sync()` 直接返回，等 Agent 落决。
- **token 解密只在 manager 内部**：`decryptToken` 不导出，配置模块只回传掩码。

### 冲突进入（enterConflict）与落决（resolveConflict）

```ts
// 同步流程外的方法
private enterConflict(err: unknown): { success: false; state: 'conflict' } {
  const p = this.getParams()
  const conflictFiles = (err as { data?: { filepaths?: string[] } }).data?.filepaths ?? []
  const info: ConflictInfo = {
    files: conflictFiles,
    localOid: this.currentOid('HEAD'),
    remoteOid: this.currentOid(`refs/remotes/origin/${this.branch}`),
    baseOid: this.currentOid('ORIG_HEAD'),
  }
  this.status.conflict = info
  this.setState('conflict', `检测到 ${conflictFiles.length} 个冲突文件，等待 Agent 处理`)
  return { success: false, state: 'conflict' }
}

/** Agent 落决：写入选定侧内容 → 提交 merge commit → push → idle */
async resolveConflict(strategy: 'keep-local' | 'keep-remote' | 'per-file', choices?: { path: string; side: 'local' | 'remote' }[]): Promise<{ success: boolean }> {
  const p = this.getParams()
  const branch = this.branch
  const remoteRef = `refs/remotes/origin/${branch}`
  const sideOid = (side: 'local' | 'remote') => side === 'local' ? 'HEAD' : remoteRef

  // 对每个冲突文件，用 git.checkout 检出指定侧内容
  const files = this.status.conflict?.files ?? []
  for (const f of files) {
    const side = strategy === 'per-file' ? (choices?.find(c => c.path === f)?.side ?? 'local') : strategy === 'keep-local' ? 'local' : 'remote'
    await git.checkout({ ...p, ref: sideOid, filepaths: [f], force: true })
  }
  // 提交 merge commit
  await git.commit({ ...p, message: `解决云同步冲突（${strategy}）`, author: { name: 'Lumii CloudSync', email: 'sync@lumii.local' }, parent: ['HEAD', remoteRef] })
  await git.push({ ...p, http, remote: 'origin', ref: branch, onAuth: this.auth() })
  this.status.conflict = undefined
  this.setState('idle', '冲突已解决')
  return { success: true }
}
```

> `baseOid` 用 `ORIG_HEAD`：merge 失败后 git 会留 ORIG_HEAD 指向分叉前，够 Agent 做三方判断。

### 公开辅助（供 IPC / Agent 工具复用）

```ts
/** 读三方任一版本的文件内容，供 Agent 判断 */
async readFileAt(oid: 'local' | 'remote' | 'base', filepath: string): Promise<string | null> {
  const ref = oid === 'local' ? 'HEAD' : oid === 'remote' ? `refs/remotes/origin/${this.branch}` : 'ORIG_HEAD'
  return getWorkspaceVcs(this.workspaceDir).readFileAt(ref, filepath)
}
```

**验证**：`sync-manager.test.ts` 用两个本地临时目录互推模拟远程，七个分支场景全绿（见 §12）。

---

## 8. 触发与调度（第 5 步）

`sync-scheduler.ts`：定时 + Turn 快照后 60 秒防抖。

```ts
// cloud-sync/sync-scheduler.ts
import { createLogger } from '../logger'
import type { CloudSyncManager } from './sync-manager'

const logger = createLogger('cloud-sync/scheduler')

export class SyncScheduler {
  private timer: NodeJS.Timeout | null = null
  private debounceTimer: NodeJS.Timeout | null = null

  constructor(private manager: CloudSyncManager) {}

  start(cfg: { enabled: boolean; intervalMinutes: number }): void {
    this.stop()
    if (!cfg.enabled) return
    // 启动 30 秒后首同步，避开冷启动争抢（README 已记录冷启 3–5s）
    this.timer = setInterval(() => void this.tick(), cfg.intervalMinutes * 60_000)
    setTimeout(() => void this.tick(), 30_000)
    logger.info(`[start] 静默同步已启动, interval=${cfg.intervalMinutes}min`)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.timer = this.debounceTimer = null
  }

  /** Turn 快照后调用：60 秒防抖合并频繁变更 */
  onWorkspaceChanged(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => void this.tick(), 60_000)
  }

  private async tick(): Promise<void> {
    try {
      await this.manager.sync()
    } catch (err) {
      logger.error(`[tick] 同步异常: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
```

> 触发源只有两个：定时 + Turn 快照防抖。不用 `fs.watch`（设计文档 §8 已论证：工作空间写入都走 Agent 工具，Turn 快照就是天然变更信号）。

**接线点**：`maybeSnapshot`（`vcs-snapshot.ts:50`）成功返回 commit 后调用 `scheduler.onWorkspaceChanged()`。在 Turn 快照调用处（`main/index.ts` 或 bridge 侧）加一行。Scheduler 实例在 `main/index.ts` 启动时创建，随配置变更 restart。

---

## 9. Agent 冲突解决（第 6 步）

### 冲突通知（sync-manager 检测到冲突 → 唤起 Agent）

参照 `autonomous-ipc.ts:125` 的 `notifyAutonomousGoalApproved` 注入模式，新增一个轻量通知：

```ts
// agent-runtime/sync-conflict-wiring.ts（新增，约 20 行）
import { getAgentRuntimeBridge } from '../ipc/agent-runtime-ipc'

export function notifySyncConflict(info: { files: string[] }): void {
  const bridge = getAgentRuntimeBridge()
  if (!bridge) return
  // 向当前会话注入一条系统消息，触发 Agent 处理（实现细节对接 bridge 现有 dispatch）
  bridge.notifySystem(`工作空间云同步检测到冲突，涉及 ${info.files.length} 个文件，请用 resolve_sync_conflict 工具解决。`)
}
```

> 具体注入 API 以 bridge 现有暴露为准（`autonomous-wiring` 有同类先例），实施时若 bridge 无现成注入方法则退化为：设置页角标 + 主窗口通知，Agent 唤起留 P1。

### 工具注册

`bridge-tool-registrar.ts:47` 的 `registerAll()` 里加一行，工具实现放独立文件（与现有 `bridge-tool-registrar-cron` 等模式一致）：

```ts
// bridge-tool-registrar-sync.ts（新增）
import { Type } from '@sinclair/typebox'
import { createMtBotTool, type MtBotToolConfig } from '@mtbot/agent-runtime'
import { getCloudSyncManager } from '../cloud-sync/sync-accessor'
import { jsonToolResult } from './bridge-utils'

export function registerSyncConflictTool(registry: unknown, ctx: unknown): void {
  const config: MtBotToolConfig = {
    name: 'resolve_sync_conflict',
    description: '解决工作空间云同步冲突。仅在收到同步冲突通知时调用。先读取冲突文件三方内容（local/remote/base）再决定策略。',
    parameters: {
      type: 'object',
      properties: {
        strategy: { type: 'string', enum: ['keep-local', 'keep-remote', 'per-file'] },
        choices: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, side: { type: 'string', enum: ['local', 'remote'] } } } },
        reason: { type: 'string' },
      },
      required: ['strategy'],
    },
    execute: async (_id, params) => {
      const m = getCloudSyncManager()
      if (!m) return jsonToolResult({ status: 'error', message: '云同步未初始化' })
      const r = await m.resolveConflict(params.strategy, params.choices)
      return jsonToolResult({ status: r.success ? 'ok' : 'error', ...r })
    },
  }
  registry.register(createMtBotTool(config, ctx))
  logger.info('[registerSyncConflictTool] resolve_sync_conflict 已注册')
}
```

> Agent 读三方内容走 `sync-manager.readFileAt(oid, path)`，新增一个配套工具或复用现有 `vcs:readFileAt`（`vcs-ipc.ts:96` 已暴露 local HEAD 读取）。实施时优先复用 `vcs:readFileAt` + 为 remote/base 加一个只读工具，最小改动。

---

## 10. IPC 与设置页

### IPC（第 4 步）

`cloud-sync-ipc.ts`，按项目 IPC 模式（deps 注入 + 返回值 `{ success, data?, error? }`）：

```ts
// cloud-sync/sync-ipc.ts
import { ipcMain } from 'electron'
import { getCloudSyncManager } from './sync-accessor'
import { loadCloudSyncConfig, saveCloudSyncConfig, toConfigView, decryptToken } from './sync-config'

export function registerCloudSyncIpcHandlers(): void {
  ipcMain.handle('cloudSync:getConfig', () => {
    const cfg = loadCloudSyncConfig()
    const view = toConfigView(cfg)
    view.workspaceDir = getWorkspaceDir() // 从 deps 注入
    return { success: true, data: view }
  })
  ipcMain.handle('cloudSync:setConfig', (_e, view: CloudSyncConfigView) => {
    // 掩码非全星号时视为用户重新输入 token
    const token = view.tokenMasked.includes('*') ? decryptToken(loadCloudSyncConfig().tokenEnc) : view.tokenMasked
    saveCloudSyncConfig({ enabled, provider, repoUrl, branch, intervalMinutes, tokenEnc: encryptToken(token) })
    restartScheduler() // 配置变更 → 停旧启新
    return { success: true }
  })
  ipcMain.handle('cloudSync:testConnection', async (_e, view: CloudSyncConfigView) => {
    const provider = getProvider(view.provider)
    const urlOk = provider.validateUrl(view.repoUrl)
    if (!urlOk.ok) return { success: false, error: urlOk.error }
    try {
      await git.getRemoteInfo({ http, url: view.repoUrl, onAuth: () => provider.auth(token) })
      return { success: true }
    } catch (err) { return { success: false, error: sanitize(String(err)) } }
  })
  ipcMain.handle('cloudSync:getStatus', () => ({ success: true, data: manager.getStatus() }))
  ipcMain.handle('cloudSync:syncNow', async () => await manager.sync())
  ipcMain.handle('cloudSync:resolveConflict', async (_e, strategy, choices) => manager.resolveConflict(strategy, choices))
}
```

状态推送：manager 是 EventEmitter，`sync-ipc` 挂 `on('status')` → `mainWindow.webContents.send('cloudSync:status', status)`；preload 用 `createEventListener` 暴露 `onStatusChange(cb) => 取消函数`。

### preload 三处同步

1. `preload/api/cloud-sync-api.ts`（新增）：`getConfig/setConfig/testConnection/getStatus/syncNow/resolveConflict/onStatusChange`
2. `preload/api/index.ts`：加 `export { cloudSyncApi } from './cloud-sync-api'`
3. `preload/index.ts`：`ElectronAPI` 接口加 `cloudSync: typeof cloudSyncApi` + electronAPI 对象加 `cloudSync: cloudSyncApi`（参照 `autonomous` 一行式）

### 设置页

**推荐：放「工作空间」分类下**（零新增分类类型），理由：云同步就是对工作空间的同步，语义内聚；新增分类要动 `SettingsHub/types.ts:20` 联合类型 + `SettingsPage.tsx` 的 CATEGORIES + switch + Hub 导航 4 处，为时过早。

`SettingsPage.tsx` 的 `case 'workspace'` 改为并列渲染：

```tsx
case 'workspace':
  return (
    <>
      <WorkspaceSection ... />
      <div className={styles['settings-merged-block']}>
        <CloudSyncSection />
      </div>
    </>
  )
```

`CloudSyncSection`（新增组件）：provider 下拉（GitCode / GitHub·Gitee 置灰）、仓库 URL、token（password + 掩码回显）、分支、间隔、启用开关、「测试连接」「立即同步」按钮、状态行（`idle/syncing/conflict/error` + 最近成功时间）、冲突时显示冲突文件列表 + Agent 处理中提示。UI 直接复用 `components/ui/{Input,Button,Select,Checkbox,Badge}`，不新写样式系统。

---

## 11. 接线汇总（main/index.ts）

启动顺序（对照现有 `main/index.ts` 初始化序列，只加 3 处）：

1. 创建 `CloudSyncManager`（需要 workspaceDir）→ 存 `sync-accessor.ts`（与 `screen-record/accessor.ts` 同模式）
2. `registerAllIpcHandlers(deps)` 的 deps 里不新增字段（用 accessor 拿 manager），`ipc-handlers-registry.ts` 加 `registerCloudSyncIpcHandlers()`
3. 创建 `SyncScheduler` 并 `start(loadCloudSyncConfig())`
4. 配置变更（`cloudSync:setConfig`）→ `scheduler.restart(newCfg)` + `manager.setConfig(newCfg)`
5. workspace 目录变更（`workspace:setDir` / `notifyChanged`）→ `resetWorkspaceVcs()` 已存在，同步 `manager` 重建或复用（目录为构造参数，切换时重建）
6. Turn 快照钩子处（`maybeSnapshot` 调用点）加 `scheduler.onWorkspaceChanged()`

> 依赖注入统一走 `sync-accessor.ts` 单例持有，避免 `main/index.ts` 继续膨胀。这是对 README 已知债务（index.ts 3000+ 行）的让步：不往 index 里加逻辑，只加启动行。

---

## 12. 可观测性设计

### 日志（createLogger + 中文 + 函数前缀）

| 级别 | 内容 |
|---|---|
| `info` | `[sync] 开始同步`、`[sync] 同步完成`、`[sync] 已拉取远程变更`、`[scheduler] 静默同步已启动, interval=15min` |
| `warn` | `[sync] 远程有更新，下轮重试`、`[maybeSnapshot] 自动快照失败（已忽略）`（既有） |
| `error` | `[sync] 同步失败: {sanitize(reason)}`、`[tick] 同步异常: ...` |

日志脱敏：`sanitize()` 把 token 替换为 `***`（GitCode 报错常把 URL 原样回显，URL 里无 token 但 auth 失败信息可能含它）。

### 状态机（渲染侧可观测）

`SyncStatus.state` 五种态 + `message` + `lastSyncAt` + `lastError`，设置页直接渲染。冲突态带 `ConflictInfo.files`。

### 可调试性

- `cloudSync:syncNow` 手动触发，排查问题不必等 15 分钟定时。
- `getRemoteInfo` 探活给「测试连接」，先验 URL/认证再进同步流。
- 失败态保留 `lastError`（脱敏），设置页可见，不必翻日志。
- token 永不回传明文，渲染侧只看掩码，主进程日志也不落 token。

---

## 13. 可扩展性设计

| 扩展方向 | 预留位 | 说明 |
|---|---|---|
| GitHub / Gitee | `git-provider.ts` providers 注册表 | 各加一个 ~10 行实现 + 下拉解锁；认证头格式与 GitCode 一致（`{ username: token, password: 'x-oauth-basic' }`），Gitee 实施时实测确认 |
| 其他数据域同步 | 不预留结构 | 设计文档已明确 db/memories 需导出格式，属独立方案，不为它设计接口 |
| 历史压缩 | 不预留 | squash/shallow 是仓库级操作，不影响 sync-manager 结构 |
| 冲突逐字合并 | `resolveConflict` 的 strategy 枚举 | 将来加 `'agent-merged'` + `mergedContent` 入参即可 |
| 端到端加密 | 不预留 | 会改变 push 前文件内容，影响 diff 可读性，属独立方案 |

---

## 14. 测试计划

项目规范：vitest，`src/main` 同目录测试用 `npx vitest run src/main`。

### sync-manager.test.ts（核心，模拟远程不联网）

用两个本地临时目录互推模拟 GitCode 远程，真实跑 isomorphic-git：

```
├─ 仅本地有新提交 → push 成功，远程收到
├─ 仅远程有新提交 → fast-forward，本地文件更新且不 push
├─ 双方改不同文件 → 自动 merge 成功
├─ 双方改同一文件 → state='conflict'，ConflictInfo.files 正确，未 push
├─ 冲突后 resolveConflict('keep-local') → 远程内容变为本地版本
├─ 冲突后 resolveConflict('keep-remote') → 本地变为远程版本
├─ 远程分支不存在 → 首推成功
├─ state='conflict' 期间再调 sync() → 直接返回不重试
└─ push 被拒（模拟远程又变）→ 不强推，返回 idle 等下轮
```

### 其余

- `sync-config.test.ts`：token 加解密往返、plain: 兜底、缺文件默认值
- `gitcode-provider.test.ts`：validateUrl 接受/拒绝
- `vcs-repo.test.ts`：getGitParams 新增断言

---

## 15. 实施步骤（小步快跑，每步可独立验证）

| 步 | 内容 | 变更文件 | 验证命令 |
|---|---|---|---|
| 1 | getGitParams + types + sync-config | vcs-repo.ts（+6行）、cloud-sync/types.ts、sync-config.ts | `npx vitest run src/main/workspace-vcs/vcs-repo.test.ts src/main/cloud-sync/sync-config.test.ts` |
| 2 | git-provider + gitcode-provider | cloud-sync/git-provider.ts、gitcode-provider.ts | `npx vitest run src/main/cloud-sync/gitcode-provider.test.ts` + 真实 GitCode 仓库 `getRemoteInfo` 探活 |
| 3 | sync-manager（核心） | cloud-sync/sync-manager.ts、sync-accessor.ts | `npx vitest run src/main/cloud-sync/sync-manager.test.ts`（九场景） |
| 4 | sync-ipc + preload 三处 + 设置页 | sync-ipc.ts、preload/api/cloud-sync-api.ts、api/index.ts、preload/index.ts、SettingsPage.tsx、CloudSyncSection | `pnpm typecheck` + 手动「测试连接」「立即同步」真实仓库 |
| 5 | sync-scheduler + 接线 | sync-scheduler.ts、main/index.ts、ipc-handlers-registry.ts、vcs-snapshot.ts 调用点 | 两台设备（或两个数据目录）实际流转文件 |
| 6 | resolve_sync_conflict 工具 + 冲突通知 | bridge-tool-registrar-sync.ts、sync-conflict-wiring.ts、bridge-tool-registrar.ts | 人工造冲突，Agent 端到端落决 |

每步结束跑 `pnpm typecheck`（全 workspace）确认无类型回归；第 3 步后同步逻辑已有测试覆盖，可随时合入。

---

## 16. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| isomorphic-git merge 非 fast-forward 场景的兼容性 | 三方合并失败 | 已用 try/catch + findMergeBase 分流；merge 失败只进冲突态不 push，不丢数据 |
| `ORIG_HEAD` 在 merge 失败后不可用 | baseOid 缺失影响 Agent 判断 | fallback：`findMergeBase([local, remote])` 现算（manager 里已能拿） |
| GitCode 认证格式与预期不符 | 探活失败 | `testConnection` 先验；实施时用真实账号实测认证头 |
| Turn 快照与云同步并发 | 仓库撕裂 | 共用 `getWorkspaceVcs` 的 per-workspace 串行队列，天然串行 |
| 大工作区 push 慢 | 同步耗时 | 首次 clone/push 全量，后续增量；push 走异步 + 状态机，不阻塞 UI |
| token 泄漏 | 安全 | safeStorage 加密落盘 + 掩码回显 + 日志脱敏 + 永不回传明文 |
