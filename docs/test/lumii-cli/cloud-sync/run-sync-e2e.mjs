/**
 * 云同步端到端测试套件（真实客户端 + 本地 smart-HTTP git 远程）。
 *
 * 与外层单测（apps/windows/src/main/cloud-sync/*.test.ts）的分工：
 *  - 单测跑在 vitest 里，mock 掉网络与数据面；
 *  - 本套件启动**真实 Electron 客户端**，通过 app-ui-cli 驱动真实同步流程，
 *    在文件系统层面断言本地与远端的状态。
 *
 * ⚠️ 关键约束：本地 git 远程**跑在本进程内**，因此本套件里任何走 HTTP 的操作
 * （CLI 调用、device-B 的 clone/push/pull）**必须用异步 API**。一旦用
 * spawnSync/execFileSync 阻塞事件循环，git server 就无法响应，客户端的同步
 * 会以「clone 失败但无任何错误输出」的形式诡异失败 —— 这个坑踩过一次。
 * 直接操作裸仓库对象的 git 命令（git show / ls-tree / cat-file）不走网络，
 * 用同步版即可。
 *
 * 运行：
 *   node docs/test/lumii-cli/cloud-sync/run-sync-e2e.mjs
 *   SYNC_E2E_ONLY=SYNC-E2E-04   # 只跑指定用例
 *   SYNC_E2E_VERBOSE=1          # 打印 git server 请求与客户端日志
 *
 * 安全：全程跑在 os.tmpdir() 下的隔离数据目录，绝不触碰 ~/.lumii ——
 * 真实配置的云同步指向线上 GitCode 仓库，误跑会污染真实数据。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'

import {
  makeTempRoot,
  assertIsolatedDataRoot,
  startClient,
  waitFor,
  waitForReady,
  writeCloudSyncConfig,
  removeDirWithRetry,
} from './e2e-harness.mjs'
import { createGitServer } from './git-server.mjs'

const execFileAsync = promisify(execFile)

// ── 隔离数据目录必须在 import cli-harness 之前设好：它的 DATA_ROOT 是模块级 const ──
const DATA_ROOT = makeTempRoot('dev-a')
process.env.LUMII_CLIENT_DATA_DIR = DATA_ROOT
assertIsolatedDataRoot(DATA_ROOT)

const { LUMII_UI, createEvidence } = await import('../lib/cli-harness.mjs')

const VERBOSE = process.env.SYNC_E2E_VERBOSE === '1'
const TOKEN = 'test-token'
const ONLY = process.env.SYNC_E2E_ONLY?.trim()

const WORKSPACE = path.join(DATA_ROOT, 'workspace')

// ────────────────────────────────────────────────
// CLI（全异步 —— 见文件头的事件循环约束）
// ────────────────────────────────────────────────

async function uiAsync(args, { timeoutMs = 120_000 } = {}) {
  let stdout = ''
  let stderr = ''
  let code = 0
  try {
    const r = await execFileAsync(process.execPath, [LUMII_UI, ...args], {
      cwd: path.resolve(import.meta.dirname, '../../../..'),
      env: process.env,
      timeout: timeoutMs,
      maxBuffer: 40 * 1024 * 1024,
    })
    stdout = r.stdout
    stderr = r.stderr
  } catch (err) {
    stdout = err.stdout ?? ''
    stderr = err.stderr ?? ''
    code = typeof err.code === 'number' ? err.code : 1
  }
  let json = null
  try {
    json = JSON.parse(stdout.trim())
  } catch {
    /* 非 JSON 输出保留在 stdout */
  }
  return { code, json, out: stdout, stderr }
}

/**
 * 触发一次完整同步。
 *
 * **默认要求 success:true**：裸调用在 success:false 时不会抛错（push 被拒只是
 * warn 后照常返回、重入守卫直接挡回），不检查就会静默假绿 —— 断言随后以
 * 「文件没同步」的面目失败，把真实原因藏起来。故意要失败的场景传 allowFail。
 */
async function syncNow({ allowFail = false, label = '同步' } = {}) {
  const r = await uiAsync(['cloudsync', 'sync'], { timeoutMs: 180_000 })
  if (!r.json) throw new Error(`cloudsync sync 无 JSON 输出: ${r.out || r.stderr}`)
  if (r.json.ok === false) throw new Error(`cloudsync sync 调用失败: ${JSON.stringify(r.json)}`)
  const s = await uiAsync(['cloudsync', 'status'])
  const out = { success: r.json.success, state: r.json.state, status: s.json?.status ?? null }
  if (!allowFail && !out.success) {
    throw new Error(`${label}未成功: state=${out.state} status=${JSON.stringify(out.status)}`)
  }
  return out
}

// ────────────────────────────────────────────────
// 本地（被测客户端）文件操作 —— 不走网络，同步版即可
// ────────────────────────────────────────────────

const localPath = (rel) => path.join(WORKSPACE, rel)
const localWrite = (rel, content) => {
  const abs = localPath(rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf-8')
}
const localRead = (rel) =>
  fs.existsSync(localPath(rel)) ? fs.readFileSync(localPath(rel), 'utf-8') : null
const localExists = (rel) => fs.existsSync(localPath(rel))
const localRm = (rel) => fs.rmSync(localPath(rel), { recursive: true, force: true })

// ────────────────────────────────────────────────
// 远端（裸仓库）—— 读操作直接查对象库，不走网络
// ────────────────────────────────────────────────

let BARE = null
let DEVICE_B = null
let GIT_ROOT = null

/** 直接查裸仓库对象库（不走网络，同步版即可）；吞掉 stderr 避免「路径不存在」的探测噪音 */
const gitBare = (args) =>
  execFileSync('git', ['-C', BARE, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
const remoteExists = (rel) => {
  try {
    gitBare(['cat-file', '-e', `main:${rel}`])
    return true
  } catch {
    return false
  }
}
const remoteRead = (rel) => {
  try {
    return gitBare(['show', `main:${rel}`])
  } catch {
    return null
  }
}
const remoteTree = () =>
  gitBare(['ls-tree', '-r', '--name-only', 'main'])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

// ── 分级传输：判定一个文件是走「阶段一」还是「阶段二」上传的 ──
//
// 两条路的提交信息不同：阶段一是 `sync: export at <ts>`，阶段二是 `sync: 大文件批次（N 个文件）`。
// 用提交归属来判定比「同步返回后立刻看远端有没有」可靠 —— 后者与后台队列赛跑，
// 文件小的时候队列可能在断言之前就传完了，测试会随机翻绿翻红。

/** 最近一次阶段一提交的 oid */
const lastExportCommit = () =>
  gitBare(['log', '--format=%H', '-1', '--grep', '^sync: export at'])
    .toString()
    .trim()

/** 指定提交里是否含某文件 */
const fileInCommit = (oid, rel) => {
  if (!oid) return false
  try {
    gitBare(['cat-file', '-e', `${oid}:${rel}`])
    return true
  } catch {
    return false
  }
}

/** 阶段二批次提交的条数（用于断言「不再重复传」） */
const batchCommitCount = () =>
  gitBare(['log', '--format=%s'])
    .toString()
    .split('\n')
    .filter((l) => l.includes('大文件批次')).length

/** 在指定云同步配置下跑一段逻辑，结束后恢复基础配置 */
async function withConfig(extra, fn) {
  writeCloudSyncConfig(DATA_ROOT, {
    repoUrl: REPO_URL,
    token: TOKEN,
    intervalMinutes: 1440,
    extra,
  })
  try {
    return await fn()
  } finally {
    writeCloudSyncConfig(DATA_ROOT, { repoUrl: REPO_URL, token: TOKEN, intervalMinutes: 1440 })
  }
}

// ── 模拟「另一台设备」：在 clone 里改文件并推送（走 HTTP，必须异步）──

/**
 * 模拟「另一台设备」。
 *
 * 每批改动前必须先把 device-b 对齐到远端最新 —— 被测客户端会持续推送，
 * 不对齐就 push 会被拒（non-fast-forward）。对齐用 fetch + reset --hard：
 * device-b 的改动总是「改完即推」，所以不存在需要保留的未推送本地提交。
 */
let deviceBAligned = false

async function deviceBPrepare() {
  if (deviceBAligned) return
  await gitAt(DEVICE_B, ['fetch', 'origin', 'main'])
  await gitAt(DEVICE_B, ['reset', '--hard', 'origin/main'])
  deviceBAligned = true
}

async function deviceBWrite(rel, content) {
  await deviceBPrepare()
  const abs = path.join(DEVICE_B, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf-8')
}

async function deviceBRm(rel) {
  await deviceBPrepare()
  fs.rmSync(path.join(DEVICE_B, rel), { recursive: true, force: true })
}

async function gitAt(dir, args) {
  return execFileAsync('git', ['-C', dir, ...args], { timeout: 60_000 })
}

async function deviceBPush(message) {
  await gitAt(DEVICE_B, ['add', '-A'])
  await gitAt(DEVICE_B, [
    '-c', 'user.email=b@test', '-c', 'user.name=DeviceB',
    'commit', '-m', message, '--allow-empty',
  ])
  await gitAt(DEVICE_B, ['push', 'origin', 'main'])
  deviceBAligned = false
}

// ────────────────────────────────────────────────
// 用例（全部 async —— device-B 与 CLI 都走网络）
// ────────────────────────────────────────────────

const CASES = []
const defineCase = (id, title, fn) => CASES.push({ id, title, fn })

/** 失败时的现场转储：本地文件、远端 tree、sync 仓提交历史 */
function dumpDiagnostics() {
  const listDir = (d) => {
    try {
      return fs.readdirSync(d)
    } catch {
      return '(不存在)'
    }
  }
  const syncGit = (args) => {
    try {
      return execFileSync('git', ['-C', path.join(DATA_ROOT, 'sync'), ...args], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim()
    } catch (e) {
      return `(失败: ${String(e.message).slice(0, 80)})`
    }
  }
  const remote = (() => {
    try {
      return remoteTree()
    } catch (e) {
      return `(读取失败: ${String(e.message).slice(0, 80)})`
    }
  })()
  return [
    `  本地 workspace/files: ${JSON.stringify(listDir(path.join(WORKSPACE, 'files')))}`,
    `  sync 工作树 files: ${JSON.stringify(listDir(path.join(DATA_ROOT, 'sync', 'workspace', 'files')))}`,
    `  远端 tree: ${JSON.stringify(remote)}`,
    `  sync 仓 HEAD: ${syncGit(['log', '--oneline', '-6'])}`,
    `  sync 仓状态: ${syncGit(['status', '--porcelain'])}`,
  ].join('\n')
}

/** sync 仓 HEAD 的原始内容：`ref: refs/heads/main` = attached，纯 oid = detached */
function readHeadState() {
  try {
    const p = path.join(DATA_ROOT, 'sync', '.git', 'HEAD')
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '(无 sync 仓)'
  } catch {
    return '(读取失败)'
  }
}

/** async 版 runCase：harness 的 runCase 不 await 回调，无法用于本套件 */
async function runCaseAsync(ev, id, fn) {
  const start = Date.now()
  const headBefore = readHeadState()
  try {
    const note = await fn()
    ev.record(id, 'PASS', note ?? 'ok', {
      durationMs: Date.now() - start,
      headBefore,
      headAfter: readHeadState(),
    })
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // 附上客户端状态与现场：status.message 会写明走了哪个同步分支
    // （「首次推送完成」意味着 fetch 没拿到远端 ref，与「同步完成」是两类问题）
    let diag = ''
    try {
      const s = await uiAsync(['cloudsync', 'status'], { timeoutMs: 30_000 })
      diag = `\n  客户端状态: ${JSON.stringify(s.json?.status)}\n${dumpDiagnostics()}`
    } catch {
      /* 诊断尽力而为 */
    }
    ev.record(id, 'FAIL', msg + diag, {
      durationMs: Date.now() - start,
      headBefore,
      headAfter: readHeadState(),
      stack: err instanceof Error ? err.stack : undefined,
    })
    return false
  }
}

// ── A 组：本地 → 远端 ─────────────────────────────

defineCase('SYNC-E2E-01', '首次同步把本地 workspace 文件推送到远端', async () => {
  localWrite('files/first.md', 'v1')
  const r = await syncNow()
  if (!r.success) throw new Error(`首次同步未成功: ${JSON.stringify(r)}`)
  if (remoteRead('workspace/files/first.md')?.trim() !== 'v1') {
    throw new Error('远端没有拿到首次同步的文件')
  }
  return '远端已收到 workspace/files/first.md'
})

defineCase('SYNC-E2E-02', '本地新增文件同步后出现在远端', async () => {
  localWrite('files/added.md', 'added')
  await syncNow()
  if (!remoteExists('workspace/files/added.md')) throw new Error('远端缺少新增文件')
  return '新增已传播'
})

defineCase('SYNC-E2E-03', '本地修改文件同步后远端内容更新', async () => {
  localWrite('files/first.md', 'v2')
  await syncNow()
  const got = remoteRead('workspace/files/first.md')?.trim()
  if (got !== 'v2') throw new Error(`远端内容未更新，实际: ${got}`)
  return '修改已传播'
})

defineCase('SYNC-E2E-04', '本地删除文件同步后从远端消失（核心回归）', async () => {
  if (!remoteExists('workspace/files/added.md')) throw new Error('前置失败：远端本应有 added.md')
  localRm('files/added.md')
  await syncNow()
  if (remoteExists('workspace/files/added.md')) {
    throw new Error('远端仍保留已删除文件 —— 删除未传播（本次修复要解决的核心缺陷）')
  }
  if (!remoteExists('workspace/files/first.md')) throw new Error('删除把无关文件也带走了')
  return '删除已传播，无关文件未受影响'
})

defineCase('SYNC-E2E-05', 'outputs 目录的删除同样传播', async () => {
  localWrite('outputs/report.md', 'r1')
  await syncNow()
  if (!remoteExists('workspace/outputs/report.md')) throw new Error('outputs 未上传')
  localRm('outputs/report.md')
  await syncNow()
  if (remoteExists('workspace/outputs/report.md')) throw new Error('outputs 删除未传播')
  return 'outputs 增删均传播'
})

// ── B 组：远端 → 本地 ─────────────────────────────

defineCase('SYNC-E2E-06', '远端新增文件同步后出现在本地', async () => {
  await deviceBWrite('workspace/files/from-b.md', 'device B content')
  await deviceBPush('B 新增文件')
  await syncNow()
  if (localRead('files/from-b.md') !== 'device B content') {
    throw new Error('本地未拉到远端新增文件')
  }
  return '远端新增已拉取到本地'
})

defineCase('SYNC-E2E-07', '远端删除文件同步后本地也删除', async () => {
  await deviceBRm('workspace/files/from-b.md')
  await deviceBPush('B 删除文件')
  await syncNow()
  if (localExists('files/from-b.md')) throw new Error('本地未跟随远端删除')
  return '远端删除已传播到本地'
})

defineCase('SYNC-E2E-08', '远端修改文件同步后本地内容更新', async () => {
  await deviceBWrite('workspace/files/first.md', 'v3-from-b')
  await deviceBPush('B 修改文件')
  await syncNow()
  const got = localRead('files/first.md')
  if (got !== 'v3-from-b') throw new Error(`本地内容未更新，实际: ${got}`)
  return '远端修改已拉取到本地'
})

// ── C 组：无冲突合并 ──────────────────────────────

defineCase('SYNC-E2E-09', '本地与远端改不同文件时自动合并，双方内容都保留', async () => {
  localWrite('files/local-side.md', 'L')
  await deviceBWrite('workspace/files/remote-side.md', 'R')
  await deviceBPush('B 改另一个文件')
  const r = await syncNow()
  if (!r.success) throw new Error(`自动合并失败: ${JSON.stringify(r)}`)
  if (remoteRead('workspace/files/local-side.md')?.trim() !== 'L') throw new Error('本地改动丢失')
  if (localRead('files/remote-side.md') !== 'R') throw new Error('远端改动丢失')
  return '无冲突自动合并成功'
})

// ── D 组：异常路径 ────────────────────────────────

defineCase('SYNC-E2E-10', 'git 服务端 5xx 时同步失败但不崩、状态可恢复', async () => {
  await syncNow() // 先归零
  gitServer.state.failAll = true
  let during
  try {
    during = await syncNow({ allowFail: true, label: '故障期同步' })
  } finally {
    gitServer.state.failAll = false
  }
  if (during.state === 'syncing') throw new Error('同步卡在 syncing，未正确收尾')
  const recovered = await syncNow()
  if (!recovered.success) throw new Error('服务恢复后同步仍失败')
  return `故障期 state=${during.state}，恢复后同步成功`
})

defineCase('SYNC-E2E-11', '认证失败（token 不匹配）时同步不成功且不污染远端', async () => {
  await syncNow()
  const before = gitBare(['rev-parse', 'main']).trim()
  writeCloudSyncConfig(DATA_ROOT, { repoUrl: REPO_URL, token: 'wrong-token', intervalMinutes: 1440 })
  localWrite('files/after-auth-fail.md', 'x')
  let r
  try {
    r = await syncNow({ allowFail: true, label: '认证失败同步' })
  } finally {
    writeCloudSyncConfig(DATA_ROOT, { repoUrl: REPO_URL, token: TOKEN, intervalMinutes: 1440 })
  }
  const after = gitBare(['rev-parse', 'main']).trim()
  if (after !== before) throw new Error('认证失败却改动了远端')
  if (remoteExists('workspace/files/after-auth-fail.md')) throw new Error('认证失败的文件不该进远端')
  return `认证失败未污染远端（state=${r.state}）`
})

defineCase('SYNC-E2E-12', '未启用云同步时 sync 返回 success:false 且不改动任何数据', async () => {
  writeCloudSyncConfig(DATA_ROOT, { repoUrl: REPO_URL, token: TOKEN, enabled: false })
  let r
  try {
    r = await syncNow({ allowFail: true, label: '未启用同步' })
  } finally {
    writeCloudSyncConfig(DATA_ROOT, { repoUrl: REPO_URL, token: TOKEN, enabled: true })
  }
  if (r.success !== false) throw new Error('未启用时不该返回 success')
  if (r.state !== 'idle') throw new Error(`未启用时状态应为 idle，实际 ${r.state}`)
  return '未启用时安全短路'
})

/**
 * 批量删除安全阀（2026-09-16 事故回归）。
 *
 * 用 **201 个文件**（> SYNC_MIRROR_MAX_DELETES=200）触发「数量上限」这条判定，
 * 而不是原来 12 个文件靠「>50% 占比」—— 占比的分母是整个 sync 树的条目数，
 * 全套件跑下来会随其它用例浮动，单独跑 SYNC_E2E_ONLY 时又完全不同，
 * 结果这个用例的通过与否取决于跑在它前面的用例，不可靠。
 */
defineCase('SYNC-E2E-13', '超阈值删除：挡下后不自动放行，仅凭指纹确认才执行', async () => {
  const names = Array.from({ length: 201 }, (_, i) => `bulk-${i}.md`)
  for (const n of names) localWrite(`files/${n}`, 'x')
  await syncNow()
  const countBulk = () => remoteTree().filter((p) => p.startsWith('workspace/files/bulk-')).length
  const before = countBulk()
  if (before !== 201) throw new Error(`前置失败：远端应 201 个 bulk 文件，实际 ${before}`)

  for (const n of names) localRm(`files/${n}`)

  // ── 第 1 次同步：安全阀挡下，待删集合进 pendingMassDelete ──
  await syncNow()
  const s1 = await uiAsync(['cloudsync', 'status'], { timeoutMs: 30_000 })
  const pending = s1.json?.status?.pendingMassDelete
  if (!pending) {
    throw new Error(`安全阀未挡下（status 无 pendingMassDelete）: ${JSON.stringify(s1.json)}`)
  }
  if (pending.count !== 201) throw new Error(`待删项数应为 201，实际 ${pending.count}`)
  if (typeof pending.fingerprint !== 'string' || pending.fingerprint.length === 0) {
    throw new Error('pendingMassDelete 未给出指纹，用户无从确认')
  }
  const afterFirst = countBulk()
  if (afterFirst !== 201) {
    throw new Error(`安全阀未生效：远端 bulk 从 201 变成 ${afterFirst}（不该删）`)
  }

  // ── 第 2 次同步：**本用例的核心断言，也是事故根因的回归点** ──
  // 旧实现：第一次挡下时置位布尔 massDeleteConfirmed，下一次自动同步即视为用户确认，
  // 201 个文件会被静默删光（9-16 远端被清空 896 个文件即此路径）。
  // 新实现：只认与当前待删集合完全一致的显式指纹，自动同步永远拿不到，必须继续挡。
  await syncNow()
  const afterSecond = countBulk()
  if (afterSecond !== 201) {
    throw new Error(
      `⚠️ 再次同步被自动放行，删掉了 ${201 - afterSecond} 个文件 —— 2026-09-16 事故回归！`,
    )
  }

  // ── 错误指纹：必须拒绝 ──
  const bad = await uiAsync(['cloudsync', 'confirm-delete', '--fingerprint', 'deadbeefdeadbeef'])
  if (bad.json?.success !== false) {
    throw new Error(`错误指纹不该被接受: ${JSON.stringify(bad.json)}`)
  }
  if (countBulk() !== 201) throw new Error('错误指纹竟触发了删除')

  // ── 正确指纹：接受；删除在该次同步中执行 ──
  const ok = await uiAsync(['cloudsync', 'confirm-delete', '--fingerprint', pending.fingerprint])
  if (ok.json?.success !== true) {
    throw new Error(`正确指纹应被接受: ${JSON.stringify(ok.json)}`)
  }
  await syncNow()
  const afterConfirm = countBulk()
  if (afterConfirm !== 0) throw new Error(`确认后仍残留 ${afterConfirm} 个 bulk 文件`)
  return '挡下 → 再次同步仍挡下（事故回归）→ 错误指纹拒绝 → 正确指纹放行'
})

// ── E 组：边界 ────────────────────────────────────

defineCase('SYNC-E2E-14', '嵌套目录结构完整同步，删除也传播', async () => {
  localWrite('files/deep/a/b/c/nested.md', 'deep')
  await syncNow()
  if (remoteRead('workspace/files/deep/a/b/c/nested.md')?.trim() !== 'deep') {
    throw new Error('嵌套文件未同步')
  }
  localRm('files/deep')
  await syncNow()
  if (remoteExists('workspace/files/deep/a/b/c/nested.md')) throw new Error('嵌套目录删除未传播')
  return '嵌套目录增删均正确'
})

defineCase('SYNC-E2E-15', '排除 .git 与 node_modules，不进同步仓', async () => {
  fs.mkdirSync(localPath('files/proj/.git'), { recursive: true })
  fs.writeFileSync(localPath('files/proj/.git/config'), 'x')
  fs.mkdirSync(localPath('files/proj/node_modules/pkg'), { recursive: true })
  fs.writeFileSync(localPath('files/proj/node_modules/pkg/index.js'), 'x')
  localWrite('files/proj/keep.md', 'keep')
  await syncNow()
  const tree = remoteTree()
  if (tree.some((p) => p.includes('.git/'))) throw new Error('.git 进了同步仓')
  if (tree.some((p) => p.includes('node_modules/'))) throw new Error('node_modules 进了同步仓')
  if (remoteRead('workspace/files/proj/keep.md')?.trim() !== 'keep') {
    throw new Error('同目录下的正常文件反而没同步')
  }
  return '重目录被正确剪枝'
})

defineCase('SYNC-E2E-16', 'profile（soul.md）随同步传播', async () => {
  const soulPath = path.join(DATA_ROOT, 'data', 'soul.md')
  fs.mkdirSync(path.dirname(soulPath), { recursive: true })
  fs.writeFileSync(soulPath, '# my soul\n')
  await syncNow()
  if (remoteRead('profile/soul.md')?.trim() !== '# my soul') {
    throw new Error('soul.md 未同步到远端')
  }
  return 'profile 已同步'
})

defineCase('SYNC-E2E-17', '重复同步幂等：无变更时不产生额外提交', async () => {
  await syncNow()
  const before = gitBare(['rev-parse', 'main']).trim()
  const r = await syncNow()
  const after = gitBare(['rev-parse', 'main']).trim()
  if (!r.success) throw new Error('无变更时同步应成功')
  if (after !== before) throw new Error('无变更却产生了新提交（非幂等）')
  return '重复同步不产生空提交'
})

// ── C 组续：真冲突放最后 —— 进入 conflict 后，客户端会在后续 sync 上被重入守卫挡回，
//    放中间会连带影响其余用例（用例内需用 cloudsync resolve 收尾）。 ──

defineCase('SYNC-E2E-18', '双方改同一文件时进入 conflict 状态且不误推送', async () => {
  localWrite('files/contested.md', 'base')
  await syncNow() // 两侧都以 base 为基线

  // 本地先改（但先不同步），远端再改 —— 这样合并时双方各有新提交，才会真冲突。
  // 若在远端改后先同步一次，本地会快进到远端版本，冲突就构造不出来了。
  localWrite('files/contested.md', 'from A')
  await deviceBWrite('workspace/files/contested.md', 'from B')
  await deviceBPush('B 改 contested')

  const remoteBefore = remoteRead('workspace/files/contested.md')
  if (remoteBefore?.trim() !== 'from B') {
    throw new Error(`前置失败：远端应为 from B，实际 ${remoteBefore}`)
  }

  const r = await syncNow({ allowFail: true, label: '冲突同步' })
  if (r.state !== 'conflict') throw new Error(`期望 conflict，实际 ${r.state}`)
  const files = r.status?.conflict?.files ?? []
  if (!files.includes('workspace/files/contested.md')) {
    throw new Error(`冲突文件列表不含 contested.md: ${JSON.stringify(files)}`)
  }
  if (remoteRead('workspace/files/contested.md') !== remoteBefore) {
    throw new Error('冲突未解决时不应改动远端')
  }

  // 收尾落决（本套件新增 cloudsync resolve CLI）：不停在 conflict，避免后续用例被挡
  const rr = await uiAsync(['cloudsync', 'resolve', '--strategy', 'keep-local'], {
    timeoutMs: 300_000,
  })
  if (rr.json?.success !== true) throw new Error(`冲突收尾落决失败: ${JSON.stringify(rr.json)}`)
  return `进入 conflict 且远端未被覆盖（涉及 ${files.length} 个文件），落决收尾成功`
})

defineCase('SYNC-E2E-19', '冲突期间远端再前进：落决被拒后自动刷新快照并收敛（本 Incident 回归）', async () => {
  localWrite('files/stale.md', 'base')
  await syncNow()

  localWrite('files/stale.md', 'from A')
  await deviceBWrite('workspace/files/stale.md', 'from B')
  await deviceBPush('B 改 stale')

  const r = await syncNow({ allowFail: true, label: '冲突同步' })
  if (r.state !== 'conflict') throw new Error(`期望 conflict，实际 ${r.state}`)

  // 冲突期间另一台设备又推了一次：本地快照（remoteOid）就此过期
  await deviceBWrite('workspace/files/b-extra.md', 'extra-from-b')
  await deviceBPush('B 追加新文件')

  // 第一轮落决：push 必被拒（远端已不是快照里的 oid）→ 应返回「已刷新」而非死循环重试。
  // 旧实现此处会反复报 "Push rejected ... not a simple fast-forward" 永远卡死。
  const r1 = await uiAsync(['cloudsync', 'resolve', '--strategy', 'keep-local'], {
    timeoutMs: 300_000,
  })
  if (r1.json?.ok !== true) throw new Error(`resolve 调用失败: ${r1.out || r1.stderr}`)
  if (r1.json.success !== false || !String(r1.json.error ?? '').includes('刷新')) {
    throw new Error(`首轮落决应返回「已刷新」: ${JSON.stringify(r1.json)}`)
  }
  if (r1.json.state !== 'conflict') {
    throw new Error(`刷新后应仍在 conflict 等待重新处理: ${JSON.stringify(r1.json)}`)
  }

  // 第二轮：按刷新后的快照落决，成功收尾
  const r2 = await uiAsync(['cloudsync', 'resolve', '--strategy', 'keep-local'], {
    timeoutMs: 300_000,
  })
  if (r2.json?.ok !== true || r2.json.success !== true) {
    throw new Error(`第二轮落决应成功: ${JSON.stringify(r2.json)} / ${r2.out || r2.stderr}`)
  }
  const s = await uiAsync(['cloudsync', 'status'], { timeoutMs: 30_000 })
  if (s.json?.status?.state !== 'idle') {
    throw new Error(`落决后应回到 idle: ${JSON.stringify(s.json)}`)
  }

  // 收敛断言：本地版本胜出；远端在冲突期间的新提交没有被落决丢掉
  const merged = remoteRead('workspace/files/stale.md')
  if (merged?.trim() !== 'from A') {
    throw new Error(`远端应为本地版本 from A，实际 ${merged}`)
  }
  const extra = remoteRead('workspace/files/b-extra.md')
  if (extra?.trim() !== 'extra-from-b') {
    throw new Error('冲突期间远端新增的文件在落决时被丢掉了（回归）')
  }
  return '落决被拒 → 快照自动刷新 → 二轮收敛，远端新提交未丢失'
})

// ── F 组：分级传输与同步范围（v3+，2026-09-17） ──

/** 等某文件出现在远端（阶段二是后台队列，没有可等待的同步返回值） */
async function waitForRemote(rel, { timeoutMs = 240_000 } = {}) {
  await waitFor(() => remoteExists(rel), {
    timeoutMs,
    intervalMs: 3_000,
    label: `阶段二补传 ${rel}`,
  })
}

defineCase('SYNC-E2E-20', '超阈值文件不阻塞阶段一，改由阶段二队列补传', async () => {
  const bigRel = 'workspace/outputs/tier/big.bin'
  const bigAbs = localPath('outputs/tier/big.bin')
  fs.mkdirSync(path.dirname(bigAbs), { recursive: true })
  // 8MB = 默认阈值（1MB）的 8 倍，确保落在阶段二
  fs.writeFileSync(bigAbs, Buffer.alloc(8 * 1024 * 1024, 'z'))
  localWrite('files/tier-small.md', 'small')

  const t0 = Date.now()
  await syncNow()
  const stage1Ms = Date.now() - t0

  // 用「提交归属」判定走的是哪条路 —— 同步返回后直接看远端有没有会和后台队列赛跑
  const exp = lastExportCommit()
  if (!exp) throw new Error('找不到阶段一提交（grep ^sync: export at 无结果）')
  if (!fileInCommit(exp, 'workspace/files/tier-small.md')) {
    throw new Error('小文件没进阶段一提交')
  }
  if (fileInCommit(exp, bigRel)) {
    throw new Error(`8MB 文件进了阶段一提交（阈值未生效），阶段一耗时 ${stage1Ms}ms`)
  }

  await waitForRemote(bigRel)
  const size = gitBare(['cat-file', '-s', `main:${bigRel}`]).toString().trim()
  if (size !== String(8 * 1024 * 1024)) {
    throw new Error(`远端大文件字节数 ${size} ≠ ${8 * 1024 * 1024}（内容不完整）`)
  }
  return `阶段一 ${stage1Ms}ms 未被 8MB 文件阻塞；阶段二补齐且字节数一致`
})

defineCase('SYNC-E2E-21', '已传完的大文件不再重传（mtime 精度死循环回归）', async () => {
  const bigRel = 'workspace/outputs/tier/big.bin'
  const srcAbs = localPath('outputs/tier/big.bin')
  const mirrorAbs = path.join(DATA_ROOT, 'sync/workspace/outputs/tier/big.bin')
  if (!remoteExists(bigRel)) throw new Error('前置失败：需先跑 SYNC-E2E-20')

  // 直接断言修复本体：镜像副本的 mtime 必须落在源的容差内。
  // 修复前 copyFileSync 不回写 mtime，目标恒为复制时刻，比对永远判「已变更」。
  const srcMs = fs.statSync(srcAbs).mtimeMs
  const dstMs = fs.statSync(mirrorAbs).mtimeMs
  const delta = Math.abs(dstMs - srcMs)
  if (delta > 2) {
    throw new Error(`镜像 mtime 与源差 ${delta.toFixed(2)}ms（应在 2ms 容差内，否则必然重传）`)
  }

  const quiet = async () =>
    waitFor(
      async () => {
        const s = await uiAsync(['cloudsync', 'status'], { timeoutMs: 30_000 })
        const q = s.json?.status?.largeQueue
        return q && q.pumping === false && q.pendingFiles === 0
      },
      { timeoutMs: 180_000, intervalMs: 2_500, label: '阶段二队列静默' },
    )

  const before = batchCommitCount()
  const tipBefore = gitBare(['rev-parse', 'main']).toString().trim()
  for (let i = 0; i < 2; i++) {
    await syncNow()
    await quiet()
  }
  const after = batchCommitCount()
  if (after !== before) {
    throw new Error(`重复同步又产生了 ${after - before} 个大文件批次提交（重传回归）`)
  }
  const tipAfter = gitBare(['rev-parse', 'main']).toString().trim()
  return `mtime 差 ${delta.toFixed(2)}ms；两轮同步零重传（tip ${tipBefore.slice(0, 7)}→${tipAfter.slice(0, 7)}）`
})

defineCase('SYNC-E2E-22', '范围规则：排除项不参与同步，强制包含无视阈值走阶段一', async () => {
  await withConfig(
    { syncExcludePatterns: ['*.secret'], syncForceIncludePatterns: ['forced-*.bin'] },
    async () => {
      localWrite('files/a.secret', 'should-not-sync')
      localWrite('outputs/b.secret', 'should-not-sync')
      localWrite('files/plain.md', 'plain')
      // 2MB：在 1MB 阈值之上，但被 forceInclude 命中 → 应回到阶段一
      const forcedAbs = localPath('outputs/forced-big.bin')
      fs.mkdirSync(path.dirname(forcedAbs), { recursive: true })
      fs.writeFileSync(forcedAbs, Buffer.alloc(2 * 1024 * 1024, 'f'))

      await syncNow()

      if (remoteExists('workspace/files/a.secret')) {
        throw new Error('files/ 下的排除项被同步了（排除规则未覆盖 files/）')
      }
      if (remoteExists('workspace/outputs/b.secret')) {
        throw new Error('outputs/ 下的排除项被同步了')
      }
      if (remoteRead('workspace/files/plain.md')?.trim() !== 'plain') {
        throw new Error('同目录下的正常文件反而没同步')
      }
      const exp = lastExportCommit()
      if (!fileInCommit(exp, 'workspace/outputs/forced-big.bin')) {
        throw new Error('强制包含未生效：2MB 文件没进阶段一提交')
      }
      // 被排除的项不得因「镜像删除」而被当成删除信号（名字应留在 srcNames 里）
      if (remoteExists('workspace/files/plain.md') === false) {
        throw new Error('排除规则连带删掉了正常文件')
      }
    },
  )

  // 撤掉规则后应恢复同步 —— 排除是规则不是永久拉黑
  await syncNow()
  if (!remoteExists('workspace/files/a.secret')) {
    throw new Error('撤掉排除规则后 .secret 仍不同步')
  }
  return '排除命中 files/ 与 outputs/ 均不传；强制包含把 2MB 拉回阶段一；撤规则后恢复'
})

// ────────────────────────────────────────────────
// 执行
// ────────────────────────────────────────────────

let gitServer = null
let client = null
let REPO_URL = ''

async function main() {
  const ev = createEvidence(
    import.meta.dirname,
    'sync-e2e',
    '云同步端到端（真实客户端 + 本地 git 远程）',
  )

  // 前置：本地 git 远程
  GIT_ROOT = makeTempRoot('gitroot')
  BARE = path.join(GIT_ROOT, 'repo.git')
  execFileSync('git', ['init', '--bare', '-b', 'main', BARE])
  execFileSync('git', ['-C', BARE, 'config', 'http.receivepack', 'true'])
  gitServer = createGitServer({
    root: GIT_ROOT,
    requireAuth: true,
    password: TOKEN,
    verbose: VERBOSE,
  })
  const port = await gitServer.listen()
  REPO_URL = `http://127.0.0.1:${port}/repo.git`

  // 配置必须在客户端启动前写好：SyncScheduler 冷启动 30s 后会自行首同步
  fs.mkdirSync(DATA_ROOT, { recursive: true })
  writeCloudSyncConfig(DATA_ROOT, { repoUrl: REPO_URL, token: TOKEN, intervalMinutes: 1440 })

  console.log(`[setup] 数据目录 ${DATA_ROOT}`)
  console.log(`[setup] 远端 ${REPO_URL}`)

  client = await startClient({ dataRoot: DATA_ROOT })
  await waitForReady(DATA_ROOT, 180_000)
  console.log('[setup] 客户端控制口就绪')

  // 模拟设备 B 的 clone 走 HTTP，必须等 git server 就绪且客户端不抢事件循环
  DEVICE_B = makeTempRoot('device-b')
  try {
    await execFileAsync('git', ['clone', REPO_URL.replace('http://', `http://oauth2:${TOKEN}@`), DEVICE_B], {
      timeout: 30_000,
    })
  } catch (err) {
    const detail = [err.stdout?.toString(), err.stderr?.toString()]
      .filter((s) => s && s.trim())
      .join(' | ')
      .trim()
    throw new Error(`模拟「另一台设备」的 clone 失败: ${detail || err.message}`)
  }

  // 预热：让冷启动调度器的首同步先跑完，避免与首个用例竞态
  await uiAsync(['cloudsync', 'sync'], { timeoutMs: 180_000 })
  console.log('[setup] 预热同步完成\n')

  const selected = ONLY ? CASES.filter((c) => c.id === ONLY) : CASES
  if (ONLY && selected.length === 0) throw new Error(`未找到用例 ${ONLY}`)

  console.log(`[run] 共 ${selected.length} 个用例\n`)
  let consecutiveFails = 0
  for (const c of selected) {
    const ok = await runCaseAsync(ev, c.id, () => c.fn().then((note) => `${c.title} —— ${note}`))
    consecutiveFails = ok ? 0 : consecutiveFails + 1
    if (consecutiveFails >= 3) {
      console.error('⛔ 连续 3 个用例失败，提前终止（请检查环境）')
      break
    }
  }

  ev.writeReport({
    meta: {
      被测端: `真实 Electron 客户端（LUMII_CLIENT_DATA_DIR=${DATA_ROOT}）`,
      驱动方式: 'app-ui-cli（lumii-ui.mjs）经 app-ui-control HTTP 控制口驱动',
      远程仓库: `本地 smart-HTTP git 服务器（git http-backend），裸仓库 ${BARE}`,
      运行命令: 'node docs/test/lumii-cli/cloud-sync/run-sync-e2e.mjs',
      环境变量: `SYNC_E2E_ONLY=${ONLY ?? '(全部)'} SYNC_E2E_VERBOSE=${VERBOSE ? '1' : '0'}`,
      覆盖范围:
        '本地→远端增删改、远端→本地增删改、无冲突自动合并、冲突检测、冲突落决（含快照过期重试）、' +
        '服务端 5xx、认证失败、未启用短路、批量删除安全阀（含指纹确认与「不自动放行」事故回归）、' +
        '嵌套目录、重目录剪枝、profile 同步、幂等性、' +
        '分级传输（超阈值文件不阻塞阶段一 + 阶段二补传 + mtime 容差零重传）、同步范围规则（排除/强制包含）',
      已知限制:
        'Agent 侧 5 个云同步工具（cloud_sync_read_file / resolve_sync_conflict / cloud_sync_git / ' +
        'cloud_sync_push / cloud_sync_now）需要真实 LLM 与真实会话，不进本套件（会引入非确定性）；' +
        '日常由 apps/windows/src/main/agent-runtime/bridge-tool-registrar-sync.test.ts 覆盖，' +
        '端到端由人工用 lumii-ui send 对真实客户端验证。' +
        '同步范围规则里的 glob 按**每层目录名**匹配（如 *.secret 命中任意层级），' +
        '不支持 docs/*.secret 这类带目录前缀的路径模式。',
    },
  })
}

main()
  .catch((err) => {
    console.error('\n[套件异常]', err?.stack ?? err)
    process.exitCode = 1
  })
  .finally(async () => {
    if (VERBOSE && client?.logs?.length) {
      console.log('--- 客户端日志尾部 ---')
      console.log(client.logs.join('').split('\n').slice(-30).join('\n'))
    }
    try {
      await client?.stop()
    } catch {
      /* 尽力而为 */
    }
    try {
      await gitServer?.close()
    } catch {
      /* 尽力而为 */
    }
    for (const d of [DATA_ROOT, `${DATA_ROOT}-userdata`, DEVICE_B, GIT_ROOT]) {
      if (d && fs.existsSync(d)) await removeDirWithRetry(d, 6)
    }
    console.log('\n[teardown] 临时目录已清理')
  })
