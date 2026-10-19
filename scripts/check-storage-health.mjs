#!/usr/bin/env node
/**
 * 存储体检（**只读**）—— 检查 Lumii 本地数据目录的膨胀与「静默停摆」。
 *
 * 为什么需要它：两个 git 仓库都会无界增长，且失败方式都是**静默的**
 * （2026-10-11 一次崩溃留下 0 字节 index.lock，工作区快照停摆 8 天，
 * 日志里只有 WARN「自动快照失败（已忽略，不影响对话）」）。
 *
 * 检查项：
 *   1. 陈旧 lock —— 两个仓库（workspace/.mtbot-vcs、sync/.git）
 *   2. 快照停摆 —— 有改动但最近一次提交超过 STALE_DAYS 天
 *   3. 对象库形状 —— 松对象数 / pack 数 / 体积
 *   4. 同步失败快照残留（sync-broken-* 等）
 *   5. outputs 里文本 / 二进制占比
 *
 * 用法：
 *   node scripts/check-storage-health.mjs
 *   LUMII_HOME=/tmp/fake node scripts/check-storage-health.mjs
 *
 * 退出码：0 全部正常；1 有告警（适合挂定时任务）。
 * 不写任何文件，不改任何配置。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const HOME = process.env.LUMII_HOME || path.join(os.homedir(), '.lumii')
const WORKSPACE = path.join(HOME, 'workspace')
const VCS_DIR = path.join(WORKSPACE, '.mtbot-vcs')
const SYNC_DIR = path.join(HOME, 'sync')
const SYNC_GIT = path.join(SYNC_DIR, '.git')
const OUTPUTS = path.join(WORKSPACE, 'outputs')

/** 超过这么久没提交、而工作区又有改动 → 判为停摆 */
const STALE_DAYS = 7
/** lock 文件超过这么久且无人持有 → 判为陈旧（没有 PID 可查，只能按时效猜） */
const LOCK_STALE_MS = 10 * 60 * 1000

const warnings = []
const warn = (msg) => {
  warnings.push(msg)
  console.log(`  ⚠️  ${msg}`)
}
const ok = (msg) => console.log(`  ✅  ${msg}`)
const info = (msg) => console.log(`     ${msg}`)

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeout ?? 30_000,
    windowsHide: true,
    cwd: opts.cwd,
  })
  return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

/** 目录总字节数（迭代，避免深递归栈溢出） */
function dirSize(root) {
  let total = 0
  let count = 0
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile()) {
        try {
          total += fs.statSync(p).size
          count++
        } catch {
          /* 竞态删除 */
        }
      }
    }
  }
  return { bytes: total, files: count }
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`
const gb = (bytes) => `${(bytes / 1073741824).toFixed(2)} GB`
const size = (bytes) => (bytes >= 1073741824 ? gb(bytes) : mb(bytes))

/** 找 gitdir 顶层残留的 lock 文件 */
function checkLocks(gitdir, label) {
  if (!fs.existsSync(gitdir)) return
  let stale = 0
  for (const name of fs.readdirSync(gitdir)) {
    if (!name.endsWith('.lock')) continue
    const p = path.join(gitdir, name)
    let st
    try {
      st = fs.statSync(p)
    } catch {
      continue
    }
    const ageMin = Math.round((Date.now() - st.mtimeMs) / 60000)
    if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
      stale++
      warn(`${label} 有陈旧锁 ${name}（${st.size} 字节，${ageMin} 分钟前）—— 会静默阻塞所有写操作`)
      info(`确认没有 git 进程后可删除：rm "${p}"`)
    } else {
      info(`${label} 有活动锁 ${name}（${ageMin} 分钟内），可能正在写入`)
    }
  }
  if (!stale) ok(`${label} 无陈旧锁`)
}

/** 读一个 git 仓库的形状 */
function gitShape(gitdir, cwd, label) {
  if (!fs.existsSync(gitdir)) {
    info(`${label} 不存在（未启用该功能则正常）`)
    return null
  }
  const commits = Number(
    run('git', ['--git-dir', gitdir, 'rev-list', '--count', '--all']).out || 0,
  )
  const last = run('git', ['--git-dir', gitdir, 'log', '-1', '--format=%ct %s'])
  const lastTs = Number(last.out.split(' ')[0] || 0)
  const lastDays = lastTs ? Math.floor((Date.now() / 1000 - lastTs) / 86400) : null

  const co = run('git', ['--git-dir', gitdir, 'count-objects', '-v'])
  const loose = Number(/^count:\s*(\d+)/m.exec(co.out)?.[1] ?? 0)
  const looseKiB = Number(/^size:\s*(\d+)/m.exec(co.out)?.[1] ?? 0)
  const inPack = Number(/^in-pack:\s*(\d+)/m.exec(co.out)?.[1] ?? 0)
  const packs = Number(/^packs:\s*(\d+)/m.exec(co.out)?.[1] ?? 0)

  const { bytes } = dirSize(gitdir)
  console.log(`  ${label}`)
  info(`提交 ${commits} 条，最后一条 ${lastDays === null ? '无' : `${lastDays} 天前`}`)
  info(`对象：松 ${loose}（${mb(looseKiB * 1024)}）/ pack ${packs} 个（${inPack} 对象）`)
  info(`磁盘占用 ${size(bytes)}`)

  if (loose > 1000 && packs === 0) {
    warn(`${label} 有 ${loose} 个松对象且无 pack —— 对象库从未打包，磁盘浪费且随提交线性增长`)
  }
  if (lastDays !== null && lastDays >= STALE_DAYS) {
    // 有改动才算停摆；无改动说明本来就没东西可提交
    const st = run('git', ['--git-dir', gitdir, 'status', '--porcelain'], { cwd })
    const dirty = st.out ? st.out.split('\n').length : 0
    if (dirty > 0) {
      warn(`${label} 已 ${lastDays} 天未提交，但工作区有 ${dirty} 处改动 —— 快照可能停摆（先查陈旧锁）`)
    } else {
      info(`已有 ${lastDays} 天未提交，但工作区无改动 —— 正常`)
    }
  }
  return { commits, lastDays, loose, packs, bytes }
}

console.log(`\nLumii 存储体检  ${new Date().toISOString()}  (${HOME})\n`)

// 1. 总量
if (!fs.existsSync(HOME)) {
  console.log(`目录不存在：${HOME}`)
  process.exit(0)
}
const total = dirSize(HOME)
console.log(`总占用 ${size(total.bytes)}（${total.files} 个文件）\n`)

// 2. 两个仓库的锁与形状
console.log('【锁】')
checkLocks(VCS_DIR, '工作区 VCS')
checkLocks(SYNC_GIT, '云同步仓库')

console.log('\n【工作区快照仓库 .mtbot-vcs】')
gitShape(VCS_DIR, WORKSPACE, 'WorkspaceVcs')

console.log('\n【云同步仓库 sync/.git】')
gitShape(SYNC_GIT, SYNC_DIR, 'CloudSync')
info('注意：git gc 只清理「不可达」对象；只要 blob 还被某个提交引用，就永远删不掉。')

// 3. 同步失败快照残留
console.log('\n【同步失败快照残留】')
const backups = fs
  .readdirSync(HOME)
  .filter((n) => /^sync-broken-|^sync\.lumii-sync-backup-|^damaged-/.test(n))
if (backups.length === 0) {
  ok('无残留')
} else {
  let sum = 0
  for (const n of backups) {
    const { bytes } = dirSize(path.join(HOME, n))
    sum += bytes
    info(`${n}  ${size(bytes)}`)
  }
  if (sum > 500 * 1048576) warn(`残留快照共 ${size(sum)}，建议确认后删除`)
  else ok(`残留快照共 ${size(sum)}（未超阈值）`)
}

// 4. outputs 文本 / 二进制占比
console.log('\n【outputs 构成】')
if (!fs.existsSync(OUTPUTS)) {
  info('outputs 不存在')
} else {
  const TEXT = new Set(['.md', '.json', '.jsonl', '.html', '.py', '.mjs', '.js', '.txt', '.csv', '.sh', '.yaml', '.yml', '.xml', '.css', '.ts'])
  let textBytes = 0
  let binBytes = 0
  let textCount = 0
  let binCount = 0
  const stack = [OUTPUTS]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        stack.push(p)
        continue
      }
      let st
      try {
        st = fs.statSync(p)
      } catch {
        continue
      }
      if (TEXT.has(path.extname(e.name).toLowerCase())) {
        textBytes += st.size
        textCount++
      } else {
        binBytes += st.size
        binCount++
      }
    }
  }
  info(`文本 ${textCount} 个 / ${size(textBytes)}`)
  info(`二进制 ${binCount} 个 / ${size(binBytes)}`)
  const ratio = binBytes / Math.max(1, textBytes + binBytes)
  info(`二进制占比 ${(ratio * 100).toFixed(1)}%`)
  if (binBytes > 200 * 1048576) {
    warn(`二进制产物 ${size(binBytes)} —— 它们进任何 git 仓库都会永久留在历史里`)
  }
}

// 汇总
console.log('')
if (warnings.length === 0) {
  console.log('结论：全部正常 ✅')
  process.exit(0)
}
console.log(`结论：${warnings.length} 条告警 ⚠️`)
for (const w of warnings) console.log(`  - ${w}`)
process.exit(1)
