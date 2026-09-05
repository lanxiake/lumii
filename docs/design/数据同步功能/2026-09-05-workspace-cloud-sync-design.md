# 工作空间多设备云同步设计（GitCode 优先）

- 日期：2026-09-05
- 状态：设计待评审
- 作用范围：`apps/windows/src/main/cloud-sync/`（新增）、复用 `workspace-vcs/`

---

## 1. 需求

用户在多台设备上使用 Lumii，希望工作空间文件自动在设备间流转。用 Git 托管平台当"云盘"，用户自带仓库与令牌，不引入 Lumii 后端。

**范围（本期）**

| 项 | 决定 |
|----|------|
| 同步内容 | 仅工作空间目录（`resolveActiveWorkspaceDir()`，默认 `~/.lumii/workspace`） |
| 排除 | `projects/`、`temp/`、以及 `.gitignore` 命中的一切 |
| 触发 | 后台静默自动同步，无需用户点按 |
| 冲突 | 交给 Agent 判定并落决 |
| 提供商 | 仅实现 GitCode；GitHub / Gitee 留接口 |

**明确不做**：不同步 `db/`、`config/provider.json`、`voices/`、`logs/`、`data/memories/`。这些留给后续独立方案。

---

## 2. 为什么复用 workspace-vcs 而不新建仓库

工作空间已经有一个 isomorphic-git 仓库：gitdir 在 `{workspace}/.mtbot-vcs`，每轮对话自动快照，`.gitignore` 里已经写好 `projects/`、`temp/`、`node_modules/`、`uploads/**` 等排除规则（见 `workspace-vcs/vcs-ignore.ts:11`），`walkWorktreeFiles` 还在遍历阶段就剪掉了这些重目录（`vcs-ignore.ts:79`）。

所以本期不新建仓库、不新建忽略规则、不新写文件遍历。云同步 = 给这个已有仓库加一个 remote，再加 fetch / merge / push 三步。

> 需求里"排除 projects、temp 以及 .gitignore 排除项"这一条，现有代码已经完全满足，无需新增排除配置。

**代价**：远程仓库里会带上 Turn-level 快照的完整历史（每轮对话一个 commit）。这是可接受的——历史本身就是多设备回溯的价值，且 GitCode 免费仓库容量足够文本工作区用很久。若后续 commit 数膨胀影响 clone 速度，再加定期 squash。

---

## 3. 模块划分

```
apps/windows/src/main/cloud-sync/
├── types.ts             # 配置 / 状态 / 冲突类型
├── git-provider.ts      # GitProvider 接口 + 注册表
├── gitcode-provider.ts  # GitCode 实现（本期唯一）
├── sync-config.ts       # 配置读写，token 经 safeStorage 加密
├── sync-manager.ts      # 同步主流程（核心）
├── sync-scheduler.ts    # 静默定时 + 变更防抖触发
└── sync-ipc.ts          # 设置页 IPC
```

Agent 侧新增一个工具 `resolve_sync_conflict`，注册在 `main/agent-runtime/bridge-tool-registrar`（桌面专属能力，不进 `packages/agent-runtime`）。

---

## 4. 类型定义

```ts
// cloud-sync/types.ts
export type GitProviderType = 'gitcode' | 'github' | 'gitee'

export interface CloudSyncConfig {
  enabled: boolean
  provider: GitProviderType
  /** 形如 https://gitcode.com/<user>/<repo>.git */
  repoUrl: string
  /** Personal Access Token；落盘时经 safeStorage 加密 */
  token: string
  branch: string
  /** 静默同步间隔，分钟，默认 15 */
  intervalMinutes: number
}

export type SyncState = 'idle' | 'syncing' | 'conflict' | 'error'

export interface SyncStatus {
  state: SyncState
  /** 最近一次成功同步时间戳 */
  lastSyncAt?: number
  message?: string
  conflict?: ConflictInfo
}

export interface ConflictInfo {
  /** 双方都改过的文件（相对工作区根，POSIX 分隔） */
  files: string[]
  localOid: string
  remoteOid: string
  /** 分叉点，供 Agent 做三方判断 */
  baseOid: string
}
```

配置持久化到 `~/.lumii/config/cloud-sync.json`，token 字段照 `provider-config.ts:159` 的既有做法：`safeStorage.isEncryptionAvailable()` 时 base64 密文，不可用时 `plain:` 前缀明文兜底。不新写一套加密。

---

## 5. GitProvider 抽象

三家平台在 isomorphic-git 视角下差异只有两点：认证头怎么拼、URL 怎么校验。接口按这两点收窄，不做成泛化的"平台 SDK 层"。

```ts
// cloud-sync/git-provider.ts
export interface GitProvider {
  readonly type: GitProviderType
  /** isomorphic-git onAuth 回调的返回值 */
  auth(token: string): { username: string; password: string }
  /** 校验 repoUrl 是否属于本平台，返回人话错误 */
  validateUrl(repoUrl: string): { ok: true } | { ok: false; error: string }
}

const providers: Partial<Record<GitProviderType, GitProvider>> = {
  gitcode: gitcodeProvider,
  // github / gitee: 后续各加 ~10 行
}

export function getProvider(type: GitProviderType): GitProvider
```

GitCode 实现：

```ts
// cloud-sync/gitcode-provider.ts
export const gitcodeProvider: GitProvider = {
  type: 'gitcode',
  auth: (token) => ({ username: token, password: 'x-oauth-basic' }),
  validateUrl: (url) =>
    /^https:\/\/gitcode\.com\/[^/]+\/[^/]+?(\.git)?$/.test(url.trim())
      ? { ok: true }
      : { ok: false, error: '仓库地址应形如 https://gitcode.com/用户名/仓库名.git' },
}
```

fetch / push 本身由 `sync-manager` 直接调 isomorphic-git 完成，不在 provider 里各写一遍——那才是重复。

---

## 6. 同步主流程

`sync-manager.ts` 单一入口 `sync()`，进程内串行（`syncing` 期间重入直接返回）。

```
sync()
 ├─ 0. 前置：enabled && 配置完整 && 非 syncing，否则 return
 ├─ 1. vcs.ensureInitialized()
 ├─ 2. vcs.commit({ author:'user', message:'云同步自动提交' })
 │      无变更返回 null，不产生空提交（vcs-repo.ts:225 已有此行为）
 ├─ 3. ensureRemote()  # addRemote origin，已存在则忽略；URL 变更时 deleteRemote 重加
 ├─ 4. git.fetch({ remote:'origin', ref:branch, onAuth })
 │      远程分支不存在 → 视为首推，跳到 7
 ├─ 5. 判定关系（git.findMergeBase + resolveRef）
 │      ├ remote == local            → 已同步，结束
 │      ├ base == local  (仅远程新)  → fast-forward，结束（无需 push）
 │      ├ base == remote (仅本地新)  → 跳到 7 直接 push
 │      └ 双方都新                   → 6 分叉处理
 ├─ 6. git.merge({ ours:HEAD, theirs:origin/branch })
 │      ├ 成功（无内容冲突）→ 跳到 7
 │      └ MergeConflictError → 收集冲突文件 → state='conflict'
 │                             → 通知 Agent，本次 sync 结束（不 push）
 └─ 7. git.push({ remote:'origin', ref:branch, onAuth })
        非 fast-forward 被拒 → 说明期间远程又变了 → 下个周期重来（不强推）
```

几个刻意的选择：

- **先 commit 再 fetch**。本地脏工作区先落成 commit，后面所有判断都在 commit 图上做，不用处理"工作区有未提交改动时怎么 merge"这类边界。
- **永不 `--force`**。push 被拒就等下一轮，宁可慢一拍也不覆盖别的设备。
- **fast-forward 分支不 push**。少一次网络往返。
- **冲突不阻塞后续周期的其他工作**，但 `state==='conflict'` 时 `sync()` 直接返回，等 Agent 落决后再恢复。否则会反复 merge 反复冲突刷日志。

分叉判定用 `git.findMergeBase` 拿 base，比遍历 log 找包含关系更准（后者在 depth 截断时会误判）。

---

## 7. 冲突交给 Agent

### 检测与上报

`git.merge` 抛 `MergeConflictError` 时，从 `err.data.filepaths` 取冲突文件，组装 `ConflictInfo`（含 `baseOid` / `localOid` / `remoteOid`），然后：

1. `state = 'conflict'`，写入 `SyncStatus`
2. 通过 IPC 事件 `cloud-sync:conflict` 推给渲染进程（设置页显示角标）
3. 向当前会话注入一条系统消息，触发 Agent 处理

### Agent 工具

```ts
{
  name: 'resolve_sync_conflict',
  description: '解决工作空间云同步冲突。仅在收到同步冲突通知时调用。',
  parameters: {
    strategy: { enum: ['keep-local', 'keep-remote', 'per-file'] },
    /** strategy='per-file' 时必填：每个冲突文件选一侧 */
    choices: { type:'array', items: { path: string, side: 'local' | 'remote' } },
    reason: { type: 'string', description: '给用户看的决策理由' },
  },
}
```

Agent 拿到冲突后可以先用已有的 `vcs.readFileAt(oid, path)` 读三方内容（base / local / remote）做判断，再落决。这是把"读文件"这个能力留给现成工具，工具本身只管落决。

**落决实现**：

- `keep-local`：对每个冲突文件 `checkout` 本地侧内容 → commit merge → push
- `keep-remote`：同理取远程侧
- `per-file`：逐文件按 `choices` 选侧

三条路径最终都归到「写入选定内容 → 提交 merge commit → push → state='idle'」，共用一个内部函数。

**逐字合并（把两边内容都保留）本期不做**——Agent 在拿不定主意时应该问用户，而不是生成一个双方都没写过的第三版文件。若后续确有需要，再加 `strategy: 'agent-merged'` 传入完整新内容。

**超时兜底**：冲突态持续超过 24 小时（Agent 没被唤起 / 用户没理），不自动决策，只在设置页把角标升级为醒目提示。静默同步的前提是不丢数据，宁可停在冲突态。

---

## 8. 触发策略

`sync-scheduler.ts` 两条触发源：

1. **定时**：`intervalMinutes`（默认 15）的 `setInterval`
2. **变更防抖**：复用现有的 Turn 级快照钩子（`workspace-turn-snapshot`）——每轮对话产生快照后，起一个 60 秒防抖定时器触发 `sync()`

启动时延迟 30 秒做首次同步，避开冷启动争抢（README 已记录冷启 3–5s，别再加压）。

不新增 `fs.watch`：工作空间的写入本来就都走 Agent 工具，Turn 快照已经是天然的变更信号。多铺一层文件监听只会在 `outputs/` 大量写入时反复触发。

**静默的边界**：同步全程不弹窗、不打断对话。只有两种情况会浮现到 UI —— 冲突态、连续 3 次同步失败（如 token 过期）。其余状态只更新设置页里的状态行。

---

## 9. 设置页

`SettingsPage` 新增「云同步」区块，字段直接映射 `CloudSyncConfig`：

- 提供商下拉：GitCode（GitHub / Gitee 置灰标"后续支持"）
- 仓库地址、访问令牌（password 输入）、分支（默认 main）
- 启用开关、同步间隔
- 「测试连接」按钮：`git.getRemoteInfo` 探活，报人话错误
- 状态行：`idle / syncing / conflict / error` + 最近成功时间
- 一句范围说明：同步工作空间文件，不含 `projects/`、`temp/`、`.gitignore` 忽略项

新增 IPC 按项目约束三处同步 —— main handler → preload `ElectronAPI` → renderer 调用点：

| IPC | 说明 |
|-----|------|
| `cloudSync:getConfig` / `setConfig` | 配置读写（get 时 token 返回掩码） |
| `cloudSync:testConnection` | 探活 |
| `cloudSync:getStatus` | 当前 `SyncStatus` |
| `cloudSync:syncNow` | 手动触发（调试与"我现在就要"场景） |
| 事件 `cloudSync:status` | 状态变更推送 |

> 手动同步按钮虽不在需求内，但排查问题时没有它就只能等 15 分钟，保留。

---

## 10. 安全

- token 经 `safeStorage` 加密落盘，复用 `provider-config.ts` 既有实现
- `cloudSync:getConfig` 返回给渲染进程时 token 只给掩码（`ghp_****abcd`），不回传明文
- 日志中的 URL 与错误信息做 token 脱敏（GitCode 报错常把 URL 原样回显）
- 仓库地址仅接受 `https://`，不支持 `git@` SSH（本期不做密钥管理）
- 提醒用户使用**私有仓库**：工作空间里可能有 Agent 产出的敏感内容。设置页文案明示，不做技术强制（无法可靠判定仓库可见性）。

---

## 11. 验证

按项目规范（`vitest`，`src/main` 下同目录测试用 `npx vitest run src/main`）：

`cloud-sync/sync-manager.test.ts` 覆盖分支判定这块唯一有真实逻辑的地方，用两个本地临时仓库互推模拟远程，不打真实网络：

- 仅本地有新提交 → push，远程收到
- 仅远程有新提交 → fast-forward，本地文件更新且不 push
- 双方改不同文件 → 自动 merge 成功
- 双方改同一文件 → `state='conflict'`，`ConflictInfo.files` 正确，未 push
- 冲突后 `resolve_sync_conflict('keep-local')` → 远程内容变为本地版本
- 远程分支不存在 → 首推成功
- `state='conflict'` 期间再调 `sync()` → 直接返回，不重复 merge

`gitcode-provider.test.ts` 只测 `validateUrl` 的接受/拒绝样例。

`sync-config.test.ts` 测 token 加解密往返 + `safeStorage` 不可用时的 `plain:` 兜底。

---

## 12. 实施顺序

小步验证，每步可单独跑通：

| 步 | 内容 | 验证 |
|----|------|------|
| 1 | `types.ts` + `sync-config.ts` | 配置往返、token 加解密单测过 |
| 2 | `git-provider.ts` + `gitcode-provider.ts` | `validateUrl` 单测过 + 真实 GitCode 仓库 `getRemoteInfo` 探活成功 |
| 3 | `sync-manager.ts` | 七个分支场景单测全绿 |
| 4 | `sync-ipc.ts` + 设置页区块 | 手动「测试连接」「立即同步」在真实仓库跑通 |
| 5 | `sync-scheduler.ts` | 静默定时同步在两台设备（或两个数据目录）间实际流转文件 |
| 6 | `resolve_sync_conflict` 工具 | 人工造冲突，Agent 完成一次端到端落决 |

---

## 13. 后续扩展点（本期不实现）

- **GitHub / Gitee**：各加一个 `GitProvider` 实现（约 10 行）+ 下拉解锁。GitHub token 认证格式与 GitCode 一致，Gitee 需确认。
- **其他数据域**：`config/agents/`、`data/soul.md`、`data/memories/` 的同步。SQLite 主库不建议直接同步二进制文件，需先设计导出格式。
- **历史压缩**：commit 数膨胀后的定期 squash 或 shallow clone。
- **端到端加密**：推送前加密、拉取后解密，使托管平台无法读取内容。会牺牲平台侧的 diff 可读性，需权衡。
- **冲突逐字合并**：`strategy: 'agent-merged'`，Agent 直接给出合并后内容。
