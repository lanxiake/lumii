# 工作空间云同步（GitCode）开发计划

- 日期：2026-09-05（2026-09-06 修订）
- 关联设计：`docs/design/数据同步功能/2026-09-05-workspace-cloud-sync-design.md`
- 作用范围：`apps/windows/src/main/cloud-sync/`（新增）+ 少量既有文件接线
- 原则：小步验证，每步可单独跑通；复用 workspace-vcs，不新建仓库/忽略规则/文件遍历

> 修订记录：本版折叠了初稿评审发现的 11 项问题——无关历史建立、findMergeBase 参数、并发序列化、MergeNotSupportedError、ORIG_HEAD 移除、resolveConflict 异常保护、配置加密封装、token 显式字段、workspaceDir 惰性、ref 命名精确化、24h 冲突超时兜底。关键 API 行为已对照 isomorphic-git 1.40.0 源码核实。

---

## 0. 与设计目标的对应

| 设计文档结论 | 本计划落地位置 |
|---|---|
| 复用现有 workspace 仓库，不新建 | §3 `getGitParams()` + `enqueueWorkspace()`，云同步操作同一 repo 且与快照串行 |
| 排除 projects/temp/.gitignore | 现有 `vcs-ignore.ts` 已满足，零新增（仅确认复用） |
| 后台静默同步 | §8 定时 + Turn 快照防抖，全静默，不弹窗 |
| 冲突交给 Agent | §9 `resolve_sync_conflict` 工具 + 冲突通知 + §8 24h 超时兜底 |
| GitCode 优先，预留扩展 | §6 `GitProvider` 接口 + 注册表 |
| token 加密落盘 | §5 `sync-config.ts` 封装 safeStorage，IPC 层不碰密文 |

---

## 1. 现状调研结论（决定接线方式的关键事实）

以下为代码调研后确认的既有能力，直接复用，不在云同步模块里重复实现：

1. **共享仓库实例**：`workspace-vcs/vcs-snapshot.ts:84` 的 `getWorkspaceVcs(workspaceDir)` 按目录缓存 `WorkspaceVcs` 实例，并维护 per-workspace 串行队列。云同步必须走它，避免与 Turn 快照并发撕裂仓库。
2. **本地提交去重**：`vcs-repo.ts:225` `commit()` 无变更返回 `null`，不产生空提交。
3. **忽略规则已完备**：`vcs-ignore.ts` 的 `.gitignore`（`projects/`、`temp/`、`node_modules/`、`uploads/**` 大文件）与 `shouldSkipWalkDir` 已满足需求全部排除要求。
4. **配置双轨制**：`ConfigManager` 管 `app.json`（不含密钥）；`provider-config.ts` 管 `provider.json`（safeStorage 加密）。云同步配置含 token，走 provider 模式，独立 `cloud-sync.json`。
5. **IPC 三件套**：`ipc/*-ipc.ts` 的 `setXxxIpcDeps` + `registerXxxIpcHandlers`，在 `ipc-handlers-registry.ts` 接线；preload 侧 `api/*.ts` + `api/index.ts` + `preload/index.ts` 三处同步。
6. **事件推送**：preload 已有 `createEventListener`（`preload/index.ts:1159`），`onXxx(cb) => 取消函数` 模式成熟（参照 `autonomousApi`、`updater`）。
7. **Agent 通知通道**：`getAgentRuntimeBridge()` 从 `ipc/agent-runtime-ipc.ts:504` 可拿 bridge；autonomous-ipc 已有 `notifyAutonomousGoalApproved` 注入模式可参照。
8. **日志**：`main/logger.ts` 的 `createLogger(namespace)`，中文消息 + `[函数名]` 前缀。
9. **设置页**：`SettingsPage.tsx` 的 `CATEGORIES` + `renderCategoryContent` switch；分类类型 `MergedSettingsCategory` 在 `components/SettingsHub/types.ts:20`。

### 1.1 isomorphic-git 关键 API 事实（已核对 1.40.0 源码）

以下事实决定冲突与首同步的实现，**不要按 git CLI 的直觉写**：

| 事实 | 源码位置 | 影响 |
|---|---|---|
| `findMergeBase` 入参是 `oids: string[]`，返回**数组** | `index.d.ts:1574` | 不能写 `refs`，且要处理 `length !== 1` |
| `merge` 默认 `abortOnConflict: true` 时，标准文件冲突**仍抛 `MergeConflictError` 且带 `data.filepaths`，工作树保持干净** | `index.js:8143`、`11196` | 冲突探测干净无副作用 |
| `MergeConflictError.data = { filepaths, bothModified, deleteByUs, deleteByTheirs }` | `index.d.ts:4194` | Agent 三方判断的信息源 |
| add/add、rename、criss-cross（多 base）抛 `MergeNotSupportedError`（`data` 为空） | `index.js:8078`、`11147` | 需单独 catch，降级 error 态 |
| **无 `git.reset`**（只有 `resetIndex`），有 `git.writeRef` / `git.checkout` | `index.d.ts:3867`、`1046` | 无关历史建 lineage 用 `writeRef + checkout` |
| `merge` 不支持递归合并策略，多 base 直接失败 | `index.d.ts:2230` | criss-cross 需人工 |
| 无 `ORIG_HEAD` 维护 | 全库无写点 | baseOid 只能来自 `findMergeBase` |

---

## 2. 模块结构

```
apps/windows/src/main/cloud-sync/
├── types.ts              # CloudSyncConfig / SyncState / SyncStatus / ConflictInfo
├── git-provider.ts       # GitProvider 接口 + 注册表 getProvider()
├── gitcode-provider.ts   # GitCode 实现（本期唯一）
├── sync-config.ts        # 配置读写 + token safeStorage 加密（唯一接触密文处）
├── sync-manager.ts       # 同步主流程（唯一有分支逻辑的模块）
├── sync-scheduler.ts     # 定时 + 变更防抖 + 24h 冲突超时
└── sync-ipc.ts           # 设置页 IPC + 状态推送

apps/windows/src/main/workspace-vcs/vcs-snapshot.ts  # 改：导出 enqueueWorkspace()
apps/windows/src/main/workspace-vcs/vcs-repo.ts      # 改：加 getGitParams() 公开访问器
apps/windows/src/main/agent-runtime/bridge-tool-registrar-sync.ts  # 新增：resolve_sync_conflict 工具
```

---

## 3. workspace-vcs 两处最小改动（第 1 步）

### 3.1 getGitParams 公开访问器

`WorkspaceVcs` 的 `gitfs`/`workspaceDir`/`gitdir` 是 private，云同步要操作同一 repo 需要 isomorphic-git 三元组：

```ts
// vcs-repo.ts 新增（约 6 行）
/** 供云同步复用同一仓库实例的 isomorphic-git 通用参数 */
getGitParams(): { fs: PromiseFsClient; dir: string; gitdir: string } {
  return { fs: this.gitfs, dir: this.workspaceDir, gitdir: this.gitdir }
}
```

### 3.2 导出串行队列（修并发丢提交问题）

Turn 快照 `maybeSnapshot()` 走 `vcs-snapshot.ts` 的 per-workspace 队列 `enqueue()`，但 sync 的 git 操作直接调 isomorphic-git 会与快照的 `repo.commit()` 交错——两者都读 `HEAD=O` 各自 commit，last-writer-wins 会**静默丢一个提交**。修正：导出队列，让 sync 也走同一队列。

```ts
// vcs-snapshot.ts 新增（约 3 行，把内部 enqueue 暴露）
export function enqueueWorkspace<T>(workspaceDir: string, task: () => Promise<T>): Promise<T> {
  return enqueue(workspaceDir, task)
}
```

sync-manager 的整个 `sync()` / `resolveConflict()` 函数体包进 `enqueueWorkspace`，与 Turn 快照互斥。

---

## 4. 类型定义

```ts
// cloud-sync/types.ts
export type GitProviderType = 'gitcode' | 'github' | 'gitee'

export interface CloudSyncConfig {
  enabled: boolean
  provider: GitProviderType
  repoUrl: string          // https://gitcode.com/<user>/<repo>.git
  branch: string           // 默认 'main'
  intervalMinutes: number  // 默认 15
  tokenEnc?: string        // safeStorage 密文（或 plain: 前缀明文兜底），绝不明文落盘
}

/** 渲染进程可见视图 */
export interface CloudSyncConfigView {
  enabled: boolean
  provider: GitProviderType
  repoUrl: string
  branch: string
  intervalMinutes: number
  /** 仅 setConfig 时填写；空串/缺省 = 沿用已保存 token（显式语义，不靠掩码反推） */
  token?: string
  tokenMasked: string      // 只读回显，形如 ghp_****abcd
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
  files: string[]          // 来自 MergeConflictError.data.filepaths
  bothModified: string[]
  deleteByUs: string[]
  deleteByTheirs: string[]
  localOid: string
  remoteOid: string
  baseOid: string          // 来自 findMergeBase 结果，一路传下来，不读 ORIG_HEAD
}
```

---

## 5. 配置读写（第 1 步）

独立文件 `~/.lumii/config/cloud-sync.json`，照 `provider-config.ts:159` 加解密模式。**所有加密逻辑集中在本模块，IPC/manager 层不直接操作密文**。

```ts
// cloud-sync/sync-config.ts
import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import { resolveWindowsClientDataRoot } from '../client-data-root'
import type { CloudSyncConfig, CloudSyncConfigView } from './types'

const CONFIG_FILE = () => path.join(resolveWindowsClientDataRoot(), 'config', 'cloud-sync.json')

export const DEFAULT_CLOUD_SYNC_CONFIG: CloudSyncConfig = {
  enabled: false, provider: 'gitcode', repoUrl: '', branch: 'main', intervalMinutes: 15,
}

function encryptToken(token: string): string {
  if (!token) return ''
  if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(token).toString('base64')
  return `plain:${token}`
}

/** 仅主进程内部使用（testConnection / sync onAuth 需明文），绝不经 IPC 返回渲染层 */
export function decryptToken(enc?: string): string {
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

/** 从视图保存：token 显式语义，空串沿用旧值 */
export function saveConfigFromView(view: CloudSyncConfigView): CloudSyncConfig {
  const cur = loadCloudSyncConfig()
  const tokenEnc = view.token && view.token.trim() !== '' ? encryptToken(view.token) : cur.tokenEnc
  const next: CloudSyncConfig = {
    enabled: view.enabled, provider: view.provider, repoUrl: view.repoUrl.trim(),
    branch: view.branch || 'main', intervalMinutes: view.intervalMinutes, tokenEnc,
  }
  fs.mkdirSync(path.dirname(CONFIG_FILE()), { recursive: true })
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify(next, null, 2), 'utf-8')
  return next
}

/** 只读回显视图（token 掩码），workspaceDir 由 IPC 层填充 */
export function toConfigView(cfg: CloudSyncConfig): CloudSyncConfigView {
  const token = decryptToken(cfg.tokenEnc)
  const masked = token.length <= 4 ? (token ? '****' : '') : `${token.slice(0, 4)}****${token.slice(-4)}`
  return {
    enabled: cfg.enabled, provider: cfg.provider, repoUrl: cfg.repoUrl,
    branch: cfg.branch, intervalMinutes: cfg.intervalMinutes,
    tokenMasked: masked, workspaceDir: '',
  }
}
```

> `decryptToken` 导出仅供主进程 sync-manager / IPC 内部使用；渲染层只看到 `tokenMasked`。

**验证**：`sync-config.test.ts` —— token 加解密往返、`plain:` 兜底、缺文件默认值、`saveConfigFromView` 空 token 沿用旧值。

---

## 6. 提供商抽象（第 2 步）

接口按"平台间真实差异"收窄——三家在 isomorphic-git 视角只差认证头拼法与 URL 校验：

```ts
// cloud-sync/git-provider.ts
export interface GitProvider {
  readonly type: GitProviderType
  /** isomorphic-git onAuth 回调返回值 */
  auth(token: string): { username: string; password: string }
  /** 校验 repoUrl，返回人话错误 */
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

`sync-manager.ts` 是唯一有分支逻辑的文件。整体包进 `enqueueWorkspace`，复用同一 `WorkspaceVcs` 实例。

```ts
// cloud-sync/sync-manager.ts
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import { EventEmitter } from 'node:events'
import { getWorkspaceVcs, enqueueWorkspace } from '../workspace-vcs/vcs-snapshot'
import { resolveActiveWorkspaceDir } from '../workspace-paths'
import { createLogger } from '../logger'
import { getProvider } from './git-provider'
import { loadCloudSyncConfig, decryptToken } from './sync-config'
import type { CloudSyncConfig, SyncState, SyncStatus, ConflictInfo } from './types'

const logger = createLogger('cloud-sync/manager')

export class CloudSyncManager extends EventEmitter {
  private state: SyncState = 'idle'
  private status: SyncStatus = { state: 'idle' }
  private conflict: ConflictInfo | undefined

  // 不缓存 workspaceDir，每次惰性取（切工作空间无需重建实例）
  private get workspaceDir(): string { return resolveActiveWorkspaceDir() }

  getStatus(): SyncStatus { return this.status }
  getConflict(): ConflictInfo | undefined { return this.conflict }

  async sync(): Promise<{ success: boolean; state: SyncState }> {
    return enqueueWorkspace(this.workspaceDir, () => this.syncInner())
  }

  private async syncInner(): Promise<{ success: boolean; state: SyncState }> {
    const cfg = loadCloudSyncConfig()
    if (!cfg.enabled || !cfg.repoUrl || !cfg.tokenEnc) {
      this.setState('idle', '云同步未启用')
      return { success: false, state: 'idle' }
    }
    if (this.state === 'conflict') return { success: false, state: 'conflict' }  // 冲突未解决不重试
    if (this.state === 'syncing') return { success: false, state: 'syncing' }

    this.setState('syncing', '开始同步')
    try {
      const repo = getWorkspaceVcs(this.workspaceDir)
      const p = repo.getGitParams()
      const provider = getProvider(cfg.provider)
      const auth = () => provider.auth(decryptToken(cfg.tokenEnc))
      const url = cfg.repoUrl.trim()
      const branch = cfg.branch || 'main'
      const localRef = `refs/heads/${branch}`
      const remoteRef = `refs/remotes/origin/${branch}`

      // 1. 本地未提交变更先落 commit
      await repo.ensureInitialized()
      await repo.commit({ author: 'user', message: '云同步自动提交' })

      // 2. ensureRemote（URL 变更时先删后加）
      await this.ensureRemote(p, url)

      // 3. fetch（远程分支不存在 → 首推）
      let remoteOid: string | null
      try {
        await git.fetch({ ...p, http, remote: 'origin', ref: branch, onAuth: auth })
        remoteOid = await git.resolveRef({ ...p, ref: remoteRef })
      } catch {
        remoteOid = null
      }

      const localOid = await git.resolveRef({ ...p, ref: 'HEAD' })

      // 4. 首推：远程无内容
      if (remoteOid === null) {
        await this.push(p, url, localRef, auth)
        this.setState('idle', '首次推送完成')
        return { success: true, state: 'idle' }
      }

      if (remoteOid === localOid) {
        this.setState('idle', '已是最新')
        return { success: true, state: 'idle' }
      }

      // 5. 判定 commit 图关系（baseOids 是数组，长度 != 1 需处理）
      const baseOids = await git.findMergeBase({ ...p, oids: [localOid, remoteOid] })

      if (baseOids.length === 0) {
        // 无关历史：新设备首同步 → 远端为准，先备份
        await this.adoptRemote(p, url, remoteRef, remoteOid, auth)
        return { success: true, state: 'idle' }
      }
      if (baseOids.length > 1) {
        // criss-cross：isomorphic-git 无递归合并，人工介入
        this.setState('error', '检测到交叉合并历史，暂不支持自动同步')
        return { success: false, state: 'error' }
      }
      const baseOid = baseOids[0]

      if (baseOid === remoteOid) {
        // 仅本地新 → 直接 push
        await this.push(p, url, localRef, auth)
        this.setState('idle', '同步完成')
        return { success: true, state: 'idle' }
      }
      if (baseOid === localOid) {
        // 仅远程新 → fast-forward，无需 push
        await git.fastForward({ ...p, ref: 'HEAD', remote: remoteRef })
        this.setState('idle', '已拉取远程变更')
        return { success: true, state: 'idle' }
      }

      // 双方都新 → 尝试 merge（默认 abortOnConflict: true，冲突时干净抛出带 filepaths）
      try {
        await git.merge({
          ...p, ours: 'HEAD', theirs: remoteRef,
          author: { name: 'Lumii CloudSync', email: 'sync@lumii.local' },
          message: '合并远程变更',
        })
      } catch (err) {
        if (this.isMergeConflict(err)) return this.enterConflict(err, localOid, remoteOid, baseOid)
        if (this.isMergeNotSupported(err)) {
          this.setState('error', '冲突类型暂不支持自动合并（新增文件/重命名），请手动处理')
          return { success: false, state: 'error' }
        }
        throw err
      }

      await this.push(p, url, localRef, auth)
      this.setState('idle', '同步完成')
      return { success: true, state: 'idle' }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      logger.error(`[sync] 同步失败: ${this.sanitize(reason)}`)
      this.setState('error', reason)
      return { success: false, state: 'error' }
    }
  }

  /** 无关历史：备份本地工作树 → 本地分支钉到远端 HEAD → checkout 远端内容 */
  private async adoptRemote(p, url, remoteRef, remoteOid, auth): Promise<void> {
    const backupDir = `${this.workspaceDir}.lumii-sync-backup-${Date.now()}`
    fs.cpSync(this.workspaceDir, backupDir, { recursive: true, filter: (s) => !s.includes('.mtbot-vcs') })
    logger.warn(`[adoptRemote] 检测到无关历史，本地已备份到 ${backupDir}`)
    await git.writeRef({ ...p, ref: `refs/heads/${this.branch}`, value: remoteOid, force: true })
    await git.checkout({ ...p, ref: remoteOid, force: true })
    logger.info('[adoptRemote] 已采用远端历史作为本地主线')
  }
}
```

### 关键决策（对齐设计文档 + 评审修正）

- **先 commit 再 fetch**：本地脏工作区先落 commit，后续判断全在 commit 图上做。
- **永不 force**：push 用 `force: false`（默认），被拒（`[rejected]`/`non-fast-forward`）→ 记日志等下轮，不强推。
- **冲突态阻断**：`state==='conflict'` 时 `sync()` 直接返回，等 Agent 落决。
- **无关历史 = 远端为准**：`baseOids.length === 0` 时备份 + `writeRef` + `checkout` 建立 lineage。本地根快照无用户价值，丢弃可接受，但**必须先备份**（`fs.cpSync` 排除 `.mtbot-vcs`）。
- **criss-cross = 人工**：`baseOids.length > 1` 降级 error，isomorphic-git 无递归合并。

### 冲突进入（enterConflict）与落决（resolveConflict）

```ts
private enterConflict(err: unknown, localOid: string, remoteOid: string, baseOid: string) {
  const data = (err as { data?: MergeConflictErrorData }).data
  this.conflict = {
    files: data?.filepaths ?? [],
    bothModified: data?.bothModified ?? [],
    deleteByUs: data?.deleteByUs ?? [],
    deleteByTheirs: data?.deleteByTheirs ?? [],
    localOid, remoteOid, baseOid,   // baseOid 由调用方传入，不读 ORIG_HEAD
  }
  this.status.conflict = this.conflict
  this.setState('conflict', `检测到 ${this.conflict.files.length} 个冲突文件，等待 Agent 处理`)
  return { success: false, state: 'conflict' as const }
}

/** Agent 落决：选侧 checkout → add → 双亲 commit → push */
async resolveConflict(
  strategy: 'keep-local' | 'keep-remote' | 'per-file',
  choices?: { path: string; side: 'local' | 'remote' }[],
): Promise<{ success: boolean; error?: string }> {
  return enqueueWorkspace(this.workspaceDir, () => this.resolveInner(strategy, choices))
}

private async resolveInner(strategy, choices): Promise<{ success: boolean; error?: string }> {
  if (!this.conflict) return { success: false, error: '当前无冲突' }
  const p = getWorkspaceVcs(this.workspaceDir).getGitParams()
  const branch = this.branch
  const localRef = `refs/heads/${branch}`
  const remoteRef = `refs/remotes/origin/${branch}`
  const cfg = loadCloudSyncConfig()
  const auth = () => getProvider(cfg.provider).auth(decryptToken(cfg.tokenEnc))

  try {
    for (const f of this.conflict.files) {
      const side = strategy === 'per-file'
        ? (choices?.find(c => c.path === f)?.side ?? 'local')
        : strategy === 'keep-local' ? 'local' : 'remote'
      // 选侧内容写入工作树 + index；noUpdateHead 不移动 HEAD
      await git.checkout({ ...p, ref: side === 'local' ? 'HEAD' : remoteRef, filepaths: [f], force: true, noUpdateHead: true })
    }
    await git.add({ ...p, filepath: '.' })
    await git.commit({
      ...p, ref: localRef, message: `解决云同步冲突（${strategy}）`,
      parent: ['HEAD', remoteRef],
      author: { name: 'Lumii CloudSync', email: 'sync@lumii.local' },
    })
    await git.push({ ...p, http, remote: 'origin', ref: localRef, remoteRef: localRef, onAuth: auth })
    this.conflict = undefined
    this.status.conflict = undefined
    this.setState('idle', '冲突已解决')
    return { success: true }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    logger.error(`[resolveConflict] 解决失败: ${this.sanitize(reason)}`)
    return { success: false, error: reason }
  }
}

/** 读三方任一版本内容，供 Agent 判断 */
async readFileAt(oid: 'local' | 'remote' | 'base', filepath: string): Promise<string | null> {
  const c = this.conflict
  if (!c) return null
  const ref = oid === 'local' ? 'HEAD' : oid === 'remote' ? `refs/remotes/origin/${this.branch}` : c.baseOid
  return getWorkspaceVcs(this.workspaceDir).readFileAt(ref, filepath)
}
```

> **关键点**：`resolveConflict` 用 `checkout({ filepaths, force, noUpdateHead })` 选侧 + `git.add` + `git.commit({ parent: ['HEAD', remoteRef] })`，遵循 isomorphic-git 官方文档的手工合并流程（`index.d.ts:2245-2284`），不做 checkout 整树（那会移动 HEAD）。`deleteByUs/deleteByTheirs` 类冲突由 `checkout force` 的删除语义覆盖（目标侧无该文件时 checkout 会删掉工作树对应文件）。

**验证**：`sync-manager.test.ts` 用两个本地临时目录互推模拟远程，十一个分支场景全绿（见 §14）。

---

## 8. 触发与调度（第 5 步）

`sync-scheduler.ts`：定时 + Turn 快照后 60 秒防抖 + **24h 冲突超时兜底**。

```ts
// cloud-sync/sync-scheduler.ts
import { createLogger } from '../logger'
import type { CloudSyncManager } from './sync-manager'

const logger = createLogger('cloud-sync/scheduler')
const CONFLICT_ESCALATE_MS = 24 * 60 * 60 * 1000

export class SyncScheduler {
  private timer: NodeJS.Timeout | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  private conflictSince: number | null = null

  constructor(private manager: CloudSyncManager) {
    // 冲突态持续 24h → 升级醒目提示（静默同步不丢数据的前提）
    manager.on('status', (s) => {
      if (s.state === 'conflict') {
        if (this.conflictSince === null) this.conflictSince = Date.now()
      } else {
        this.conflictSince = null
      }
    })
  }

  start(cfg: { enabled: boolean; intervalMinutes: number }): void {
    this.stop()
    if (!cfg.enabled) return
    this.timer = setInterval(() => void this.tick(), cfg.intervalMinutes * 60_000)
    setTimeout(() => void this.tick(), 30_000)   // 冷启动 30s 后首同步，避开启动争抢
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
      if (this.conflictSince && Date.now() - this.conflictSince > CONFLICT_ESCALATE_MS) {
        this.manager.emit('escalate', this.manager.getConflict())
      }
    } catch (err) {
      logger.error(`[tick] 同步异常: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
```

> 触发源只有定时 + Turn 快照防抖，不用 `fs.watch`。`escalate` 事件由 IPC 层转为主窗口通知（设计文档 §7「24h 升级」）。

**接线点**：`maybeSnapshot`（`vcs-snapshot.ts:50`）成功返回 commit 后调用 `scheduler.onWorkspaceChanged()`。Scheduler 实例在 `main/index.ts` 启动时创建，配置变更时 `start(newCfg)` 重载。

---

## 9. Agent 冲突解决（第 6 步）

### 冲突通知（sync-manager 检测到冲突 → 唤起 Agent）

参照 `autonomous-ipc.ts:125` 的 `notifyAutonomousGoalApproved` 注入模式：

```ts
// agent-runtime/sync-conflict-wiring.ts（新增，约 20 行）
import { getAgentRuntimeBridge } from '../ipc/agent-runtime-ipc'

export function notifySyncConflict(info: { files: string[] }): void {
  const bridge = getAgentRuntimeBridge()
  if (!bridge) return
  bridge.notifySystem(`工作空间云同步检测到冲突，涉及 ${info.files.length} 个文件，请用 resolve_sync_conflict 工具解决。`)
}
```

> 具体注入 API 以 bridge 现有暴露为准；若 bridge 无现成注入方法则退化为设置页角标 + 主窗口通知，Agent 唤起留 P1。

### 工具注册

`bridge-tool-registrar.ts:47` 的 `registerAll()` 加一行，实现放独立文件（与 `bridge-tool-registrar-cron` 模式一致）：

```ts
// bridge-tool-registrar-sync.ts（新增）
import { createMtBotTool, type MtBotToolConfig } from '@mtbot/agent-runtime'
import { getCloudSyncManager } from '../cloud-sync/sync-accessor'
import { jsonToolResult } from './bridge-utils'

export function registerSyncConflictTool(registry: unknown, ctx: unknown): void {
  const config: MtBotToolConfig = {
    name: 'resolve_sync_conflict',
    description: '解决工作空间云同步冲突。仅在收到同步冲突通知时调用。先用 readFileAt(local/remote/base) 读三方内容再决定策略。',
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

> Agent 读三方内容走 `sync-manager.readFileAt(oid, path)`，配套暴露一个只读工具（或复用 `vcs:readFileAt` 扩展 remote/base 参数），最小改动。

---

## 10. IPC 与设置页

### IPC（第 4 步）

`cloud-sync/sync-ipc.ts`，按项目 IPC 模式。**本层不碰 token 明文编解码，只调 sync-config 的封装函数**。

```ts
// cloud-sync/sync-ipc.ts
import { ipcMain, BrowserWindow } from 'electron'
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import { getCloudSyncManager } from './sync-accessor'
import { loadCloudSyncConfig, saveConfigFromView, toConfigView, decryptToken } from './sync-config'
import { getProvider } from './git-provider'
import { resolveActiveWorkspaceDir } from '../workspace-paths'

export function registerCloudSyncIpcHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('cloudSync:getConfig', () => {
    const view = toConfigView(loadCloudSyncConfig())
    view.workspaceDir = resolveActiveWorkspaceDir().replace(/\\/g, '/')
    return { success: true, data: view }
  })
  ipcMain.handle('cloudSync:setConfig', async (_e, view: CloudSyncConfigView) => {
    const next = saveConfigFromView(view)      // 加密在 sync-config 内部完成
    getCloudSyncManager()?.setConfig(next)      // 或读文件重载
    restartScheduler(next)
    return { success: true, data: toConfigView(next) }
  })
  ipcMain.handle('cloudSync:testConnection', async (_e, view: CloudSyncConfigView) => {
    const provider = getProvider(view.provider)
    const urlOk = provider.validateUrl(view.repoUrl)
    if (!urlOk.ok) return { success: false, error: urlOk.error }
    const token = view.token && view.token.trim() !== '' ? view.token : decryptToken(loadCloudSyncConfig().tokenEnc)
    try {
      await git.getRemoteInfo({ http, url: view.repoUrl, onAuth: () => provider.auth(token) })
      return { success: true }   // 空仓库 getRemoteInfo 也成功，HEAD 可能 undefined，不依赖它
    } catch (err) { return { success: false, error: sanitize(String(err)) } }
  })
  ipcMain.handle('cloudSync:getStatus', () => ({ success: true, data: getCloudSyncManager()?.getStatus() }))
  ipcMain.handle('cloudSync:syncNow', async () => await getCloudSyncManager()!.sync())
  ipcMain.handle('cloudSync:resolveConflict', async (_e, strategy, choices) => await getCloudSyncManager()!.resolveConflict(strategy, choices))
  ipcMain.handle('cloudSync:readFileAt', async (_e, oid, filepath) => ({ success: true, data: await getCloudSyncManager()?.readFileAt(oid, filepath) }))
}
```

状态推送：manager 是 EventEmitter，`sync-ipc` 挂 `on('status')` → `mainWindow.webContents.send('cloudSync:status', status)`；`on('escalate')` → 主窗口通知。preload 用 `ipcRenderer.on` 暴露 `onStatusChange(cb) => 取消函数`。

### preload 三处同步

1. `preload/api/cloud-sync-api.ts`（新增）：`getConfig/setConfig/testConnection/getStatus/syncNow/resolveConflict/readFileAt/onStatusChange`，事件订阅在**本模块内直接 `ipcRenderer.on`**（`createEventListener` 定义在 `preload/index.ts` 未导出，不能跨文件用）
2. `preload/api/index.ts`：加 `export { cloudSyncApi } from './cloud-sync-api'`
3. `preload/index.ts`：`ElectronAPI` 接口加 `cloudSync: typeof cloudSyncApi` + electronAPI 对象加 `cloudSync: cloudSyncApi`

### 设置页

**放「工作空间」分类下**（零新增分类类型），`SettingsPage.tsx` 的 `case 'workspace'` 并列渲染：

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

`CloudSyncSection`（新增组件）：provider 下拉（GitCode / GitHub·Gitee 置灰）、仓库 URL、token（password + 掩码回显）、分支、间隔、启用开关、「测试连接」「立即同步」按钮、状态行（`idle/syncing/conflict/error` + 最近成功时间）、冲突时显示冲突文件列表 + Agent 处理中提示。

> **重要**：云同步配置是独立的 main 进程配置，**不走** `useSettings`/`saveSettings`（那是 localStorage 的 AppSettings）。`CloudSyncSection` 自持状态，直接调 `window.electronAPI.cloudSync.setConfig()`，内部用显式 `token` 字段（编辑过才传值，否则传空串沿用旧值）。UI 复用 `components/ui/{Input,Button,Select,Checkbox,Badge}`，不新写样式系统。

---

## 11. 接线汇总（main/index.ts）

启动顺序（对照现有 `main/index.ts` 初始化序列，只加 3 处）：

1. 创建 `CloudSyncManager` → 存 `sync-accessor.ts`（与 `screen-record/accessor.ts` 同模式）
2. `ipc-handlers-registry.ts` 加 `registerCloudSyncIpcHandlers(deps.getMainWindow)`
3. 创建 `SyncScheduler` 并 `start(loadCloudSyncConfig())`
4. 配置变更（`cloudSync:setConfig`）→ `scheduler.start(newCfg)` + manager 惰性读新配置
5. workspace 目录变更：manager **不缓存目录**（§7 惰性取），无需重建；`resetWorkspaceVcs()` 已由既有逻辑处理
6. Turn 快照钩子处（`maybeSnapshot` 调用点）加 `scheduler.onWorkspaceChanged()`

> 依赖注入统一走 `sync-accessor.ts` 单例，不往 `main/index.ts` 加逻辑，只加启动行。

---

## 12. 可观测性设计

### 日志（createLogger + 中文 + 函数前缀）

| 级别 | 内容 |
|---|---|
| `info` | `[sync] 开始同步`、`[sync] 同步完成`、`[sync] 已拉取远程变更`、`[scheduler] 静默同步已启动, interval=15min` |
| `warn` | `[sync] 远程有更新，下轮重试`、`[adoptRemote] 检测到无关历史，本地已备份到 <dir>` |
| `error` | `[sync] 同步失败: {sanitize(reason)}`、`[resolveConflict] 解决失败: ...`、`[tick] 同步异常: ...` |

日志脱敏：`sanitize()` 把 token 替换为 `***`（auth 失败信息可能含它）。

### 状态机（渲染侧可观测）

`SyncStatus.state` 五种态 + `message` + `lastSyncAt` + `lastError` + `conflict`，设置页直接渲染。冲突态带完整 `ConflictInfo`（files/bothModified/deleteByUs/deleteByTheirs）。

### 可调试性

- `cloudSync:syncNow` 手动触发，排查不必等定时。
- `getRemoteInfo` 探活给「测试连接」，先验 URL/认证再进同步流。
- `cloudSync:readFileAt` 让 Agent/调试者读三方内容。
- 失败态保留脱敏 `lastError`，设置页可见，不必翻日志。
- token 永不回传明文，主进程日志也不落 token。

---

## 13. 可扩展性设计

| 扩展方向 | 预留位 | 说明 |
|---|---|---|
| GitHub / Gitee | `git-provider.ts` providers 注册表 | 各加 ~10 行实现 + 下拉解锁；认证头格式与 GitCode 一致，Gitee 实施时实测确认 |
| 其他数据域同步 | 不预留结构 | 设计文档已明确 db/memories 需导出格式，属独立方案 |
| 历史压缩 | 不预留 | squash/shallow 是仓库级操作，不影响 sync-manager 结构 |
| 冲突逐字合并 | `resolveConflict` 的 strategy 枚举 | 将来加 `'agent-merged'` + `mergedContent` 入参 |
| 端到端加密 | 不预留 | 改变 push 前文件内容，影响 diff 可读性，属独立方案 |
| criss-cross 递归合并 | 无 | isomorphic-git 不支持，只能等其实现或换 git 原生 |

---

## 14. 测试计划

项目规范：vitest，`src/main` 同目录测试用 `npx vitest run src/main`。

### sync-manager.test.ts（核心，模拟远程不联网）

用两个本地临时目录互推模拟 GitCode 远程，真实跑 isomorphic-git：

```
├─ 仅本地有新提交 → push 成功，远程收到
├─ 仅远程有新提交 → fast-forward，本地文件更新且不 push
├─ 双方改不同文件 → 自动 merge 成功
├─ 双方改同一文件 → state='conflict'，ConflictInfo.files/bothModified 正确，未 push
├─ 冲突后 resolveConflict('keep-local') → 远程内容变为本地版本
├─ 冲突后 resolveConflict('keep-remote') → 本地变为远程版本
├─ 冲突后 resolveConflict('per-file') → 逐文件选侧正确
├─ 远程分支不存在 → 首推成功
├─ 无关历史（各自独立 root）→ 本地被备份 + 分支钉到远端 HEAD + 文件与远端一致
├─ criss-cross（多 merge base）→ state='error'，不丢数据
├─ state='conflict' 期间再调 sync() → 直接返回不重试
├─ push 被拒（模拟远程又变）→ 不强推，返回 idle 等下轮
└─ 并发：sync 与 maybeSnapshot 同刻触发 → 因 enqueueWorkspace 串行，提交数不丢
```

### 其余

- `sync-config.test.ts`：token 加解密往返、plain: 兜底、缺文件默认值、空 token 沿用旧值
- `gitcode-provider.test.ts`：validateUrl 接受/拒绝
- `vcs-repo.test.ts`：getGitParams 新增断言
- `vcs-snapshot.test.ts`：enqueueWorkspace 串行语义断言

---

## 15. 实施步骤（小步快跑，每步可独立验证）

| 步 | 内容 | 变更文件 | 验证命令 |
|---|---|---|---|
| 1 | getGitParams + enqueueWorkspace + types + sync-config | vcs-repo.ts（+6行）、vcs-snapshot.ts（+3行）、cloud-sync/types.ts、sync-config.ts | `npx vitest run src/main/workspace-vcs src/main/cloud-sync/sync-config.test.ts` |
| 2 | git-provider + gitcode-provider | cloud-sync/git-provider.ts、gitcode-provider.ts | `npx vitest run src/main/cloud-sync/gitcode-provider.test.ts` + 真实 GitCode 仓库 `getRemoteInfo` 探活 |
| 3 | sync-manager（核心） | cloud-sync/sync-manager.ts、sync-accessor.ts | `npx vitest run src/main/cloud-sync/sync-manager.test.ts`（十三场景） |
| 4 | sync-ipc + preload 三处 + 设置页 | sync-ipc.ts、preload/api/cloud-sync-api.ts、api/index.ts、preload/index.ts、SettingsPage.tsx、CloudSyncSection | `pnpm typecheck` + 手动「测试连接」「立即同步」真实仓库 |
| 5 | sync-scheduler + 接线 | sync-scheduler.ts、main/index.ts、ipc-handlers-registry.ts、vcs-snapshot.ts 调用点 | 两台设备（或两个数据目录）实际流转文件 |
| 6 | resolve_sync_conflict 工具 + 冲突通知 | bridge-tool-registrar-sync.ts、sync-conflict-wiring.ts、bridge-tool-registrar.ts | 人工造冲突，Agent 端到端落决 |

每步结束跑 `pnpm typecheck` 确认无类型回归；第 3 步后同步逻辑已有测试覆盖，可随时合入。

---

## 16. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 无关历史（两台设备各自 init） | 首次同步失败 | `findMergeBase` 返回空 → 备份 + `writeRef`+`checkout` 采用远端（§7 adoptRemote），有测试覆盖 |
| criss-cross（多 merge base） | merge 失败 | `baseOids.length > 1` 降级 error 态，isomorphic-git 无递归合并，人工介入 |
| add/add、rename 冲突 | MergeNotSupportedError 无 filepaths | 单独 catch → error 态 + 明确提示 |
| Turn 快照与云同步并发 | 静默丢提交 | `enqueueWorkspace` 串行化（§3.2），有并发测试 |
| `git.reset` 不存在 | 误用 reset 会失败 | 用 `writeRef + checkout`（§7），已标注 |
| GitCode 认证格式与预期不符 | 探活失败 | `testConnection` 先验；实施时用真实账号实测认证头 |
| 空仓库 getRemoteInfo 无 HEAD | 探活误判失败 | testConnection 只判断不抛异常，不依赖 `info.HEAD` |
| 大工作区 push 慢 | 同步耗时 | 首次全量，后续增量；异步 + 状态机，不阻塞 UI |
| token 泄漏 | 安全 | safeStorage 加密落盘 + 掩码回显 + 日志脱敏 + 永不回传明文 |
| 冲突态长期挂起 | 用户无感知 | 24h 超时 escalate 主窗口通知（§8） |
