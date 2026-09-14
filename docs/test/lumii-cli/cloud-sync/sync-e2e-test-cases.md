# 云同步端到端测试用例

- **域**：`SYNC`（云同步）
- **执行器**：`run-sync-e2e.mjs`
- **产物**：`sync-e2e-evidence.jsonl` / `sync-e2e-report.md`
- **驱动**：真实 Electron 客户端（隔离数据目录）+ `app-ui-cli` + 本地 smart-HTTP git 远程

## 测试环境

| 项 | 说明 |
|---|---|
| 被测端 | 真实 Electron 客户端，`LUMII_CLIENT_DATA_DIR` 指向 `os.tmpdir()` 下的隔离目录 |
| 驱动 | `lumii-ui.mjs cloudsync sync` → app-ui-control HTTP 控制口 → `CloudSyncManager.sync()` |
| 远程仓库 | 本地 `git http-backend`（`git-server.mjs`），裸仓库，走真实 HTTP git 协议 |
| 另一台设备 | 对同一裸仓库的 clone（`device-b`），用系统 git 推拉模拟第二设备 |
| 隔离 | 客户端额外带 `--user-data-dir=<唯一路径>`：既隔离 Electron userData，又给清理提供唯一识别标记 |

**安全约束**：真实 `~/.lumii` 的云同步配置指向线上 GitCode 仓库。套件启动前用
`assertIsolatedDataRoot()` 强制校验数据目录位于临时目录且路径含 `lumii-e2e`，不满足直接拒绝运行。

**事件循环约束**：git 远程跑在测试进程内，故所有走 HTTP 的操作必须用异步 API
（`execFile`/`promisify`），一旦用 `execFileSync` 阻塞事件循环，git server 将无法响应，
客户端同步会以「clone 失败且无错误输出」的形式诡异失败。仅直接查裸仓库对象库的命令
（`git show` / `ls-tree` / `cat-file`）不走网络，可用同步版。

## 用例

优先级：P0 = 本次修复的核心回归或数据安全相关；P1 = 主要功能路径；P2 = 边界与健壮性。

### A 组：本地 → 远端（导出与删除传播）

| ID | 优先级 | 用例 | 前置 | 步骤 | 预期 | 断言 |
|---|---|---|---|---|---|---|
| SYNC-E2E-01 | P0 | 首次同步推送本地文件 | 隔离数据目录 + 本地远程 | 写 `files/first.md` → sync | 远端出现该文件且内容一致 | 硬：`git show main:workspace/files/first.md` |
| SYNC-E2E-02 | P1 | 新增文件传播 | 已完成 01 | 写 `files/added.md` → sync | 远端出现 | 硬：远端存在性 |
| SYNC-E2E-03 | P1 | 修改文件传播 | 已完成 02 | 改 `first.md` → sync | 远端内容更新 | 硬：内容比对 |
| SYNC-E2E-04 | **P0** | **删除文件传播（核心回归）** | 已完成 02 | 删 `files/added.md` → sync | 远端该文件消失，无关文件保留 | 硬：远端不存在 + `first.md` 仍在 |
| SYNC-E2E-05 | P1 | outputs 增删传播 | — | 写 `outputs/report.md` → sync → 删 → sync | 先出现后消失 | 硬：两步远端存在性 |

> SYNC-E2E-04 是本次修复要解决的核心缺陷：旧实现里 export/import 都是「只增不减」的
> 单向复制，删除既进不了 git commit，下一次 import 又会把 sync 侧残留复制回本地。

### B 组：远端 → 本地（导入与反向删除）

| ID | 优先级 | 用例 | 前置 | 步骤 | 预期 | 断言 |
|---|---|---|---|---|---|---|
| SYNC-E2E-06 | P1 | 远端新增拉取到本地 | 设备 B 可推送 | 设备 B 新增并 push → 本地 sync | 本地出现该文件 | 硬：本地内容 |
| SYNC-E2E-07 | **P0** | 远端删除传播到本地 | 已完成 06 | 设备 B 删除并 push → 本地 sync | 本地文件被删 | 硬：本地不存在 |
| SYNC-E2E-08 | P1 | 远端修改拉取到本地 | — | 设备 B 改文件并 push → 本地 sync | 本地内容更新 | 硬：内容比对 |

> SYNC-E2E-07 验证反向删除：import 方向必须按 git 树差异执行删除，且**不能**退化成
> 目录扫描式镜像（那会在首次同步时删空本地独有文件）。

### C 组：合并与冲突

| ID | 优先级 | 用例 | 前置 | 步骤 | 预期 | 断言 |
|---|---|---|---|---|---|---|
| SYNC-E2E-09 | P1 | 无冲突自动合并 | — | 本地改 A、远端改 B → sync | `success:true`，两侧改动都在 | 硬：本地与远端内容双向核对 |
| SYNC-E2E-18 | P1 | 双方改同一文件 → conflict | 双方有共同基线 | 本地改、远端改同一文件 → sync | `state:conflict`，`conflict.files` 含该文件，**远端未被覆盖** | 硬：状态 + 文件列表 + 远端 rev 未变 |

> SYNC-E2E-18 排在**最后**：客户端一旦进入 `conflict` 状态会持续拒绝后续 `sync()`
> （`resolve_sync_conflict` 只在 Agent 工具面暴露，CLI 无入口），放在中间会连带卡死其余用例。
> 落决逻辑本身由单测 `apps/windows/src/main/cloud-sync/sync-manager.test.ts` 覆盖
> （含「落决不丢远端非冲突变更」的回归）。

### D 组：异常路径

| ID | 优先级 | 用例 | 注入方式 | 预期 | 断言 |
|---|---|---|---|---|---|
| SYNC-E2E-10 | **P0** | 服务端 5xx 时同步失败但不崩、可恢复 | `gitServer.state.failAll = true` | 不卡在 `syncing`；恢复后同步成功 | 硬：状态非 syncing + 恢复后 success |
| SYNC-E2E-11 | **P0** | 认证失败不污染远端 | 配置写入错误 token | 远端 rev 不变，失败文件不进远端 | 硬：`rev-parse main` 前后一致 |
| SYNC-E2E-12 | P1 | 未启用时安全短路 | 配置 `enabled:false` | `success:false` 且 `state:idle` | 硬：返回值 |
| SYNC-E2E-13 | **P0** | 批量删除熔断，不误删远端 | 12 个文件一次删光（占比 >50% 且 ≥10） | 远端 12 个文件全部保留 | 硬：远端文件计数 |

> SYNC-E2E-13 验证镜像删除的安全阀。误删的代价远高于延迟删除，故宁可熔断。
> 熔断会写同步日志（设置页可见），避免用户误以为删除已生效。

### E 组：边界与健壮性

| ID | 优先级 | 用例 | 步骤 | 预期 | 断言 |
|---|---|---|---|---|---|
| SYNC-E2E-14 | P1 | 嵌套目录增删 | 建 `deep/a/b/c/nested.md` → sync → 删目录 → sync | 先同步后传播删除 | 硬：两层存在性 |
| SYNC-E2E-15 | P1 | 重目录剪枝 | 建 `proj/.git/…`、`proj/node_modules/…`、`proj/keep.md` → sync | 前两者不进同步仓，`keep.md` 正常 | 硬：远端 tree 不含 `.git/`、`node_modules/` |
| SYNC-E2E-16 | P2 | profile 同步 | 写 `data/soul.md` → sync | `profile/soul.md` 到达远端 | 硬：远端内容 |
| SYNC-E2E-17 | P2 | 幂等性 | 连续两次 sync | 不产生空提交 | 硬：`rev-parse main` 前后一致 |

## 已知限制

1. **冲突落决未覆盖**：`resolve_sync_conflict` 无 CLI 入口，本套件只能验证到「进入 conflict 且未误推送」。
   落决（含 `keep-local`/`keep-remote`/`per-file`、超时、push 被拒不假成功）由单测覆盖。
2. **大文件跳过未覆盖**：`outputs` 单文件 >5MB 会被跳过，构造真实大文件会拖慢套件，未纳入。
3. **首次同步两边都有数据（无关历史）未覆盖**：需在两个隔离实例间搬运数据，成本高，由单测覆盖。
4. **数据库记录（wiki/记忆）的删除传播未覆盖**：`deleted_at` 目前无写入方，属已知的独立问题。
5. 套件不校验 UI 层展示，只校验数据面（本地文件系统 + 远端裸仓库）。
