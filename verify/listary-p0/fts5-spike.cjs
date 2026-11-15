/**
 * P0-2 / P0-3 可行性 spike — 在 **Electron 主进程**里验证：
 *   P0-2  FTS5 可用 + 中文预分词检索命中 + 查询转义
 *   P0-3  独立 SQLite 索引库（文件库）可建、可写、可重开、与主库并行无锁冲突
 *
 * 关键前提（已实测）：本机 Electron 36.9.5 内置的 `node:sqlite` 是 SQLite 3.50.4，
 * 编译项含 ENABLE_FTS5 —— 生产库里的 agent_memories_fts / palace_drawers_fts /
 * wiki_sources_fts 三张 FTS5 表就是它建的（plain Node 的 node:sqlite 3.47.2 不带 FTS5，
 * 读同一个库会报 "no such module: fts5"，正好反证 Electron 侧才是创建者）。
 *
 * 而 better-sqlite3 虽然列在 apps/windows 的依赖里，实际**没为 Electron 重建**
 * （NODE_MODULE_VERSION 127 vs Electron 需要的 135，require 即抛错），那条 fallback 分支是死的。
 * 故本 spike 直接走 node:sqlite，**不引入任何原生依赖**。
 *
 * 不碰用户数据：索引库建在临时目录；对主库只读打开。
 *
 * 用法：pnpm exec electron verify/listary-p0/fts5-spike.cjs
 * 结果写入 verify/listary-p0/fts5-spike.out（Windows 上 electron.exe 不接 stdout 管道）
 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app } = require('electron')

const OUT = path.join(__dirname, 'fts5-spike.out')
const lines = []
fs.rmSync(OUT, { force: true })
function log(s) {
  lines.push(s)
  process.stdout.write(s + '\n')
  fs.writeFileSync(OUT, lines.join('\n') + '\n')
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

// ─── 分词：与 packages/agent-runtime/src/memory/segmentation.ts 的 tokenizeBigram 同构 ───
// spike 里独立实现一份，以便不依赖 workspace 编译产物；两者若有分歧以 segmentation.ts 为准。
const CJK_RE = /[㐀-䶿一-鿿]/
const SEG_RE = /[㐀-䶿一-鿿]+|[a-z0-9]+/g

function tokenizeBigram(text) {
  const out = new Set()
  if (!text) return out
  const segs = text.toLowerCase().match(SEG_RE)
  if (!segs) return out
  for (const seg of segs) {
    if (CJK_RE.test(seg[0])) {
      if (seg.length === 1) out.add(seg)
      else for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2))
    } else out.add(seg)
  }
  return out
}

const bigramJoin = (t) => [...tokenizeBigram(t)].join(' ')

/** 查询转义：每 token 单独加引号、内部 " 转 ""（对齐 palace-repo.ts 的 searchDrawers） */
const ftsQuery = (tokens) => [...tokens].map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')

const FIXTURES = [
  '项目设计文档.docx',
  'Listary逆向笔记.md',
  '财报2026Q3.xlsx',
  '我的设计稿.psd',
  'hello-world.txt',
  'README.md',
]

app.whenReady().then(() => {
  log(`Electron ${process.versions.electron} / Node ${process.versions.node} / ABI ${process.versions.modules}\n`)
  log('═'.repeat(66))
  log('P0-2  FTS5 可用性与中文检索')
  log('═'.repeat(66))

  let DatabaseSync
  try {
    ;({ DatabaseSync } = require('node:sqlite'))
  } catch (e) {
    check('require node:sqlite', false, e.message)
    finish()
    return
  }

  // 1. FTS5 存在性与编译项
  let db
  try {
    db = new DatabaseSync(':memory:')
  } catch (e) {
    check('打开内存库', false, e.message)
    finish()
    return
  }
  const ver = db.prepare('select sqlite_version() v').get().v
  const opts = db
    .prepare('select * from pragma_compile_options()')
    .all()
    .map((r) => Object.values(r)[0])
  const ftsOpts = opts.filter((o) => /^ENABLE_FTS/.test(o))
  check('Electron 内置 node:sqlite 可用', true, `SQLite ${ver}`)
  check('编译项含 ENABLE_FTS5', ftsOpts.includes('ENABLE_FTS5'), ftsOpts.join(', '))

  // 2. 建 FTS5 虚表
  let built = true
  try {
    db.exec(`
      CREATE VIRTUAL TABLE lz_items_fts USING fts5(
        name_tokens,
        path_tokens,
        tokenize='unicode61 remove_diacritics 2'
      );
    `)
  } catch (e) {
    built = false
    check('CREATE VIRTUAL TABLE ... USING fts5', false, e.message)
  }
  check('CREATE VIRTUAL TABLE ... USING fts5', built)
  if (!built) {
    finish()
    return
  }

  // 3. 对照组：不预分词，unicode61 直接索引中文（预期零命中，证明预分词是必需的）
  const raw = new DatabaseSync(':memory:')
  raw.exec("CREATE VIRTUAL TABLE r USING fts5(name, tokenize='unicode61')")
  const rIns = raw.prepare('INSERT INTO r(name) VALUES (?)')
  for (const f of FIXTURES) rIns.run(f)
  let rawHits = 0
  try {
    rawHits = raw.prepare('SELECT name FROM r WHERE r MATCH ?').all('设计').length
  } catch {
    /* 语法错误亦计 0 */
  }
  check('对照组：未预分词时「设计」零命中', rawHits === 0, rawHits === 0 ? '确认必须预分词' : `意外命中 ${rawHits}`)
  raw.close()

  // 4. 主方案：预分词写入
  const ins = db.prepare('INSERT INTO lz_items_fts(rowid, name_tokens, path_tokens) VALUES (?, ?, ?)')
  const byRowid = new Map()
  FIXTURES.forEach((f, i) => {
    const id = i + 1
    ins.run(id, bigramJoin(f), bigramJoin(`E:\\demo\\${f}`))
    byRowid.set(id, f)
  })

  const CASES = [
    { q: '设计', want: ['项目设计文档.docx', '我的设计稿.psd'] },
    { q: '文档', want: ['项目设计文档.docx'] },
    { q: '逆向', want: ['Listary逆向笔记.md'] },
    { q: '财报', want: ['财报2026Q3.xlsx'] },
    { q: 'listary', want: ['Listary逆向笔记.md'] },
    { q: 'hello', want: ['hello-world.txt'] },
    { q: 'readme', want: ['README.md'] }, // 大小写不敏感
    { q: '2026q3', want: ['财报2026Q3.xlsx'] }, // 数字+字母
    { q: '不存在的词', want: [] },
  ]

  const qstmt = db.prepare('SELECT rowid FROM lz_items_fts WHERE lz_items_fts MATCH ?')
  const tokensOf = new Map() // rowid -> 该条目的 bigram 文本，供最小命中过滤用
  FIXTURES.forEach((f, i) => tokensOf.set(i + 1, bigramJoin(f) + ' ' + bigramJoin(`E:\\demo\\${f}`)))

  let allPass = true
  for (const c of CASES) {
    const toks = tokenizeBigram(c.q)
    const got = toks.size
      ? qstmt.all(ftsQuery(toks)).map((r) => byRowid.get(r.rowid)).sort()
      : []
    const want = [...c.want].sort()
    const ok = JSON.stringify(got) === JSON.stringify(want)
    if (!ok) allPass = false
    check(`查询「${c.q}」`, ok, ok ? `命中 ${got.length} 条` : `期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}`)
  }

  // ── 行为边界 1：OR 语义会让"只蹭到一个 bigram"的条目混进结果 ──
  // 「设计文档」→ {设计,计文,文档}；「我的设计稿」只有「设计」命中，却因 OR 被带进来。
  // 这正是 segmentation.ts 的 requiredTokenHits（MIN_QUERY_TOKEN_HITS=2）要解决的问题。
  const orSet = qstmt
    .all(ftsQuery(tokenizeBigram('设计文档')))
    .map((r) => byRowid.get(r.rowid))
    .sort()
  check(
    'OR 语义下「设计文档」会带出仅命中一个 bigram 的条目',
    orSet.length === 2,
    `${JSON.stringify(orSet)} —— 需最小命中过滤（见下）`,
  )

  /** 最小命中过滤：至少命中 min(2, tokens.size) 个查询 token（对齐 requiredTokenHits） */
  function minHits(rowids, toks) {
    const need = toks.size >= 2 ? 2 : 1
    return rowids.filter((rid) => {
      const text = tokensOf.get(rid) || ''
      let hits = 0
      for (const t of toks) if (text.includes(t)) hits++
      return hits >= need
    })
  }
  const toksDesignDoc = tokenizeBigram('设计文档')
  const filtered = minHits(
    qstmt.all(ftsQuery(toksDesignDoc)).map((r) => r.rowid),
    toksDesignDoc,
  )
    .map((rid) => byRowid.get(rid))
    .sort()
  check(
    '启用最小命中过滤后「设计文档」收敛到 1 条',
    JSON.stringify(filtered) === JSON.stringify(['项目设计文档.docx']),
    JSON.stringify(filtered),
  )

  // ── 行为边界 2：单字 CJK 查询匹配不到 ──
  // tokenizeBigram 对长度 >=2 的中文段只产 bigram（我的设计稿 → 我的/的设/设计/计稿），
  // 索引里没有单字 token「稿」，故单字查询必然落空。这是共享分词器的既定行为。
  // 对启动器的影响：用户输入单个汉字时无结果；实际使用中用户至少输入 2 字，影响有限。
  const single = tokenizeBigram('稿')
  const singleIdx = db.prepare('SELECT rowid FROM lz_items_fts WHERE lz_items_fts MATCH ?').all(ftsQuery(single))
  check(
    '单字 CJK 查询无结果（分词器既定行为，非缺陷）',
    singleIdx.length === 0,
    single.size === 1 ? `token={${[...single]}}，索引中不存在该单字 token` : 'UNEXPECTED',
  )

  // 5. 查询转义
  const EVIL = ['"', '*', '(', ')', 'AND', 'NEAR', 'OR', 'NOT', 'a" OR "b', 'a* OR *b']
  let escOk = true
  for (const q of EVIL) {
    const toks = tokenizeBigram(q)
    if (toks.size === 0) continue
    try {
      qstmt.all(ftsQuery(toks))
    } catch (e) {
      escOk = false
      check(`转义「${q}」不报错`, false, e.message)
    }
  }
  check('全部 FTS5 语法字符转义后不报错', escOk)
  const inj = qstmt.all(ftsQuery(tokenizeBigram('a" OR "b')))
  check('转义后无越权匹配', inj.length <= 2, `实得 ${inj.length} 行（应接近 0）`)

  // 6. 重复 upsert（先删后插）不增行
  const before = db.prepare('SELECT count(*) c FROM lz_items_fts').get().c
  db.prepare('DELETE FROM lz_items_fts WHERE rowid = ?').run(1)
  db.prepare('INSERT INTO lz_items_fts(rowid, name_tokens, path_tokens) VALUES (?, ?, ?)').run(
    1,
    bigramJoin(FIXTURES[0]),
    bigramJoin(`E:\\demo\\${FIXTURES[0]}`),
  )
  const after = db.prepare('SELECT count(*) c FROM lz_items_fts').get().c
  check('重复 upsert 不增行', before === after, `${before} → ${after}`)
  db.close()

  // ══════════════════════════════════════════════════════════════
  log('\n' + '═'.repeat(66))
  log('P0-3  独立索引库（文件库）')
  log('═'.repeat(66))

  const idxDir = path.join(os.tmpdir(), 'lumii-listary-p0')
  fs.rmSync(idxDir, { recursive: true, force: true })
  fs.mkdirSync(idxDir, { recursive: true })
  const idxPath = path.join(idxDir, 'index.db')

  // 7. 建库 + 套 pragma（生产实现应复用 applySqliteConnectionPragmas）
  let idb
  try {
    idb = new DatabaseSync(idxPath)
    idb.exec('PRAGMA journal_mode = WAL')
    idb.exec('PRAGMA synchronous = NORMAL')
    idb.exec('PRAGMA busy_timeout = 5000')
    idb.exec('PRAGMA foreign_keys = ON')
    const jm = idb.prepare('PRAGMA journal_mode').get()
    check('独立库可建并设 WAL', Object.values(jm)[0] === 'wal', `journal_mode=${Object.values(jm)[0]}`)
    check('库文件已落盘', fs.existsSync(idxPath), idxPath)
  } catch (e) {
    check('建独立库', false, e.message)
  }

  // 8. 建 lz_* 表结构（设计 §5 的精简版）+ 灌数据
  const DDL = `
    CREATE TABLE IF NOT EXISTS lz_items (
      id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      ext TEXT, kind TEXT NOT NULL, size INTEGER, mtime INTEGER,
      root TEXT NOT NULL, is_start INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_lz_items_root ON lz_items(root);
    CREATE INDEX IF NOT EXISTS idx_lz_items_name ON lz_items(name);
    CREATE VIRTUAL TABLE IF NOT EXISTS lz_items_fts USING fts5(
      name_tokens, path_tokens, tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TABLE IF NOT EXISTS lz_usage (
      keyword TEXT NOT NULL, path TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1,
      last_used INTEGER NOT NULL, PRIMARY KEY (keyword, path)
    );
  `
  try {
    idb.exec(DDL)
    check('lz_* 表结构创建', true)
  } catch (e) {
    check('lz_* 表结构创建', false, e.message)
  }

  const insertItem = idb.prepare(
    `INSERT INTO lz_items(path, name, ext, kind, size, mtime, root, is_start)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET name=excluded.name, mtime=excluded.mtime, size=excluded.size`,
  )
  const insertFts = idb.prepare('DELETE FROM lz_items_fts WHERE rowid = ?')
  const putFts = idb.prepare('INSERT INTO lz_items_fts(rowid, name_tokens, path_tokens) VALUES (?, ?, ?)')

  const t0 = Date.now()
  idb.exec('BEGIN')
  for (const f of FIXTURES) {
    const p = `E:\\demo\\${f}`
    const info = insertItem.run(p, f, f.split('.').pop().toLowerCase(), 'file', 1024, Date.now(), 'E:\\demo', 0)
    const rowid = Number(info.lastInsertRowid)
    insertFts.run(rowid)
    putFts.run(rowid, bigramJoin(f), bigramJoin(p))
  }
  idb.exec('COMMIT')
  const writeMs = Date.now() - t0
  const itemCount = idb.prepare('SELECT count(*) c FROM lz_items').get().c
  const ftsCount = idb.prepare('SELECT count(*) c FROM lz_items_fts').get().c
  check('写入条目', itemCount === FIXTURES.length, `${itemCount} 条，${writeMs}ms`)
  check('主表与 FTS 行数一致', itemCount === ftsCount, `主表 ${itemCount} / FTS ${ftsCount}`)

  // 9. 检索闭环（JOIN 回主表拿真实路径）
  const joined = idb.prepare(
    `SELECT i.name FROM lz_items_fts f JOIN lz_items i ON i.id = f.rowid
     WHERE lz_items_fts MATCH ? ORDER BY rank`,
  )
  const jHits = joined.all(ftsQuery(tokenizeBigram('设计'))).map((r) => r.name).sort()
  check(
    'JOIN 回主表检索「设计」',
    JSON.stringify(jHits) === JSON.stringify(['我的设计稿.psd', '项目设计文档.docx']),
    JSON.stringify(jHits),
  )

  // 10. 与主库并行：同时打开主库（只读）与本索引库，各自读写无冲突
  const mainDbPath = path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db')
  if (!fs.existsSync(mainDbPath)) {
    check('与主库并行无锁冲突', false, `主库不存在：${mainDbPath}`)
  } else {
    try {
      const mdb = new DatabaseSync(mainDbPath, { readOnly: true })
      const mc = mdb.prepare('SELECT count(*) c FROM conversations').get().c
      idb.prepare('INSERT INTO lz_usage(keyword, path, count, last_used) VALUES (?, ?, 1, ?)').run(
        '设计',
        'E:\\demo\\项目设计文档.docx',
        Date.now(),
      )
      const uc = idb.prepare('SELECT count(*) c FROM lz_usage').get().c
      mdb.close()
      check('与主库并行无锁冲突', true, `主库读 ${mc} 会话；索引库写 usage ${uc} 行`)
    } catch (e) {
      check('与主库并行无锁冲突', false, e.message)
    }
  }

  idb.close()

  // 11. 关闭重开：数据还在
  try {
    const reopen = new DatabaseSync(idxPath)
    const c1 = reopen.prepare('SELECT count(*) c FROM lz_items').get().c
    const c2 = reopen.prepare('SELECT count(*) c FROM lz_items_fts').get().c
    const c3 = reopen.prepare('SELECT count(*) c FROM lz_usage').get().c
    const jm = Object.values(reopen.prepare('PRAGMA journal_mode').get())[0]
    const again = reopen
      .prepare('SELECT rowid FROM lz_items_fts WHERE lz_items_fts MATCH ?')
      .all(ftsQuery(tokenizeBigram('逆向'))).length
    reopen.close()
    check('重开后数据完整', c1 === FIXTURES.length && c2 === FIXTURES.length && c3 === 1, `items=${c1} fts=${c2} usage=${c3}`)
    check('重开后 WAL 仍生效', jm === 'wal', `journal_mode=${jm}`)
    check('重开后仍可检索', again === 1, `「逆向」命中 ${again} 条`)
  } catch (e) {
    check('关闭重开', false, e.message)
  }

  // 12. 体积：只报 FTS 表的内容量，避免把建库固定开销外推成规模预估
  try {
    const pageCount = idb.prepare('PRAGMA page_count').get()
    const pageSize = idb.prepare('PRAGMA page_size').get()
    const pages = Number(Object.values(pageCount)[0])
    const psz = Number(Object.values(pageSize)[0])
    const dbBytes = pages * psz
    const perItem = (dbBytes - 48 * 1024) / FIXTURES.length
    log(`\n  索引库：page_count=${pages} × page_size=${psz} = ${(dbBytes / 1024).toFixed(1)} KB`)
    log(`  其中约 48 KB 是新建库的固定开销（页头/FTS5 影子表结构）。`)
    log(`  扣除后的每条约 ${perItem.toFixed(0)} B —— 但 6 条样例不足以外推，`)
    log(`  真实规模请在 P1 用实际目录（万级以上条目）重测，不要用本数字做容量决策。`)
  } catch { /* 体积只是参考 */ }

  // 清理临时库
  fs.rmSync(idxDir, { recursive: true, force: true })

  // 13. 打包/asar 场景（dev 下覆盖不到，只如实标注）
  log('\n' + '═'.repeat(66))
  log('打包场景')
  log('═'.repeat(66))
  check('当前为 dev 运行', !app.isPackaged, `isPackaged=${app.isPackaged}，asar 场景需打包后复验`)
  log('  说明：node:sqlite 是 Electron 内建模块，不涉及 asar 内原生 .node 加载，')
  log('        打包风险显著低于 better-sqlite3 路线（后者还要处理 unpacked 路径）。')

  finish()
})

function finish() {
  const failed = results.filter((r) => !r.ok)
  log('\n' + '─'.repeat(66))
  if (failed.length === 0) {
    log(`结论：P0-2 / P0-3 全部通过（${results.length} 项）`)
    log('  - 走 Electron 内建 node:sqlite，零原生依赖')
    log('  - FTS5 可用；预分词方案中文全部命中；未预分词对照组确认零命中')
    log('  - 查询转义防住 FTS5 语法注入')
    log('  - 独立索引库可建/可写/可重开；与主库并行无锁冲突')
    log('  - 遗留：打包后复验（node:sqlite 为内建模块，风险低）')
  } else {
    log(`结论：不通过（${failed.length} / ${results.length} 项失败）`)
    for (const f of failed) log(`  - ${f.name}: ${f.detail || ''}`)
  }
  log('─'.repeat(66))
  app.exit(failed.length === 0 ? 0 : 1)
}
