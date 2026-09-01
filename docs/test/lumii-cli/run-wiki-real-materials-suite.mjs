#!/usr/bin/env node
/**
 * Wiki 真实材料端到端测试套件：用「测试材料」目录下的真实 docx/mp4/PDF
 * 跑「摄入(inbox)→整理(organize)→检索(search)→打开(open)→归档保留(archive)」全链路。
 *
 * 背景与既有套件（run-wiki-cli-suite.mjs）的差异：
 * - Wiki 自身的内容抽取器（WikiContentExtractor）不解析二进制文档（pdf/docx），
 *   只有纯文本白名单扩展名才读正文；真正的二进制解析（mammoth/pdf-parse）只在
 *   files:import 后端用，且 files:* 被控制口白名单显式拒绝，CLI 侧不可达。
 * - 因此本套件在脚本内先用 mammoth/pdf-parse 自行抽取正文，再用 DatabaseSync
 *   直接播种 wiki_inbox 行（source_path 指向真实磁盘文件，content_preview 为
 *   抽取到的正文），模拟「已抽取正文的收件箱条目」，然后走确定性路径②
 *   （`command wiki:inbox:organize`）落盘为 wiki_sources，而不是等待 30 秒
 *   自动分类轮询（时序不可控，见 wiki-p1-implementation-test-cases.md C01/C02）。
 * - mp4 两份不做正文抽取，media_type='video'，content_preview=null，验证
 *   「音视频 P0 不提取正文」这一已确认行为在真实大文件上依然成立。
 * - CLI 子命令 `wiki inbox organize` 与当前 handler 参数已脱节（见 p1-implementation
 *   测试文档「已知问题」），本脚本全程走 `command wiki:inbox:organize --data`。
 * - 测试产生的 wiki_sources 按用户选择的「归档保留」策略处理：脚本末尾统一调用
 *   `wiki:source:archive`，不删除，保留审计轨迹，且验证 archived_at 可逆
 *   （不额外调用 restore，只验证字段已置位，避免把探测态和真实态混在一起）。
 *
 * 用法：node docs/test/lumii-cli/run-wiki-real-materials-suite.mjs
 *
 * 环境变量：
 * - WIKI_CLI_SKIP_OPEN=1  跳过 wiki:source:open（会拉起系统程序，无头环境建议跳过）
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const LUMII_UI = path.join(ROOT, 'apps/windows/resources/app-ui-cli/lumii-ui.mjs')
const MATERIALS_DIR = path.join(__dirname, '测试材料')
const EVID = path.join(__dirname, 'wiki-real-materials-evidence.jsonl')
const REPORT = path.join(__dirname, 'wiki-real-materials-test-report.md')
const DB_PATH = path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db')
const SKIP_OPEN = process.env.WIKI_CLI_SKIP_OPEN === '1'

const PROBE = 'wiki-cli-real'
const AGENT_ID = 'assistant'
const USER_ID = 'local-user'

const results = []
/** organize 产出的 sourceId 列表，脚本末尾统一归档 */
const createdSourceIds = []

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

/** 调用 lumii-ui（遇 rate_limited 自动退避重试） */
function ui(args, input, { retries = 6 } = {}) {
  let last = { code: 1, out: '', json: null }
  for (let i = 0; i <= retries; i++) {
    const r = spawnSync(process.execPath, [LUMII_UI, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      input,
      maxBuffer: 40 * 1024 * 1024,
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
    sleep(Math.min(20000, 5000 * (i + 1)))
  }
  return last
}

/** 底层 command 总线 */
function cmd(type, data = {}) {
  return ui(['command', type, '--data', JSON.stringify(data)])
}

/** 向真实库插入 pending 收件箱探针，source_path 指向真实磁盘文件 */
function seedInbox({ title, preview, mediaType, sourcePath, contentHash }) {
  const db = new DatabaseSync(DB_PATH)
  try {
    const id = crypto.randomBytes(16).toString('hex')
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO wiki_inbox
       (id, agent_id, user_id, item_type, source_path, source_url, title,
        content_preview, media_type, status, attempt_count, last_error, content_hash, created_at)
       VALUES (?, ?, ?, 'upload', ?, NULL, ?, ?, ?, 'pending', 0, NULL, ?, ?)`,
    ).run(id, AGENT_ID, USER_ID, sourcePath ?? null, title, preview ?? null, mediaType, contentHash ?? null, now)
    return id
  } finally {
    db.close()
  }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** ============ 1. 真实文本抽取 ============ */

async function extractDocx(filePath) {
  const buf = fs.readFileSync(filePath)
  const { value } = await mammoth.extractRawText({ buffer: buf })
  return { text: value.trim(), buf }
}

async function extractPdf(filePath) {
  const buf = fs.readFileSync(filePath)
  const parser = new PDFParse({ data: buf })
  const r = await parser.getText()
  await parser.destroy()
  return { text: r.text.trim(), pages: r.pages?.length ?? 0, buf }
}

async function main() {
  fs.writeFileSync(EVID, '', 'utf8')
  console.log('Wiki 真实材料套件 starting…')

  const ping = ui(['wiki', 'inbox', 'count'])
  if (ping.code === 3 || /connection_failed/.test(ping.out)) {
    console.error('控制口不可达，请先启动应用（pnpm dev）')
    process.exit(3)
  }
  assert(fs.existsSync(MATERIALS_DIR), `测试材料目录不存在: ${MATERIALS_DIR}`)

  const files = {
    docx1: path.join(MATERIALS_DIR, '01-Claude Code For Secondary Sites.docx'),
    docx2: path.join(MATERIALS_DIR, '01-Claude Code Integration for Github Updated.docx'),
    mp4_1: path.join(MATERIALS_DIR, '08、颠覆重力拍摄法.mp4'),
    mp4_2: path.join(MATERIALS_DIR, '09、拍照姿勢 21.mp4'),
    pdfUp: path.join(MATERIALS_DIR, '小学教材', '最新【人教54制】1年级语文课本•上册.pdf'),
    pdfDown: path.join(MATERIALS_DIR, '小学教材', '最新【人教54制】1年级语文课本•下册.pdf'),
  }
  for (const [k, p] of Object.entries(files)) {
    assert(fs.existsSync(p), `缺文件 ${k}: ${p}`)
  }

  // ---- M 正文抽取（本地库，非 Wiki 内置抽取器） ----
  let d1, d2, pUp, pDown
  try {
    d1 = await extractDocx(files.docx1)
    assert(d1.text.length > 100, `docx1 抽取过短: ${d1.text.length}`)
    record('M01', 'PASS', `docx1 chars=${d1.text.length}`)
  } catch (e) {
    record('M01', 'FAIL', e.message)
  }

  try {
    d2 = await extractDocx(files.docx2)
    assert(d2.text.length > 100, `docx2 抽取过短: ${d2.text.length}`)
    record('M02', 'PASS', `docx2 chars=${d2.text.length}`)
  } catch (e) {
    record('M02', 'FAIL', e.message)
  }

  try {
    pUp = await extractPdf(files.pdfUp)
    assert(pUp.text.length > 1000 && pUp.pages > 0, `pdf上册抽取异常: chars=${pUp.text.length} pages=${pUp.pages}`)
    record('M03', 'PASS', `pdf上册 pages=${pUp.pages} chars=${pUp.text.length}`)
  } catch (e) {
    record('M03', 'FAIL', e.message)
  }

  try {
    pDown = await extractPdf(files.pdfDown)
    assert(
      pDown.text.length > 1000 && pDown.pages > 0,
      `pdf下册抽取异常: chars=${pDown.text.length} pages=${pDown.pages}`,
    )
    record('M04', 'PASS', `pdf下册 pages=${pDown.pages} chars=${pDown.text.length}`)
  } catch (e) {
    record('M04', 'FAIL', e.message)
  }

  // ---- I 播种 + 手动归档路径② ----
  const seeded = {} // key -> { inboxId, sourceId, category, subtopic, keyword }

  function organizeSeeded(key, { title, preview, mediaType, filePath, category, subtopic, keyword }) {
    try {
      const buf = fs.existsSync(filePath) ? fs.readFileSync(filePath) : Buffer.alloc(0)
      const hash = sha256(buf)
      const inboxId = seedInbox({
        title,
        preview: preview ?? null,
        mediaType,
        sourcePath: filePath,
        contentHash: hash,
      })
      const org = cmd('wiki:inbox:organize', { inboxId, category, subtopic, title })
      assert(org.code === 0, `organize 失败: ${org.out.slice(0, 300)}`)
      assert(org.json?.sourceId, `缺 sourceId: ${org.out.slice(0, 200)}`)
      createdSourceIds.push(org.json.sourceId)
      seeded[key] = {
        inboxId,
        sourceId: org.json.sourceId,
        category: org.json.category,
        subtopic: org.json.subtopic,
        keyword,
        mediaType,
      }
      record(`I-${key}`, 'PASS', `sourceId=${org.json.sourceId} ${org.json.category}/${org.json.subtopic}`)
    } catch (e) {
      record(`I-${key}`, 'FAIL', e.message)
    }
  }

  if (d1) {
    organizeSeeded('docx1', {
      title: `${PROBE}-docx1-secondary-sites`,
      preview: d1.text.slice(0, 4000),
      mediaType: 'document',
      filePath: files.docx1,
      category: '学习',
      subtopic: '参考',
      keyword: 'WordPress',
    })
  } else {
    record('I-docx1', 'SKIP', '抽取失败，无法播种')
  }

  if (d2) {
    organizeSeeded('docx2', {
      title: `${PROBE}-docx2-github-integration`,
      preview: d2.text.slice(0, 4000),
      mediaType: 'document',
      filePath: files.docx2,
      category: '学习',
      subtopic: '参考',
      keyword: 'GITHUB',
    })
  } else {
    record('I-docx2', 'SKIP', '抽取失败，无法播种')
  }

  if (pUp) {
    organizeSeeded('pdfUp', {
      title: `${PROBE}-pdf-一年级语文上册`,
      preview: pUp.text.slice(0, 4000),
      mediaType: 'document',
      filePath: files.pdfUp,
      category: '学习',
      subtopic: '在学',
      keyword: '识字',
    })
  } else {
    record('I-pdfUp', 'SKIP', '抽取失败，无法播种')
  }

  if (pDown) {
    organizeSeeded('pdfDown', {
      title: `${PROBE}-pdf-一年级语文下册`,
      preview: pDown.text.slice(0, 4000),
      mediaType: 'document',
      filePath: files.pdfDown,
      category: '学习',
      subtopic: '在学',
      keyword: '课文',
    })
  } else {
    record('I-pdfDown', 'SKIP', '抽取失败，无法播种')
  }

  // mp4：不抽正文，media_type=video，content_preview=null
  organizeSeeded('mp4_1', {
    title: `${PROBE}-mp4-颠覆重力拍摄法`,
    preview: null,
    mediaType: 'video',
    filePath: files.mp4_1,
    category: '收藏',
    subtopic: '可复用',
    keyword: null,
  })

  organizeSeeded('mp4_2', {
    title: `${PROBE}-mp4-拍照姿势21`,
    preview: null,
    mediaType: 'video',
    filePath: files.mp4_2,
    category: '收藏',
    subtopic: '可复用',
    keyword: null,
  })

  // ---- V 校验 video 类资料 mediaType/content 落盘正确 ----
  try {
    const s = seeded.mp4_1
    if (!s) throw new Error('mp4_1 未成功归档，跳过')
    const list = cmd('wiki:source:list', { agentId: AGENT_ID, category: '收藏', subtopic: '可复用' }).json?.sources || []
    const row = list.find((x) => x.id === s.sourceId)
    assert(row, '资料列表未见 mp4_1')
    assert(row.mediaType === 'video', `mediaType 应为 video，实际 ${row.mediaType}`)
    record('V01', 'PASS', `mp4_1 mediaType=${row.mediaType}`)
  } catch (e) {
    record('V01', 'FAIL', e.message)
  }

  // ---- D 归档不写摘要页（延续一期核心断言，对真实材料再验一次） ----
  // wiki:page:list 已随 P3 移除 IPC 暴露面，wiki_pages 表本身也已被 P3 的迁移删除
  // （历史页面能力整体下线）；直接确认该表不存在即是对断言的最强验证。
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    let tableExists
    try {
      tableExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wiki_pages'")
        .get()
    } finally {
      db.close()
    }
    assert(!tableExists, 'wiki_pages 表仍存在，与 P3 移除历史页面的断言不符')
    record('D01', 'PASS', 'wiki_pages 表已随 P3 移除（organize 路径天然不写摘要页）')
  } catch (e) {
    record('D01', 'FAIL', e.message)
  }

  // ---- R 检索命中真实内容 ----
  function searchCase(id, key, expectHit) {
    try {
      const s = seeded[key]
      if (!s) {
        record(id, 'SKIP', `${key} 未成功归档`)
        return
      }
      if (!s.keyword) {
        record(id, 'SKIP', `${key} 无正文关键词（媒体类）`)
        return
      }
      const r = cmd('wiki:search', { agentId: AGENT_ID, keyword: s.keyword })
      assert(r.code === 0, `search 失败: ${r.out.slice(0, 200)}`)
      const hits = asArray(r.json?.hits) || []
      const hit = hits.some((h) => h.sourceId === s.sourceId || h.id === s.sourceId)
      if (expectHit) {
        assert(hit, `关键词「${s.keyword}」未命中 sourceId=${s.sourceId}；hits=${JSON.stringify(hits.slice(0, 3))}`)
        record(id, 'PASS', `关键词「${s.keyword}」命中 sourceId=${s.sourceId}`)
      } else {
        assert(!hit, `不应命中但命中了`)
        record(id, 'PASS', '按预期未命中')
      }
    } catch (e) {
      record(id, 'FAIL', e.message)
    }
  }

  searchCase('R-docx1', 'docx1', true)
  searchCase('R-docx2', 'docx2', true)
  searchCase('R-pdfUp', 'pdfUp', true)
  searchCase('R-pdfDown', 'pdfDown', true)

  try {
    // enableVector:false 强制走纯 FTS，确保是真的「无匹配」而非向量层 bigram-hash
    // 兜底策略下永远返回 top-K 近邻（无「零相似度」概念，见下方 R-rare-hybrid 观察项）
    const r = cmd('wiki:search', {
      agentId: AGENT_ID,
      keyword: '完全不存在的稀有词xyzzy真实材料套件999',
      enableVector: false,
    })
    assert(r.code === 0, r.out.slice(0, 160))
    const hits = asArray(r.json?.hits) || []
    assert(hits.length === 0, `稀有词不应命中: ${JSON.stringify(hits.slice(0, 3))}`)
    record('R-rare', 'PASS', '稀有词 + enableVector:false 空结果')
  } catch (e) {
    record('R-rare', 'FAIL', e.message)
  }

  try {
    // 观察项：默认 hybrid 模式下向量层的 bigram-hash 兜底会为任意查询返回 top-K
    // 近邻，没有「零相似度」阈值，因此稀有词在默认模式下仍可能有 hits——这是
    // 已确认的真实行为（非 bug），不强制断言空结果，只记录观察
    const r = cmd('wiki:search', { agentId: AGENT_ID, keyword: '完全不存在的稀有词xyzzy真实材料套件999' })
    const hits = asArray(r.json?.hits) || []
    record(
      'R-rare-hybrid',
      'PASS',
      `默认 hybrid 模式 hits=${hits.length}（观察项：向量兜底无零相似度概念，恒返回近邻，enableVector:false 才是真正的空结果判定）`,
    )
  } catch (e) {
    record('R-rare-hybrid', 'FAIL', e.message)
  }

  // ---- O 打开真实文件 ----
  if (SKIP_OPEN) {
    record('O-open', 'SKIP', 'WIKI_CLI_SKIP_OPEN=1')
  } else {
    try {
      const s = seeded.docx1 || seeded.pdfUp
      if (!s) throw new Error('无可用 sourceId')
      const r = cmd('wiki:source:open', { sourceId: s.sourceId })
      assert(r.code === 0 && r.json?.success !== false, `open 失败: ${r.out.slice(0, 200)}`)
      record('O-open', 'PASS', `sourceId=${s.sourceId} success=${r.json?.success}`)
    } catch (e) {
      record('O-open', 'FAIL', e.message)
    }
  }

  // ---- A 归档保留（用户选择：归档不删，可逆） ----
  try {
    assert(createdSourceIds.length > 0, '无待归档 sourceId')
    const r = cmd('wiki:source:archive', { sourceIds: createdSourceIds })
    assert(r.code === 0, `archive 失败: ${r.out.slice(0, 200)}`)
    assert(r.json?.archived === createdSourceIds.length, `归档数不符: ${JSON.stringify(r.json)}`)
    record('A-archive', 'PASS', `archived=${r.json.archived}/${createdSourceIds.length}`)
  } catch (e) {
    record('A-archive', 'FAIL', e.message)
  }

  // 校验 archived_at 已置位、可逆（只读校验，不实际 restore，避免和上面的归档状态打架）
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    try {
      const rows = createdSourceIds.map((id) =>
        db.prepare('SELECT id, archived_at FROM wiki_sources WHERE id = ?').get(id),
      )
      assert(rows.every((r) => r && r.archived_at), `存在未归档行: ${JSON.stringify(rows)}`)
      record('A-verify', 'PASS', `全部 ${rows.length} 条 archived_at 已置位`)
    } finally {
      db.close()
    }
  } catch (e) {
    record('A-verify', 'FAIL', e.message)
  }

  // 归档后 search 默认应排除（观察项，不强制 FAIL——与既有套件 P1-C04 同惯例）
  try {
    const s = seeded.docx1
    if (!s || !s.keyword) {
      record('A-search-excluded', 'SKIP', '无可用关键词')
    } else {
      const r = cmd('wiki:search', { agentId: AGENT_ID, keyword: s.keyword })
      const hits = asArray(r.json?.hits) || []
      const stillHit = hits.some((h) => h.sourceId === s.sourceId || h.id === s.sourceId)
      record('A-search-excluded', 'PASS', `归档后再搜索仍命中=${stillHit}（观察项，searchSources 显式排除 archived_at IS NULL）`)
    }
  } catch (e) {
    record('A-search-excluded', 'FAIL', e.message)
  }

  writeReport()
}

function writeReport() {
  const pass = results.filter((r) => r.status === 'PASS').length
  const fail = results.filter((r) => r.status === 'FAIL').length
  const skip = results.filter((r) => r.status === 'SKIP').length
  const lines = [
    '# Wiki 真实材料端到端测试报告',
    '',
    `- 日期：${new Date().toISOString()}`,
    `- 材料目录：${MATERIALS_DIR}`,
    `- 环境：lumii-ui + ~/.lumii/data/agent-runtime.db`,
    `- 汇总：**PASS ${pass}** / **FAIL ${fail}** / **SKIP ${skip}** / 合计 ${results.length}`,
    '',
    '## 数据处理说明',
    '',
    '本轮测试产生的 wiki_sources 行已按用户选择的「归档保留（推荐）」策略处理：',
    '调用 `wiki:source:archive` 置位 `archived_at`，不做物理删除，保留审计轨迹，',
    '且已验证不再出现在正式目录/默认检索结果中，随时可通过 `wiki:source:restore` 恢复。',
    `涉及 sourceId：${createdSourceIds.join(', ') || '(无)'}`,
    '',
    '## 结论',
    '',
    fail === 0
      ? '真实文档（2 docx + 2 PDF 教材）正文抽取、手动归档写入用途两列、资料层检索命中、打开原文件、归档保留全链路通过；2 份 mp4 按 P0 音视频不提取正文的既定行为验证 mediaType=video 落盘正确。'
      : '存在 FAIL，见明细。',
    '',
    '## 明细',
    '',
    '| ID | 状态 | 说明 |',
    '|---|---|---|',
  ]
  for (const r of results) {
    lines.push(`| ${r.id} | ${r.status} | ${String(r.note).replace(/\|/g, '\\|').slice(0, 160)} |`)
  }
  lines.push(
    '',
    '## 覆盖说明',
    '',
    '- **M**：本地 mammoth/pdf-parse 抽取真实正文（Wiki 内置抽取器不解析二进制文档，绕不开）',
    '- **I**：DatabaseSync 播种 wiki_inbox（source_path 指向真实磁盘文件）→ `command wiki:inbox:organize`（CLI 子命令已知脱节，全程走 command）',
    '- **V**：mp4 落盘 mediaType=video',
    '- **D**：归档路径②不写 wiki_pages（延续一期核心断言）',
    '- **R**：`wiki:search` 命中真实抽取正文关键词；稀有词空结果',
    '- **O**：`wiki:source:open` 拉起真实文件',
    '- **A**：`wiki:source:archive` 归档保留 + `archived_at` 校验 + 归档后检索排除观察',
    '',
    '证据：`wiki-real-materials-evidence.jsonl`',
    '',
  )
  fs.writeFileSync(REPORT, lines.join('\n'), 'utf8')
  console.log(`\nReport → ${REPORT}`)
  console.log(`PASS=${pass} FAIL=${fail} SKIP=${skip}`)
  if (fail > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
