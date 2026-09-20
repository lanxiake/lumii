/**
 * 启动期同步备份的开销 —— 量化 `backupOnOpen` 那条路径。
 *
 * ## 背景
 *
 * 每次启动都会跑（`bridge.ts:753` → `storage/backup.ts:257`）：
 *
 *     await this.localDb.open({ dbPath, backupOnOpen: true })
 *          └→ startScheduledDatabaseBackup({ backupOnOpen: true })
 *               └→ if (backupOnOpen) run()        ← **同步**，在主线程上
 *                    ├→ PRAGMA wal_checkpoint(FULL)
 *                    ├→ fs.copyFileSync(整个 db)
 *                    └→ pruneOldBackups()
 *
 * 启动捕获（docs/fix/2026-09-20-...md §6.11）的栈里出现了 `runBackupNow`，
 * 因此它是个嫌疑。**本脚本用来证实或排除它。**
 *
 * ## 安全边界
 *
 * **绝不 checkpoint live 库** —— 那会写用户正在用的数据库。
 * 主库/WAL/SHM 三个文件整体复制到临时目录，checkpoint 只在副本上跑。
 * 源文件只读。
 *
 *   node scripts/probe-startup-backup-cost.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dataDir = path.join(os.homedir(), '.lumii', 'data')
const tmpDir = path.join(os.tmpdir(), 'lumii-startup-backup-probe')

const sizeOf = (p) => {
  try {
    return fs.statSync(p).size
  } catch {
    return 0
  }
}
const mb = (n) => (n / 1048576).toFixed(0)
const ms = (t) => (Number(t) / 1e6).toFixed(0)

const dbPath = path.join(dataDir, 'agent-runtime.db')
if (!fs.existsSync(dbPath)) {
  console.error(`找不到数据库：${dbPath}`)
  process.exit(1)
}

console.log('=== 当前尺寸 ===')
console.log(`  主库 ${mb(sizeOf(dbPath))} MB`)
console.log(`  WAL  ${mb(sizeOf(dbPath + '-wal'))} MB\n`)

// ── 1. fs.copyFileSync（runBackupNow 里那一步）────────────────────────────
const dstCopy = path.join(os.tmpdir(), 'lumii-backup-probe.db')
console.log('=== fs.copyFileSync（备份复制那步）===')
const copies = []
for (let i = 0; i < 3; i++) {
  const t = process.hrtime.bigint()
  fs.copyFileSync(dbPath, dstCopy)
  copies.push(Number(process.hrtime.bigint() - t) / 1e6)
}
fs.rmSync(dstCopy, { force: true })
console.log(`  三次：${copies.map((c) => c.toFixed(0) + 'ms').join(' / ')}`)
console.log('  ⚠️ 很快是正常的：NTFS 上大文件复制走缓存，不等于备份不贵\n')

// ── 2. wal_checkpoint(FULL)（在副本上）────────────────────────────────────
console.log('=== PRAGMA wal_checkpoint(FULL)（在副本上跑，不碰 live 库）===')
fs.rmSync(tmpDir, { recursive: true, force: true })
fs.mkdirSync(tmpDir, { recursive: true })
const probeDb = path.join(tmpDir, 'probe.db')
const pairs = [
  ['agent-runtime.db', 'probe.db'],
  ['agent-runtime.db-wal', 'probe.db-wal'],
  ['agent-runtime.db-shm', 'probe.db-shm'],
]
let copiedWal = 0
for (const [src, dst] of pairs) {
  const from = path.join(dataDir, src)
  if (!fs.existsSync(from)) continue
  fs.copyFileSync(from, path.join(tmpDir, dst))
  if (dst.endsWith('-wal')) copiedWal = sizeOf(path.join(tmpDir, dst))
}
console.log(`  副本主库 ${mb(sizeOf(probeDb))} MB，副本 WAL ${mb(copiedWal)} MB`)

if (copiedWal === 0) {
  console.log('  副本没有 WAL（live 库当时 WAL 为空）→ checkpoint 无从测量')
} else {
  const conn = new DatabaseSync(probeDb)
  const t = process.hrtime.bigint()
  conn.exec('PRAGMA wal_checkpoint(FULL)')
  const cost = Number(process.hrtime.bigint() - t) / 1e6
  // 返回 (busy, log, checkpointed)：checkpointed < log 说明只合并了一部分
  const row = conn.prepare('PRAGMA wal_checkpoint(FULL)').get()
  console.log(`  耗时 ${ms(BigInt(Math.round(cost * 1e6)))} ms`)
  console.log(`  第二次调用的返回：${JSON.stringify(row)}（busy/log/checkpointed）`)
  console.log(`  checkpoint 后副本 WAL ${mb(sizeOf(probeDb + '-wal'))} MB`)
  conn.close()
}

// ── 3. pruneOldBackups（遍历备份目录）─────────────────────────────────────
const backupDir = path.join(dataDir, 'backups')
console.log('\n=== pruneOldBackups（备份目录遍历）===')
try {
  const names = fs.readdirSync(backupDir)
  const baks = names.filter((n) => n.endsWith('.bak'))
  console.log(`  目录项 ${names.length} 个，其中 .bak ${baks.length} 个`)
  console.log(baks.length === 0 ? '  → 无 .bak，遍历近乎零成本' : '  → 需按 mtime 排序，成本随数量增长')
} catch {
  console.log('  备份目录不存在 → 零成本')
}

fs.rmSync(tmpDir, { recursive: true, force: true })
console.log('\n=== 判读 ===')
console.log('把上面三项加起来与捕获里的停摆时长比：')
console.log('  合计 ≪ 停摆  ⇒ 备份**不是**那次停摆的成因，去别处找（不要凭栈里有 runBackupNow 就定罪）')
console.log('  合计 ≈ 停摆  ⇒ 备份是成因，改法是把它移出启动路径（异步 / 延后 / 增量）')
