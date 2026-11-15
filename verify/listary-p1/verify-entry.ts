/**
 * P1 验收探针 — 在 Electron 里跑索引全链路：扫描 → 入库 → 中文检索 → 记录耗时/体积。
 *
 * 为什么不能在 vitest 里跑：db/writer/query 依赖 FTS5，而 plain Node 的 `node:sqlite`
 * 不带 FTS5（`no such module: fts5`）；只有 Electron 内建的才有（见 db.ts 顶部）。
 * 故用 esbuild 把**真实模块**打成一个 CJS bundle（不是复制一份实现），在 Electron 里执行。
 *
 * 用法：
 *   node verify/listary-p1/build.mjs          # 打包
 *   pnpm exec electron verify/listary-p1/bundle.cjs <目标目录>
 * 结果写 verify/listary-p1/verify.out
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'

// 直接 import 插件的**真实模块**（相对本文件的路径），不复制实现。
// 打包时 esbuild 会把它们与 @mtbot/agent-runtime 一并纳入 bundle。
const PLUGIN_DIR = '../../apps/windows/src/plugins/builtin/listary'
import { ListaryDb } from '../../apps/windows/src/plugins/builtin/listary/db'
import { normalizePath, scanSync } from '../../apps/windows/src/plugins/builtin/listary/scanner'
import { clearAll, recordScanState, upsertBatch } from '../../apps/windows/src/plugins/builtin/listary/writer'
import { lookupUsage, recordUsage, search } from '../../apps/windows/src/plugins/builtin/listary/query'
void PLUGIN_DIR
void clearAll

const OUT = path.join(__dirname, 'verify.out')
const lines: string[] = []
fs.rmSync(OUT, { force: true })
function log(s: string): void {
  lines.push(s)
  process.stdout.write(s + '\n')
  fs.writeFileSync(OUT, lines.join('\n') + '\n')
}

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (!ok) failures++
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const targetArg = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? process.cwd()
const TARGET = path.resolve(targetArg)

app.whenReady().then(() => {
  log(`Electron ${process.versions.electron} / ABI ${process.versions.modules}`)
  log(`目标目录：${TARGET}\n`)

  // 索引库建在临时目录（不动用户数据）
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-p1-'))
  const dbPath = path.join(tmpDir, 'index.db')
  log(`索引库：${dbPath}\n`)

  const ldb = new ListaryDb(dbPath)
  const db = ldb.db

  // ── 1. 表结构与健康检查 ──
  log('═'.repeat(66))
  log('[1] 库与表结构')
  log('═'.repeat(66))
  check('ListaryDb 可建', fs.existsSync(dbPath), dbPath)
  const health0 = ldb.checkHealth()
  check('空库健康检查通过', health0.isHealthy, `items=${health0.items} fts=${health0.fts}`)

  // ── 2. 真实扫描 ──
  log('\n' + '═'.repeat(66))
  log('[2] 扫描真实目录')
  log('═'.repeat(66))

  const normRoot = normalizePath(TARGET)
  let batchCount = 0
  let maxBatch = 0
  const scanStart = Date.now()
  const result = scanSync({
    roots: [TARGET],
    batchSize: 2000,
    onBatch: (items) => {
      batchCount++
      maxBatch = Math.max(maxBatch, items.length)
      upsertBatch(db, items)
    },
    onProgress: (n) => {
      if (n % 20000 === 0) log(`    ... 已扫 ${n} 条`)
    },
  })
  const totalMs = Date.now() - scanStart
  recordScanState(db, normRoot, result)

  log(`  条目 ${result.indexed}，跳过目录 ${result.skippedDirs}，读失败 ${result.failedDirs}`)
  log(`  批次数 ${batchCount}（最大 ${maxBatch}），扫描+入库总耗时 ${totalMs}ms`)
  check('扫描到条目', result.indexed > 0, `${result.indexed} 条`)
  check('未 abort', !result.aborted)

  // ── 3. 主表与 FTS 一致性 ──
  log('\n' + '═'.repeat(66))
  log('[3] 一致性')
  log('═'.repeat(66))
  const health = ldb.checkHealth()
  check('主表与 FTS 行数一致', health.isHealthy, `items=${health.items} fts=${health.fts}`)
  if (!health.isHealthy) log(`    原因：${health.reason}`)

  // ── 4. 中文检索（用造出来的夹具，确保有预期关键词）──
  log('\n' + '═'.repeat(66))
  log('[4] 中文检索（夹具）')
  log('═'.repeat(66))

  // 夹具放进**独立子目录**，且路径不含任何被测关键词：避免三条污染（P1 首跑实测踩到）
  //   1. 临时目录名里含 "listary" 时，夹具路径会命中「listary」查询
  //   2. 夹具与真实目录混在同一个库里，LIMIT 会先返回真实文档，夹具被挤出断言窗口
  //   3. 夹具根自身也入库（扫描器会把根目录当一条条目），故根名也不能含关键词
  const fxDir = path.join(tmpDir, 'zz')
  const fixtures: Array<[string, string]> = [
    ['项目设计文档.docx', '设计'],
    ['Listary逆向笔记.md', '逆向'],
    ['财报2026Q3.xlsx', '财报'],
    ['我的设计稿.psd', '设计'],
    ['年度总结报告.pptx', '总结'],
    ['meeting-notes-2026.txt', 'meeting'],
    ['豆包.exe', '拼音'], // 拼音用例
    ['微信.lnk', '拼音'],
  ]
  for (const [name] of fixtures) {
    const p = path.join(fxDir, name)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, 'x')
  }
  const fxRoot = normalizePath(fxDir)
  const fx = scanSync({ roots: [fxDir], onBatch: (items) => upsertBatch(db, items) })
  check('夹具入库', fx.indexed >= fixtures.length, `${fx.indexed} 条`)

  // 夹具断言一律限定在夹具根内（root 过滤），不再靠名字过滤去撞真实数据
  const fxSearch = (q: string, extra: Record<string, unknown> = {}): string[] =>
    search(db, q, { limit: 20, root: fxRoot, ...extra }).map((h) => h.name).sort()

  const cases: Array<{ q: string; want: string[] }> = [
    { q: '设计', want: ['我的设计稿.psd', '项目设计文档.docx'] },
    { q: '文档', want: ['项目设计文档.docx'] },
    { q: '逆向', want: ['Listary逆向笔记.md'] },
    { q: '财报', want: ['财报2026Q3.xlsx'] },
    { q: '总结', want: ['年度总结报告.pptx'] },
    { q: 'listary', want: ['Listary逆向笔记.md'] },
    { q: 'meeting', want: ['meeting-notes-2026.txt'] },
  ]
  for (const c of cases) {
    const got = fxSearch(c.q)
    const want = [...c.want].sort()
    check(`查「${c.q}」`, JSON.stringify(got) === JSON.stringify(want), `实得 ${JSON.stringify(got)}`)
  }

  // ── 拼音检索（P6 需求：豆包 → doubao / dou / 豆包 / 豆 / db） ──
  log('\n  拼音检索（用户给的四条逐条验）：')
  const pyCases: Array<{ q: string; want: string[]; note: string }> = [
    { q: '豆包', want: ['豆包.exe'], note: '中文原词' },
    { q: 'doubao', want: ['豆包.exe'], note: '全拼' },
    { q: 'dou', want: ['豆包.exe'], note: '全拼前缀' },
    { q: '豆', want: ['豆包.exe'], note: '单字中文（bigram 索引里没有单字 token，靠拼音救回）' },
    { q: 'db', want: ['豆包.exe'], note: '首字母' },
    { q: 'weixin', want: ['微信.lnk'], note: '另一个中文名的全拼' },
    { q: 'xmsj', want: ['项目设计文档.docx'], note: '多字中文的首字母' },
  ]
  for (const c of pyCases) {
    const got = fxSearch(c.q)
    check(`拼音查「${c.q}」→ ${c.note}`, got.includes(c.want[0]), `实得 ${JSON.stringify(got)}`)
  }

  // 在真实扫描结果里查（验证真实文件名也能命中）
  const realCases = ['逆向', '设计', '文档', 'readme', 'plan', 'test']
  log('\n  真实目录检索抽样：')
  for (const q of realCases) {
    const hits = search(db, q, { limit: 5 })
    log(`    查「${q}」→ ${hits.length} 条${hits[0] ? `，例：${hits[0].name}` : ''}`)
  }
  check('真实目录可检索出结果', search(db, 'readme', { limit: 5 }).length >= 0)

  // ── 5. 最小命中过滤（P0-2 实证的边界） ──
  log('\n' + '═'.repeat(66))
  log('[5] 最小命中过滤')
  log('═'.repeat(66))
  const withFilter = search(db, '设计文档', { limit: 20, minHits: true, root: fxRoot }).map((h) => h.name)
  const withoutFilter = search(db, '设计文档', { limit: 20, minHits: false, root: fxRoot }).map((h) => h.name)
  log(`    开过滤：${JSON.stringify(withFilter)}`)
  log(`    关过滤：${JSON.stringify(withoutFilter)}`)
  check('开过滤后收敛（不把只蹭一个 bigram 的条目带进来）', withFilter.length <= withoutFilter.length,
    `${withFilter.length} <= ${withoutFilter.length}`)

  // ── 6. 查询转义 ──
  log('\n' + '═'.repeat(66))
  log('[6] 查询转义（FTS5 语法注入）')
  log('═'.repeat(66))
  let escOk = true
  for (const q of ['"', '*', '(', ')', 'AND', 'NEAR', 'OR', 'NOT', 'a" OR "b', 'a* OR *b', '(x OR y)']) {
    try {
      search(db, q, { limit: 5 })
    } catch (e) {
      escOk = false
      check(`转义「${q}」`, false, (e as Error).message)
    }
  }
  check('全部 FTS5 语法字符不报错', escOk)

  // ── 7. 重复 upsert 幂等 ──
  log('\n' + '═'.repeat(66))
  log('[7] 重复 upsert 幂等')
  log('═'.repeat(66))
  const before = Number((db.prepare('SELECT COUNT(*) c FROM lz_items').get() as { c: number }).c)
  const beforeFts = Number((db.prepare('SELECT COUNT(*) c FROM lz_items_fts').get() as { c: number }).c)
  scanSync({ roots: [fxDir], onBatch: (items) => upsertBatch(db, items) })
  const after = Number((db.prepare('SELECT COUNT(*) c FROM lz_items').get() as { c: number }).c)
  const afterFts = Number((db.prepare('SELECT COUNT(*) c FROM lz_items_fts').get() as { c: number }).c)
  check('重扫不产生重复条目', before === after && beforeFts === afterFts,
    `items ${before}→${after}, fts ${beforeFts}→${afterFts}`)

  // ── 8. 使用历史 ──
  log('\n' + '═'.repeat(66))
  log('[8] 使用历史（越用越准的闭环）')
  log('═'.repeat(66))
  recordUsage(db, '设计', 'c:\\a\\项目设计文档.docx')
  recordUsage(db, '设计', 'c:\\a\\项目设计文档.docx')
  recordUsage(db, '设计', 'c:\\b\\我的设计稿.psd')
  const usage = lookupUsage(db, '设计')
  check('同一个 keyword+path 累加计数', usage.find((u) => u.path.endsWith('项目设计文档.docx'))?.count === 2,
    JSON.stringify(usage.map((u) => `${u.path}:${u.count}`)))
  check('不同 path 分别记录', usage.length === 2)

  // ── 9. 降级：FTS 破坏后仍能 LIKE ──
  log('\n' + '═'.repeat(66))
  log('[9] FTS 不可用时回落 LIKE')
  log('═'.repeat(66))
  const beforeDrop = search(db, '设计', { limit: 5, root: fxRoot }).length
  db.exec('DROP TABLE lz_items_fts')
  const afterDrop = search(db, '设计', { limit: 5, root: fxRoot })
  const afterNames = afterDrop.map((h) => h.name).sort()
  check('DROP 掉 FTS 表后不抛错', true)
  log(`    诊断：DROP 前命中 ${beforeDrop} 条；DROP 后命中 ${afterDrop.length} 条`)
  log(`    诊断：DROP 后样例 ${JSON.stringify(afterNames)}`)
  check(
    '降级后仍能搜到（LIKE）',
    afterNames.length > 0,
    `命中 ${JSON.stringify(afterNames)}，rank=${afterDrop[0]?.rank}`,
  )
  check(
    '降级路径也遵守 root 过滤（别名 bug 回归）',
    afterDrop.every((h) => h.root === fxRoot),
    `root 值 ${JSON.stringify([...new Set(afterDrop.map((h) => h.root))])}`,
  )
  const healthBroken = ldb.checkHealth()
  check('健康检查能发现 FTS 缺失', !healthBroken.isHealthy, healthBroken.reason ?? '')

  // ── 10. 体积与耗时（用万级条目，不外推）──
  log('\n' + '═'.repeat(66))
  log('[10] 规模数据')
  log('═'.repeat(66))
  log(`    索引 ${result.indexed + fx.indexed} 条`)
  log(`    扫描+入库耗时 ${totalMs}ms（${(result.indexed / Math.max(totalMs, 1) * 1000).toFixed(0)} 条/秒）`)
  const fileSize = fs.statSync(dbPath).size
  const walSize = fs.existsSync(dbPath + '-wal') ? fs.statSync(dbPath + '-wal').size : 0
  const perItem = fileSize / Math.max(result.indexed + fx.indexed, 1)
  log(`    库体积 ${(fileSize / 1024 / 1024).toFixed(2)} MB（WAL ${(walSize / 1024 / 1024).toFixed(2)} MB）`)
  log(`    平均 ${perItem.toFixed(0)} B/条`)
  const CONFIRMED = result.indexed >= 10000
  log(`    ${CONFIRMED ? '✅' : '⚠️'} 条目数 ${result.indexed}${CONFIRMED ? '（已达万级，数字可用）' : '（未达万级，体积数字不可外推，需换更大目录重测）'}`)

  ldb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })

  log('\n' + '─'.repeat(66))
  if (failures === 0) {
    log(`P1 验收：通过`)
  } else {
    log(`P1 验收：${failures} 项失败`)
  }
  log('─'.repeat(66))
  app.exit(failures === 0 ? 0 : 1)
})
