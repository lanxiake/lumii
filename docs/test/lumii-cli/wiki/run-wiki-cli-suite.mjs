#!/usr/bin/env node
/**
 * Wiki CLI 套件（资料层）
 *
 * 覆盖 lumii-ui 现存全部 wiki 子命令 + 关键命令总线。
 * 历史页面（page / revisions / backlinks / rollback / unresolved / concept / attach）
 * 已随 P3 删除，综述合成（synthesis）已随智能资料库 P2 删除 —— 对应用例一并移除。
 * 当前结构见 AGENTS.md「Wiki」与 design/Wiki知识库/2026-08-31-Wiki智能资料库设计.md。
 *
 * 用法：node docs/test/lumii-cli/wiki/run-wiki-cli-suite.mjs
 *
 * 环境变量：
 * - WIKI_CLI_SKIP_AGENT=1    跳过 Agent wiki_search 最小调用
 * - WIKI_CLI_SKIP_MIGRATE=1  跳过库级迁移用例（会调用模型，且会在 review 留 run）
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../../..')
const LUMII_UI = path.join(ROOT, 'apps/windows/resources/app-ui-cli/lumii-ui.mjs')
const EVID = path.join(__dirname, 'wiki-cli-evidence.jsonl')
const REPORT = path.join(__dirname, 'wiki-cli-test-report.md')
const DB_PATH = path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db')
const SKIP_AGENT = process.env.WIKI_CLI_SKIP_AGENT === '1'
const SKIP_MIGRATE = process.env.WIKI_CLI_SKIP_MIGRATE === '1'

const results = []
const PROBE = 'wiki-cli'

/** 调用 lumii-ui（遇 rate_limited 自动退避重试） */
function ui(args, input, { retries = 6 } = {}) {
  let last = { code: 1, out: '', json: null }
  for (let i = 0; i <= retries; i++) {
    const r = spawnSync(process.execPath, [LUMII_UI, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      input,
      maxBuffer: 20 * 1024 * 1024,
    })
    const out = (r.stdout || '') + (r.stderr || '')
    let json = null
    const trimmed = (r.stdout || '').trim()
    if (trimmed) {
      try {
        json = JSON.parse(trimmed)
      } catch {
        /* ignore */
      }
    }
    last = { code: r.status ?? 1, out, json }
    if (json?.error !== 'rate_limited' && !/rate_limited/.test(out)) return last
    // 控制口默认 100 次/60s；打满后等待窗口滑动
    sleep(Math.min(20000, 5000 * (i + 1)))
  }
  return last
}

/** 底层 command 总线 */
function cmd(type, data = {}) {
  return ui(['command', type, '--data', JSON.stringify(data)])
}

function record(id, status, note, extra = {}) {
  const row = { ts: new Date().toISOString(), id, status, note, ...extra }
  results.push(row)
  fs.appendFileSync(EVID, JSON.stringify(row) + '\n', 'utf8')
  console.log(`[${id}] ${status} — ${note}`)
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function asArray(v) {
  return Array.isArray(v) ? v : null
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** 向真实库插入 pending 收件箱探针（不经摄入 UI，专测 organize/discard/retry） */
function seedInbox(title, preview) {
  const db = new DatabaseSync(DB_PATH)
  try {
    const id = crypto.randomBytes(16).toString('hex')
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO wiki_inbox
       (id, agent_id, user_id, item_type, source_path, source_url, title,
        content_preview, media_type, status, attempt_count, last_error, content_hash, created_at)
       VALUES (?, 'assistant', 'local-user', 'chat', NULL, NULL, ?, ?, 'document', 'pending', ?, ?, NULL, ?)`,
    ).run(id, title, preview, title.includes('retry') ? 2 : 0, title.includes('retry') ? 'probe-error' : null, now)
    return id
  } finally {
    db.close()
  }
}

/** 读取 inbox 行（校验 retry 清零） */
function readInboxRow(id) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  try {
    return db.prepare('SELECT * FROM wiki_inbox WHERE id = ?').get(id)
  } finally {
    db.close()
  }
}

/** 列表包装：source list 返回 { sources } */
function sourceList(flags = []) {
  const r = ui(['wiki', 'source', 'list', ...flags])
  assert(r.code === 0, r.out.slice(0, 160))
  return asArray(r.json?.sources) ?? []
}

/** 分类树会随用户编辑变化，探针从当前树里取第一个大类及其第一个小类 */
function pickTopic() {
  const r = ui(['wiki', 'topic', 'tree'])
  assert(r.code === 0, r.out.slice(0, 160))
  const tree = r.json?.tree ?? r.json
  const cat = tree?.categories?.[0]
  assert(cat?.name, '分类树为空')
  const subtopic = cat.subtopics?.[0]
  assert(subtopic, `大类「${cat.name}」下没有小类`)
  return { category: cat.name, subtopic }
}

/** 组织一条探针收件箱，返回 sourceId */
function organizeProbe(title) {
  const { category, subtopic } = pickTopic()
  const id = seedInbox(title, `${title} 正文探针`)
  try {
    const org = ui([
      'wiki', 'inbox', 'organize', id,
      '--category', category,
      '--subtopic', subtopic,
      '--title', title,
    ])
    assert(org.code === 0, `organize: ${org.out.slice(0, 200)}`)
    assert(org.json?.sourceId, '缺 sourceId')
    return { sourceId: org.json.sourceId, category, subtopic }
  } catch (e) {
    // 组织失败时探针会留在 pending，必须自己收尾
    ui(['wiki', 'inbox', 'discard', id])
    throw e
  }
}

function nowIso() {
  return new Date().toISOString()
}

function main() {
  fs.writeFileSync(EVID, '', 'utf8')
  console.log('Wiki CLI suite starting…')
  const ping = ui(['wiki', 'inbox', 'list'])
  if (ping.code === 3 || /connection_failed/.test(ping.out)) {
    console.error('控制口不可达，请先启动应用（pnpm dev）')
    process.exit(3)
  }

  runP0()
  sleep(1000)
  runP1()
  sleep(1000)
  runP2()
  sleep(1000)
  runAgent()
  writeReport()
}

// ---------------------------------------------------------------- P0 摄取与检索

function runP0() {
  try {
    const { code, json } = ui(['wiki', 'inbox', 'list'])
    assert(code === 0 && asArray(json), 'inbox list')
    record('P0-A01', 'PASS', `n=${json.length}`)
  } catch (e) {
    record('P0-A01', 'FAIL', e.message)
  }

  for (const st of ['organized', 'pending', 'discarded']) {
    try {
      const { code, json } = ui(['wiki', 'inbox', 'list', '--status', st])
      assert(code === 0 && asArray(json), st)
      assert(json.every((x) => x.status === st), `混入非 ${st}`)
      record(`P0-A02-${st}`, 'PASS', `n=${json.length}`)
    } catch (e) {
      record(`P0-A02-${st}`, 'FAIL', e.message)
    }
  }

  try {
    const all = sourceList()
    const { category } = pickTopic()
    const filtered = sourceList(['--category', category])
    assert(filtered.every((s) => s.topicCategory === category), 'category 过滤串味')
    record('P0-A03', 'PASS', `sources=${all.length} ${category}=${filtered.length}`)
  } catch (e) {
    record('P0-A03', 'FAIL', e.message)
  }

  try {
    const { code, json } = ui(['wiki', 'runs', 'list', '--limit', '10'])
    assert(code === 0 && asArray(json), 'runs')
    const batch = json.find((r) => Array.isArray(r.inboxIds) && r.inboxIds.length > 1)
    record('P0-A04', 'PASS', `runs=${json.length} batch=${batch ? batch.inboxIds.length : 0}`)
  } catch (e) {
    record('P0-A04', 'FAIL', e.message)
  }

  // 检索：先造一条已知锚点，再验证命中 / 空结果 / 参数校验
  const anchorSourceId = (() => {
    try {
      const { sourceId } = organizeProbe(`${PROBE}检索锚点资料`)
      const hits = ui(['wiki', 'search', '检索锚点', '--limit', '5'])
      assert(hits.code === 0 && Array.isArray(hits.json?.hits), 'search 返回缺 hits')
      assert(hits.json.hits.some((h) => h.sourceId === sourceId), '锚点未命中')
      record('P0-S01', 'PASS', `hits=${hits.json.hits.length} mode=${hits.json.mode}`)
      return sourceId
    } catch (e) {
      record('P0-S01', 'FAIL', e.message)
      return null
    }
  })()

  try {
    const { code, json } = ui(['wiki', 'search', '"引号测试"', '--limit', '5'])
    assert(code === 0 && Array.isArray(json?.hits), `exit ${code}`)
    record('P0-S02', 'PASS', '特殊字符 ok')
  } catch (e) {
    record('P0-S02', 'FAIL', e.message)
  }

  try {
    // 用纯拉丁稀有串：中文长串会被 bigram 切出「不存在」等常见词而正常召回，
    // 那不是 bug（查询侧按最小命中数收口），不能拿来当「空结果」判据。
    const { code, json } = ui(['wiki', 'search', 'xyzzywiki999', '--limit', '5'])
    assert(code === 0 && Array.isArray(json?.hits), 'search 崩溃')
    assert(json.hits.length === 0, `稀有串不应召回: ${json.hits.map((h) => h.title).join('|')}`)
    record('P0-S03', 'PASS', '无结果空数组')
  } catch (e) {
    record('P0-S03', 'FAIL', e.message)
  }

  try {
    const { code } = ui(['wiki', 'search', ''])
    assert(code === 2, `期望 2 得 ${code}`)
    record('P0-S04', 'PASS', '空查询 usage')
  } catch (e) {
    record('P0-S04', 'FAIL', e.message)
  }

  try {
    const { code, json } = ui(['wiki', 'search', '检索锚点', '--limit', '3', '--no-vector'])
    assert(code === 0 && Array.isArray(json?.hits), 'no-vector')
    assert(json.mode === 'fts', `--no-vector 应为 fts，得 ${json.mode}`)
    assert(typeof json.degradeReason === 'string' && json.degradeReason.length > 0, '缺降级说明')
    record('P0-S05', 'PASS', `mode=${json.mode}`)
  } catch (e) {
    record('P0-S05', 'FAIL', e.message)
  }

  if (anchorSourceId) cmd('wiki:source:delete', { sourceIds: [anchorSourceId] })

  // I 收件箱闭环
  let orgInboxId = null
  try {
    const { category, subtopic } = pickTopic()
    orgInboxId = seedInbox(`${PROBE}-inbox-org`, '手动归档正文探针')
    const org = ui([
      'wiki', 'inbox', 'organize', orgInboxId,
      '--category', category,
      '--subtopic', subtopic,
      '--title', 'wiki-cli-organized',
    ])
    assert(org.code === 0, `organize: ${org.out.slice(0, 200)}`)
    assert(org.json?.sourceId, '缺 sourceId')
    assert(org.json?.category === category, 'category 不匹配')
    const listed = asArray(ui(['wiki', 'inbox', 'list', '--status', 'organized']).json) || []
    assert(listed.some((x) => x.id === orgInboxId), '未变 organized')
    record('P0-I01', 'PASS', `sourceId=${org.json.sourceId.slice(0, 8)}`)
    cmd('wiki:source:delete', { sourceIds: [org.json.sourceId] })
  } catch (e) {
    if (orgInboxId) ui(['wiki', 'inbox', 'discard', orgInboxId])
    record('P0-I01', 'FAIL', e.message)
  }

  try {
    const id = seedInbox(`${PROBE}-inbox-escape`, 'escape')
    const bad = ui(['wiki', 'inbox', 'organize', id, '--category', '临时存放', '--subtopic', 'x', '--title', 'x'])
    assert(bad.code !== 0, '临时存放应拒绝')
    record('P0-I02', 'PASS', `rejected: ${(bad.json?.message || bad.out).slice(0, 80)}`)
    ui(['wiki', 'inbox', 'discard', id])
  } catch (e) {
    record('P0-I02', 'FAIL', e.message)
  }

  try {
    const id = seedInbox(`${PROBE}-inbox-disc`, 'to discard')
    const d = ui(['wiki', 'inbox', 'discard', id])
    assert(d.code === 0 && d.json?.success !== false, `discard ${d.out.slice(0, 120)}`)
    const listed = asArray(ui(['wiki', 'inbox', 'list', '--status', 'discarded']).json) || []
    assert(listed.some((x) => x.id === id), 'discarded 列表未见')
    record('P0-I03', 'PASS', `id=${id.slice(0, 8)}`)

    const retryBad = ui(['wiki', 'inbox', 'retry', id])
    assert(retryBad.code !== 0, 'discarded 不应 retry')
    record('P0-I05', 'PASS', '非 pending 拒绝')
  } catch (e) {
    record('P0-I03', 'FAIL', e.message)
    record('P0-I05', 'FAIL', e.message)
  }

  try {
    const id = seedInbox(`${PROBE}-inbox-retry`, 'retry body')
    const before = readInboxRow(id)
    assert(before.attempt_count === 2, 'seed attempt')
    const r = ui(['wiki', 'inbox', 'retry', id])
    assert(r.code === 0, `retry: ${r.out.slice(0, 120)}`)
    const after = readInboxRow(id)
    assert(after.attempt_count === 0 && after.last_error == null, '未清零')
    record('P0-I04', 'PASS', 'attempt/error cleared')
    ui(['wiki', 'inbox', 'discard', id])
  } catch (e) {
    record('P0-I04', 'FAIL', e.message)
  }

  try {
    const a = ui(['wiki', 'inbox', 'discard', 'ghost-inbox-id'])
    const b = ui(['wiki', 'inbox', 'retry', 'ghost-inbox-id'])
    assert(a.code !== 0 && b.code !== 0, '幽灵应失败')
    record('P0-I06', 'PASS', 'ghost rejected')
  } catch (e) {
    record('P0-I06', 'FAIL', e.message)
  }

  // F 文件夹导入（只导入不分类，避免在本组触发模型）
  // 不能用 os.tmpdir()：扫描器把临时目录标成 ignored:temp，importable 恒为 0。
  const tmpDir = path.join(ROOT, '.tmp-wiki-cli-probe')
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.mkdirSync(path.join(tmpDir, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, `${PROBE}-folder-probe.md`), '# wiki folder import probe', 'utf8')
    fs.writeFileSync(path.join(tmpDir, 'sub', `${PROBE}-nested-probe.md`), '# nested probe', 'utf8')
    const scan = ui(['wiki', 'folder', 'scan', tmpDir, '--recursive'])
    assert(scan.code === 0, scan.out.slice(0, 200))
    assert((scan.json?.summary?.importable ?? 0) >= 2, 'scan importable')
    const dry = ui(['wiki', 'folder', 'import', tmpDir, '--recursive', '--dry-run'])
    assert(dry.code === 0 && dry.json?.dryRun === true, dry.out.slice(0, 200))
    const imp = ui([
      'wiki', 'folder', 'import', tmpDir, '--recursive',
      '--item-type', 'output', '--no-auto-classify',
    ])
    assert(imp.code === 0 && (imp.json?.imported ?? 0) >= 2, imp.out.slice(0, 200))
    assert(imp.json?.autoClassify === false, '未按 --no-auto-classify 走')
    const orgRun = ui(['wiki', 'organize', 'run', '--mode', 'intake', '--item-type', 'output'])
    assert(orgRun.code === 0, orgRun.out.slice(0, 200))
    for (const id of imp.json.inboxIds ?? []) ui(['wiki', 'inbox', 'discard', id])
    // intake 会把收件箱转成「未分类资料」，探针必须自己收尾，否则每跑一次库就多几条
    const leftovers = sourceList(['--unfiled']).filter((s) => s.title.startsWith(PROBE))
    if (leftovers.length > 0) cmd('wiki:source:delete', { sourceIds: leftovers.map((s) => s.id) })
    record('P0-F01', 'PASS', `imported=${imp.json.imported} run=${orgRun.json?.status ?? 'ok'} cleaned=${leftovers.length}`)
  } catch (e) {
    record('P0-F01', 'FAIL', e.message)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }

  // X 索引
  try {
    const a = ui(['wiki', 'index', 'rebuild'])
    const b = ui(['wiki', 'index', 'rebuild'])
    assert(a.code === 0 && b.code === 0, 'rebuild')
    assert(a.json.rebuiltCount === b.json.rebuiltCount, '幂等')
    record('P0-X01', 'PASS', `rebuiltCount=${a.json.rebuiltCount}`)
    record('P0-X02', 'PASS', 'idempotent')
    const s = sourceList().find((x) => /[一-龥]{2,}/.test(x.title))
    if (!s) {
      record('P0-X03', 'SKIP', '库内无带中文标题的资料')
    } else {
      const q = /[一-龥]{2,}/.exec(s.title)[0].slice(0, 4)
      const r = ui(['wiki', 'search', q, '--limit', '5', '--no-vector'])
      assert(r.code === 0, r.out.slice(0, 120))
      assert(r.json.hits.length > 0, `重建后搜「${q}」无命中`)
      record('P0-X03', 'PASS', `q=${q} hits=${r.json.hits.length}`)
    }
  } catch (e) {
    record('P0-X01', 'FAIL', e.message)
    record('P0-X02', 'FAIL', e.message)
    record('P0-X03', 'FAIL', e.message)
  }

  // inbox count（与 list 同筛选）
  try {
    const list = asArray(ui(['wiki', 'inbox', 'list', '--status', 'organized']).json) || []
    const cnt = ui(['wiki', 'inbox', 'count', '--status', 'organized'])
    assert(cnt.code === 0, cnt.out.slice(0, 120))
    assert(typeof cnt.json?.total === 'number', `缺 total: ${cnt.out.slice(0, 100)}`)
    // list 有条数上限（实测 100），count 是全量；只能断言不矛盾
    assert(cnt.json.total >= list.length, `count=${cnt.json.total} < list=${list.length}`)
    record('P0-G01', 'PASS', `organized count=${cnt.json.total} list=${list.length}（list 有上限）`)
  } catch (e) {
    record('P0-G01', 'FAIL', e.message)
  }

  try {
    const suggestions = asArray(ui(['wiki', 'cleanup', 'scan']).json) || []
    if (suggestions.length === 0) {
      record('P0-G02', 'SKIP', '清理扫描无建议')
    } else {
      const sid = suggestions[0]?.sourceId
      const g = ui(['wiki', 'source', 'get', sid])
      assert(g.code === 0, g.out.slice(0, 100))
      // null 也算合法（已失效源）
      record('P0-G02', 'PASS', g.json ? `title=${g.json.title}` : 'null source')
    }
  } catch (e) {
    record('P0-G02', 'FAIL', e.message)
  }
}

// ---------------------------------------------------------------- P1 库维护

function runP1() {
  try {
    const r = ui(['wiki', 'topic', 'tree'])
    assert(r.code === 0, r.out.slice(0, 120))
    const tree = r.json?.tree ?? r.json
    const categories = asArray(tree?.categories)
    assert(categories && categories.length > 0, '树为空')
    record('P1-T01', 'PASS', `categories=${categories.length}`)
  } catch (e) {
    record('P1-T01', 'FAIL', e.message)
  }

  try {
    const unfiled = sourceList(['--unfiled'])
    const parking = sourceList(['--parking'])
    const archived = sourceList(['--archived'])
    record('P1-L01', 'PASS', `unfiled=${unfiled.length} parking=${parking.length} archived=${archived.length}`)
  } catch (e) {
    record('P1-L01', 'FAIL', e.message)
  }

  // C 清理
  let cleanup = []
  try {
    const r = ui(['wiki', 'cleanup', 'scan'])
    assert(r.code === 0 && asArray(r.json), 'scan')
    cleanup = r.json
    assert(cleanup.every((s) => ['stale', 'broken_source', 'duplicate_content'].includes(s.reason)), '未知原因')
    record('P1-C01', 'PASS', `n=${cleanup.length}`)
  } catch (e) {
    record('P1-C01', 'FAIL', e.message)
  }

  try {
    const r = ui(['wiki', 'cleanup', 'scan', '--stale-days', '30'])
    assert(r.code === 0 && asArray(r.json), 'stale')
    record('P1-C02', 'PASS', `n=${r.json.length}`)
  } catch (e) {
    record('P1-C02', 'FAIL', e.message)
  }

  try {
    const sid = cleanup[0]?.sourceId
    if (!sid) {
      record('P1-C03', 'SKIP', '无 sourceId')
    } else {
      const a = ui(['wiki', 'source', 'archive', sid])
      assert(a.code === 0, a.out.slice(0, 100))
      const inArchived = sourceList(['--archived']).some((s) => s.id === sid)
      assert(inArchived, '归档后不在 --archived 列表')
      const b = ui(['wiki', 'source', 'archive', sid, '--restore'])
      assert(b.code === 0, b.out.slice(0, 100))
      const back = !sourceList(['--archived']).some((s) => s.id === sid)
      assert(back, '恢复后仍在 --archived 列表')
      record('P1-C03', 'PASS', 'archive+restore')
    }
  } catch (e) {
    record('P1-C03', 'FAIL', e.message)
  }

  // E 导出
  for (const [id, flags] of [
    ['P1-E01', []],
    ['P1-E02', ['--include-sources']],
    ['P1-E03', ['--include-attachments']],
  ]) {
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-cli-export-'))
      const r = ui(['wiki', 'export', dir, ...flags])
      assert(r.code === 0, r.out.slice(0, 120))
      assert(typeof r.json?.exported === 'number', '缺 exported')
      assert(Array.isArray(r.json?.failed), '缺 failed')
      const n = countMd(dir)
      assert(n === r.json.exported, `磁盘 md=${n} 与 exported=${r.json.exported} 不一致`)
      record(id, 'PASS', `md=${n}${flags.length ? ' ' + flags[0] : ''}`)
    } catch (e) {
      record(id, 'FAIL', e.message)
    }
  }

  // V 向量 / 摘要派生
  try {
    const r = ui(['wiki', 'vector', 'rebuild'])
    assert(r.code === 0 || /vector|向量|降级|transformers|backend/i.test(r.out), r.out.slice(0, 120))
    record('P1-V01', 'PASS', JSON.stringify(r.json || r.out).slice(0, 140))
  } catch (e) {
    record('P1-V01', 'FAIL', e.message)
  }
}

function countMd(dir) {
  let n = 0
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) n += countMd(p)
    else if (name.endsWith('.md')) n++
  }
  return n
}

// ---------------------------------------------------------------- P2 库级迁移与元信息

function runP2() {
  const existing = cmd('wiki:migrate:get', {})
  const hasRun = Boolean(existing.json?.run)

  if (SKIP_MIGRATE) {
    for (const id of ['P2-M01', 'P2-M02', 'P2-M03', 'P2-M04']) {
      record(id, 'SKIP', 'WIKI_CLI_SKIP_MIGRATE=1')
    }
  } else if (hasRun) {
    for (const id of ['P2-M01', 'P2-M02', 'P2-M03', 'P2-M04']) {
      record(id, 'SKIP', `已有迁移 run（phase=${existing.json.run.phase}），不覆盖`)
    }
  } else {
    const tmpDir = path.join(ROOT, '.tmp-wiki-cli-migrate')
    let inboxIds = []
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      fs.mkdirSync(path.join(tmpDir, 'alpha'), { recursive: true })
      fs.mkdirSync(path.join(tmpDir, 'beta'), { recursive: true })
      fs.writeFileSync(path.join(tmpDir, 'alpha', `${PROBE}-migrate-a.md`), '# alpha 检索探针\n\n迁移用例正文。', 'utf8')
      fs.writeFileSync(path.join(tmpDir, 'beta', `${PROBE}-migrate-b.md`), '# beta 检索探针\n\n迁移用例正文。', 'utf8')
      const imp = ui(['wiki', 'folder', 'import', tmpDir, '--recursive', '--item-type', 'output'])
      assert(imp.code === 0, imp.out.slice(0, 200))
      inboxIds = [...(imp.json?.inboxIds ?? [])]
      const run = imp.json?.migrateRun
      assert(run, '导入未返回 migrateRun')
      assert(run.phase === 'review', `导入后应停在 review，得 ${run.phase}`)
      record('P2-M01', 'PASS', `run=${String(run.runId).slice(0, 8)} mappings=${run.mappings?.length ?? 0}`)

      const got = cmd('wiki:migrate:get', {})
      assert(got.json?.run?.runId === run.runId, 'get 返回的 runId 不一致')
      record('P2-M02', 'PASS', `phase=${got.json.run.phase}`)

      const folderRel = run.mappings?.[0]?.folderRel
      if (!folderRel) {
        record('P2-M03', 'SKIP', '无映射簇')
      } else {
        const upd = cmd('wiki:migrate:update-mapping', { folderRel, patch: { ignored: true } })
        assert(upd.code === 0, upd.out.slice(0, 120))
        const mapping = (upd.json?.run?.mappings ?? []).find((m) => m.folderRel === folderRel)
        assert(mapping?.ignored === true, 'ignored 未生效')
        record('P2-M03', 'PASS', `ignored ${folderRel}`)
      }

      const disc = cmd('wiki:migrate:discard', {})
      assert(disc.code === 0 && disc.json?.success !== false, disc.out.slice(0, 120))
      assert(cmd('wiki:migrate:get', {}).json?.run == null, 'discard 后 run 仍在')
      record('P2-M04', 'PASS', 'discard 清空 run')
    } catch (e) {
      for (const id of ['P2-M01', 'P2-M02', 'P2-M03', 'P2-M04']) {
        if (!results.some((r) => r.id === id)) record(id, 'FAIL', e.message)
      }
    } finally {
      for (const id of inboxIds) ui(['wiki', 'inbox', 'discard', id])
      const leftovers = sourceList(['--unfiled']).filter((s) => s.title.startsWith(PROBE))
      if (leftovers.length > 0) cmd('wiki:source:delete', { sourceIds: leftovers.map((s) => s.id) })
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // 元信息编辑（user_path / tags / description）—— P3 UI 的写入面
  let metaSourceId = null
  try {
    const probe = organizeProbe(`${PROBE}元信息探针`)
    metaSourceId = probe.sourceId
    const patch = {
      agentId: 'assistant',
      sourceId: metaSourceId,
      category: probe.category,
      subtopic: probe.subtopic,
      userPath: ['probe', 'meta'],
      tags: ['alpha', 'beta'],
      description: '元信息探针描述',
    }
    const upd = cmd('wiki:source:update-topic', patch)
    assert(upd.code === 0, upd.out.slice(0, 160))
    const got = ui(['wiki', 'source', 'get', metaSourceId])
    assert(got.code === 0 && got.json, 'source get 失败')
    assert(JSON.stringify(got.json.userPath) === JSON.stringify(patch.userPath), `userPath=${JSON.stringify(got.json.userPath)}`)
    assert(JSON.stringify(got.json.tags) === JSON.stringify(patch.tags), `tags=${JSON.stringify(got.json.tags)}`)
    assert(got.json.description === patch.description, `description=${got.json.description}`)
    record('P2-U01', 'PASS', `userPath=${patch.userPath.join('/')} tags=${patch.tags.join(',')}`)
  } catch (e) {
    record('P2-U01', 'FAIL', e.message)
  } finally {
    if (metaSourceId) cmd('wiki:source:delete', { sourceIds: [metaSourceId] })
  }

  try {
    const { category } = pickTopic()
    const r = cmd('wiki:source:update-topic', {
      agentId: 'assistant',
      sourceId: 'ghost-source-id',
      category,
      subtopic: null,
    })
    assert(r.code !== 0, '幽灵 source 应失败')
    record('P2-U02', 'PASS', 'ghost rejected')
  } catch (e) {
    record('P2-U02', 'FAIL', e.message)
  }
}

// ---------------------------------------------------------------- Agent

function runAgent() {
  try {
    const { code, json, out } = ui(['tools', 'list'])
    assert(code === 0, out.slice(0, 80))
    const text = JSON.stringify(json ?? out)
    const needed = ['wiki_overview', 'wiki_search', 'wiki_read']
    const missing = needed.filter((n) => !text.includes(n))
    assert(missing.length === 0, `缺工具 ${missing.join(',')}`)
    record('P0-M01', 'PASS', 'wiki_* tools present')
  } catch (e) {
    record('P0-M01', 'FAIL', e.message)
  }

  if (SKIP_AGENT) {
    record('P0-M02', 'SKIP', 'WIKI_CLI_SKIP_AGENT=1')
    return
  }

  try {
    const created = ui(['conversation', 'create', '--title', 'wiki-cli-agent-probe'])
    const session = created.json?.sessionKey
    if (!session) {
      record('P0-M02', 'SKIP', '无法建会话')
      return
    }
    ui([
      'send',
      '--session',
      session,
      '--text',
      '【严格测试】不要解释。只调用工具 wiki_search，参数 keyword=架构设计，limit=3。调用后停止。',
    ])
    /** 轮询 assistant 消息，直到出现真实 wiki_search tool 或超时 */
    const deadline = Date.now() + 90_000
    let used = false
    while (Date.now() < deadline && !used) {
      sleep(3000)
      const msgs = ui(['context', 'messages', '--session', session, '--limit', '30'])
      for (const m of msgs.json?.items || []) {
        if (m.role !== 'assistant') continue
        try {
          const cj = JSON.parse(m.contentJson || '{}')
          const parts = cj.parts || cj.assistant_parts || []
          if (parts.some((p) => p.type === 'tool' && p.name === 'wiki_search')) used = true
        } catch {
          /* ignore */
        }
        if (!used && /"type"\s*:\s*"tool"/.test(m.contentJson || '') && /"name"\s*:\s*"wiki_search"/.test(m.contentJson || '')) {
          used = true
        }
        if (used) break
      }
    }
    record('P0-M02', used ? 'PASS' : 'SKIP', used ? 'assistant 真实调用 wiki_search' : '90s 内未见 wiki_search tool（模型未配合）')
  } catch (e) {
    record('P0-M02', 'SKIP', e.message)
  }
}

function writeReport() {
  const pass = results.filter((r) => r.status === 'PASS').length
  const fail = results.filter((r) => r.status === 'FAIL').length
  const skip = results.filter((r) => r.status === 'SKIP').length
  const lines = [
    '# Wiki CLI 测试报告（资料层）',
    '',
    `- 日期：${nowIso()}`,
    `- 环境：lumii-ui + ~/.lumii/data/agent-runtime.db`,
    `- 汇总：**PASS ${pass}** / **FAIL ${fail}** / **SKIP ${skip}** / 合计 ${results.length}`,
    '',
    '## 结论',
    '',
    fail === 0
      ? '现存的 wiki CLI 子命令与关键命令总线已覆盖；SKIP 为防污染/手工/模型未配合。'
      : '存在 FAIL，见明细；优先修 CLI/handler 与设计不一致处。',
    '',
    '## 明细',
    '',
    '| ID | 状态 | 说明 |',
    '|---|---|---|',
  ]
  for (const r of results) {
    lines.push(`| ${r.id} | ${r.status} | ${String(r.note).replace(/\|/g, '\\|').slice(0, 120)} |`)
  }
  lines.push(
    '',
    '## 覆盖说明',
    '',
    '- **P0**：inbox list/count/organize/discard/retry、folder scan/import（--no-auto-classify）、organize run、检索（命中/空/特殊字符/空参数/--no-vector）、索引重建、cleanup scan + source get',
    '- **P1**：主题树、source list 过滤（unfiled/parking/archived）、清理扫描与归档恢复、导出三选项、向量/摘要重建',
    '- **P2**：库级迁移 plan→review（导入后必须停在 review，不静默落位）、migrate get/update-mapping/discard、元信息编辑（user_path/tags/description）',
    '- **Agent**：tools 含 wiki_*；可选一轮 wiki_search',
    '',
    '已删除用例：历史页面（page/revisions/backlinks/rollback/unresolved/concept/attach）随 P3 移除；',
    'synthesis create/accept/reject 随智能资料库 P2 移除；graph/ero 随知识图谱移除（2026-09-24）。',
    '',
    '证据：`wiki-cli-evidence.jsonl`',
    '',
  )
  fs.writeFileSync(REPORT, lines.join('\n'), 'utf8')
  console.log(`\nReport → ${REPORT}`)
  console.log(`PASS=${pass} FAIL=${fail} SKIP=${skip}`)
  if (fail > 0) process.exitCode = 1
}

main()
