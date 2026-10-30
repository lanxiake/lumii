#!/usr/bin/env node
/**
 * 能力面 P0 · 读侧验收脚本
 *
 * 对应计划 `docs/plans/能力面治理/2026-10-29-能力面治理实施计划.md` §10.4 的三条 P0 退出标准。
 * 存在的理由（§4 约束 C3 / 设计 §5.7.2）：**本仓库已栽三次「记了没人读」**——
 * `skill_usage_records` 0 行、`queryExecutionLogs` 无消费者、`capability_tests` 14 万行
 * 全是宠物测试。所以写入与读侧必须同批交付。
 *
 * 用法：
 *   node verify/capability-ranking/check-exposure.mjs            # 三条全跑
 *   node verify/capability-ranking/check-exposure.mjs --channels # 只看渠道分布
 *   node verify/capability-ranking/check-exposure.mjs --group    # 只看分组 Recall
 *   node verify/capability-ranking/check-exposure.mjs --skills   # 只看技能顺序
 *
 * 为什么是 .mjs：它是评测工具不是测试，要读本机运行时库（测试环境里没有）。
 */
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'

const DB = path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db')
const SKILLS_INDEX = path.join(os.homedir(), '.lumii', 'workspace', 'skills', 'index.json')

const only = process.argv.slice(2)
const want = (flag) => only.length === 0 || only.includes(flag)

function openDb() {
  return new DatabaseSync(DB, { readOnly: true })
}

function tableExists(db, name) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name)
  return !!row
}

// ─── ① 渠道分布 ────────────────────────────────────────────────────────────

function checkChannels() {
  console.log('\n① 渠道分布（退出标准：unknown 占比 < 1%）')
  console.log('─'.repeat(64))
  const db = openDb()
  if (!tableExists(db, 'tool_exposure_log')) {
    console.log('✗ 表 tool_exposure_log 不存在——V56 迁移没跑（客户端还没重启过？）')
    db.close()
    return
  }
  const rows = db
    .prepare('SELECT channel, COUNT(*) AS n FROM tool_exposure_log GROUP BY channel ORDER BY n DESC')
    .all()
  db.close()

  if (rows.length === 0) {
    console.log('· 还没有任何记录。跑几轮对话再来看。')
    return
  }

  const total = rows.reduce((s, r) => s + r.n, 0)
  for (const r of rows) {
    const pct = ((r.n / total) * 100).toFixed(1)
    console.log(`  ${String(r.channel).padEnd(12)} ${String(r.n).padStart(7)}  ${pct.padStart(6)}%`)
  }
  const unknown = rows.find((r) => r.channel === 'unknown')?.n ?? 0
  const ratio = (unknown / total) * 100
  console.log(`\n  合计 ${total} 行，unknown ${unknown} 行 = ${ratio.toFixed(2)}%`)
  console.log(ratio < 1 ? '  ✓ 达标（< 1%）' : '  ✗ 未达标（需 < 1%）')

  // `unknown` 集中在哪些 Agent——排查归因失败的实际入口
  if (unknown > 0) {
    const db2 = openDb()
    const byAgent = db2
      .prepare(
        "SELECT agent_id, COUNT(*) AS n FROM tool_exposure_log WHERE channel = 'unknown' GROUP BY agent_id ORDER BY n DESC LIMIT 10",
      )
      .all()
    db2.close()
    console.log('\n  unknown 的分布（按 Agent）：')
    for (const r of byAgent) console.log(`    ${String(r.agent_id).padEnd(24)} ${r.n}`)
  }
}

// ─── ② 用暴露日志重算分组表 ────────────────────────────────────────────────

/**
 * 与 replay.mjs 同口径的 Recall 计算。
 *
 * **两边的数据源不同，这正是这条验收的意义**：
 * - `replay.mjs` 从 `messages` 表反推每轮用了什么，渠道靠人肉解析 `conversation_id` 前缀；
 * - 这里从 `tool_exposure_log` 读**当时实际装了哪些工具**，渠道是落库值。
 *
 * 两者对得上，说明"暴露记录"确实是模型看到的那一面（而不是另一个视图）。
 */
function checkGroup() {
  console.log('\n② 用 tool_exposure_log 重算分组 Recall（退出标准：与 replay 误差 < 1pp）')
  console.log('─'.repeat(64))
  const db = openDb()
  if (!tableExists(db, 'tool_exposure_log')) {
    console.log('✗ 表不存在')
    db.close()
    return
  }
  const rows = db
    .prepare(
      'SELECT created_at, agent_id, channel, tools FROM tool_exposure_log ORDER BY created_at ASC, id ASC',
    )
    .all()
  db.close()

  if (rows.length < 50) {
    console.log(`· 只有 ${rows.length} 行，样本太少（至少 50 行才有意义）。`)
    return
  }

  // 「这一轮实际调了哪些工具」只能从 messages 取：审计表（tool_audit_log）**只记失败**，
  // 拿它当调用集合会把成功调用全漏掉。所以这里把 messages 的工具调用与会话内最近一条
  // 暴露记录配对（±10 分钟），算 exposed ⊇ used 的比例。
  const db2 = openDb()
  const msgs = db2
    .prepare(
      "SELECT conversation_id, timestamp, content_json FROM messages " +
        "WHERE content_json LIKE '%\"type\":\"tool\"%' ORDER BY timestamp ASC",
    )
    .all()
  db2.close()

  const used = []
  for (const m of msgs) {
    let o
    try {
      o = JSON.parse(m.content_json)
    } catch {
      continue
    }
    const tools = (o.parts || []).filter((p) => p.type === 'tool').map((p) => p.name)
    if (tools.length) used.push({ t: Date.parse(m.timestamp), tools: [...new Set(tools)] })
  }
  if (used.length === 0) {
    console.log('· messages 里没有工具调用记录')
    return
  }

  const byKey = new Map()
  for (const e of used) {
    const hit = rows.filter((r) => Math.abs(r.created_at - e.t) <= 10 * 60 * 1000)
    if (hit.length === 0) continue
    const r = hit.at(-1)
    const key = `${r.agent_id} / ${r.channel}`
    if (!byKey.has(key)) byKey.set(key, { events: 0, recall: 0 })
    const stat = byKey.get(key)
    stat.events += 1
    const exposed = new Set(JSON.parse(r.tools).map((x) => x.n))
    const hitTools = e.tools.filter((n) => exposed.has(n)).length
    stat.recall += hitTools / e.tools.length
  }

  if (byKey.size === 0) {
    console.log('· 暴露记录与工具调用在 ±10 分钟内没有对上——先确认两边都在记。')
    return
  }

  console.log('  Agent / 渠道                         事件   已装载 Recall')
  for (const [key, s] of [...byKey.entries()].sort((a, b) => b[1].events - a[1].events)) {
    console.log(
      `  ${key.padEnd(34)} ${String(s.events).padStart(6)}   ${((s.recall / s.events) * 100).toFixed(1)}%`,
    )
  }
  console.log(
    '\n  注：P0 阶段是全量常驻，Recall 应当接近 100%。' +
      '\n  裁剪（P2）上线后这张表才变成"有没有伤到模型"的判据。',
  )
}

// ─── ③ 技能顺序 ────────────────────────────────────────────────────────────

async function checkSkills() {
  console.log('\n③ 技能提示词顺序（退出标准：== executionCount 降序）')
  console.log('─'.repeat(64))
  let raw
  try {
    raw = await fs.readFile(SKILLS_INDEX, 'utf-8')
  } catch {
    console.log(`✗ 读不到 ${SKILLS_INDEX}`)
    return
  }
  let idx
  try {
    idx = JSON.parse(raw)
  } catch {
    console.log('✗ 索引不是合法 JSON')
    return
  }
  const skills = Array.isArray(idx) ? idx : (idx.skills ?? [])
  const withCount = skills.filter((s) => (s.executionCount ?? 0) > 0)
  const max = withCount.reduce((m, s) => Math.max(m, s.executionCount ?? 0), 0)

  console.log(`  技能总数 ${skills.length}，有执行记录 ${withCount.length}，最高 ${max} 次`)
  console.log('\n  前 15 名（按 executionCount 降序，即提示词应当呈现的顺序）：')
  ;[...withCount]
    .sort((a, b) => (b.executionCount ?? 0) - (a.executionCount ?? 0))
    .slice(0, 15)
    .forEach((s, i) => {
      console.log(`    ${String(i + 1).padStart(2)}. ${String(s.name).padEnd(30)} ${s.executionCount}`)
    })

  // 数据量级的诚实提示（设计 §2.1b）：这个量级上排序排的是噪声
  if (max < 20) {
    console.log(
      `\n  ⚠ 最高仅 ${max} 次。设计 §2.1b 的结论仍然成立：**这个量级撑不起数据驱动排序**。` +
        '\n    补 usageCount 的唯一目的是让提示词那句"ordered by usage"不再是谎话。',
    )
  }
}

// ─── ④ token 口径对账（P1 校准的前置检查）────────────────────────────────

/**
 * 暴露记录里的 `total_tokens` 能不能和日志里 `contextUsage` 的 `tools+mcp` 对上。
 *
 * **为什么必须在 P0 就查**：两处用的估算路径不同（明细按标定 charsPerToken，
 * 权重法 0.3/0.6 字符是另一条），实测差过 2.4 倍。若这里对不上，P1 页面上
 * 「谁最贵」的绝对数字就是错的，只能当相对排名看——那要在 P1 之前知道。
 */
async function checkTokens() {
  console.log('\n④ token 口径对账（退出标准：与日志 tools+mcp 误差 < 10%）')
  console.log('─'.repeat(64))
  const logDir = path.join(os.homedir(), '.lumii', 'logs', 'app')
  let files = []
  try {
    files = (await fs.readdir(logDir))
      .filter((f) => f.startsWith('mtbot-') && f.endsWith('.log') && !f.includes('error'))
      .sort()
      .slice(-2)
  } catch {
    console.log(`✗ 读不到日志目录 ${logDir}`)
    return
  }

  const usage = []
  for (const f of files) {
    const raw = await fs.readFile(path.join(logDir, f), 'utf-8')
    for (const line of raw.split('\n')) {
      const m = /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\.\d+\].*推送 contextUsage.*breakdown=(.*)$/.exec(
        line,
      )
      if (!m) continue
      const parts = Object.fromEntries(
        m[2]
          .split(',')
          .map((kv) => kv.split(':'))
          .filter((kv) => kv.length === 2)
          .map(([k, v]) => [k.trim(), Number(v)]),
      )
      usage.push({ at: Date.parse(m[1].replace(' ', 'T')), tools: (parts.tools ?? 0) + (parts.mcp ?? 0) })
    }
  }
  if (usage.length === 0) {
    console.log('· 日志里没有 contextUsage 事件')
    return
  }

  const db = openDb()
  if (!tableExists(db, 'tool_exposure_log')) {
    console.log('✗ 表不存在')
    db.close()
    return
  }
  const rows = db.prepare('SELECT created_at, total_tokens FROM tool_exposure_log ORDER BY created_at ASC').all()
  db.close()
  if (rows.length === 0) {
    console.log('· 还没有暴露记录')
    return
  }

  // 每行暴露记录找时间上最近的 contextUsage（±5 分钟）
  const pairs = []
  for (const r of rows) {
    let best = null
    for (const u of usage) {
      const d = Math.abs(u.at - r.created_at)
      if (d <= 5 * 60 * 1000 && (!best || d < best.d)) best = { d, u }
    }
    if (best) pairs.push({ at: r.created_at, ours: r.total_tokens, log: best.u.tools })
  }
  if (pairs.length === 0) {
    console.log('· 暴露记录与 contextUsage 在 ±5 分钟内没有交集')
    return
  }

  // 只按**最近 3 组**判定：口径改过一次（权重法 → 标定法）时，改动之前写下的行
  // 比值会明显不同，把它们混进中位数会让"现在是对的吗"这个问题的答案变成噪声。
  const recent = pairs.slice(-3)
  for (const p of recent) {
    const r = p.log > 0 ? p.ours / p.log : Number.NaN
    console.log(
      `  ${new Date(p.at).toISOString().slice(11, 19)}  我们 ${String(p.ours).padStart(6)}` +
        ` / 日志 ${String(p.log).padStart(6)} = ${Number.isFinite(r) ? r.toFixed(3) : '—'}`,
    )
  }
  const ratios = recent.map((p) => (p.log > 0 ? p.ours / p.log : Number.NaN)).filter(Number.isFinite)
  ratios.sort((a, b) => a - b)
  const median = ratios[Math.floor(ratios.length / 2)]
  const dev = Math.abs(median - 1) * 100
  console.log(`\n  配对 ${recent.length} 组（共 ${pairs.length}）；中位比值 = ${median.toFixed(3)}，偏差 ${dev.toFixed(1)}%`)
  console.log(dev < 10 ? '  ✓ 达标（< 10%）' : '  ✗ 未达标——检查 charsPerToken 是否真的传到了记录点')

  if (pairs.length > recent.length) {
    const older = pairs.slice(0, -recent.length)
    const oldMedian = older
      .map((p) => (p.log > 0 ? p.ours / p.log : Number.NaN))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[Math.floor(older.length / 2)]
    if (Number.isFinite(oldMedian) && Math.abs(oldMedian - median) > 0.2) {
      console.log(
        `\n  ⚠ 更早的 ${older.length} 组中位比值是 ${oldMedian.toFixed(3)}，与最近不同——` +
          '\n    多半是口径改动前写下的历史行。判据只看最近这一批。',
      )
    }
  }
}

// ─── main ─────────────────────────────────────────────────────────────────

const t0 = Date.now()
const run = async () => {
  console.log('能力面 P0 · 读侧验收')
  console.log(`库：${DB}`)
  if (want('--channels')) checkChannels()
  if (want('--group')) checkGroup()
  if (want('--skills')) await checkSkills()
  if (want('--tokens')) await checkTokens()
  console.log(`\n用时 ${Date.now() - t0}ms`)
}
await run()
