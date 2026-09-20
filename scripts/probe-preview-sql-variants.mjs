/**
 * 会话列表预览查询：候选改法的实测对比。
 *
 * 现状（基线）401~602ms 跑在主线程上（better-sqlite3 同步），而 ChatPage 有五个
 * 无防抖的触发点，三次并发叠加就超过捕获器 2s 阈值 —— 09:59 两次冻结即由此而来。
 *
 * 基线 SQL 的问题：`content_json` 在 CTE 内部就被 SELECT，窗口函数必须对全部
 * 2530 行（39MB）算完 ROW_NUMBER，最后才 `rn <= 20`；载荷 19.4MB 全部跨
 * native→JS 边界。
 *
 * 本脚本比较四种改法，并**校验语义等价**（提取出的预览文本必须与 JS 版逐字一致）。
 * 只读打开。
 */
import { DatabaseSync } from 'node:sqlite'
import os from 'os'
import path from 'path'

const db = new DatabaseSync(path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db'), {
  readOnly: true,
})
const ms = (a, b) => Number(b - a) / 1e6
const f = (n) => n.toFixed(1)

const userId = db.prepare('SELECT user_id FROM conversations LIMIT 1').get().user_id
const convs = db
  .prepare(
    `SELECT * FROM conversations WHERE user_id = ? AND is_active = 1
     ORDER BY is_pinned DESC, COALESCE(last_msg_at, created_at) DESC`,
  )
  .all(userId)
const ids = convs.map((c) => c.id)
const ph = ids.map(() => '?').join(',')
const LIMIT = 20

/** 与 conversation-commands.ts:183 extractPreviewText 逐字等价的 JS 版 */
function extractPreviewText(contentJson) {
  try {
    const parsed = JSON.parse(contentJson)
    if (!parsed || typeof parsed !== 'object') return ''
    const o = parsed
    if (Array.isArray(o.parts)) {
      return o.parts
        .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text.trim())
        .filter(Boolean)
        .join(' ')
        .trim()
    }
    if (typeof o.text === 'string') return o.text.trim()
    if (typeof o.content === 'string') return o.content.trim()
    return ''
  } catch {
    return ''
  }
}

/** 与 resolveLastMessagePreview 等价：从后往前找第一条有正文的 */
function resolvePreview(messages) {
  let userFallback = ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (!msg) continue
    const text = extractPreviewText(msg.content_json)
    if (!text) continue
    if (msg.role === 'assistant') return text
    if (msg.role === 'user' && !userFallback) userFallback = text
  }
  return userFallback
}

function time(label, fn, runs = 3) {
  let out
  let best = Infinity
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint()
    out = fn()
    const t1 = process.hrtime.bigint()
    best = Math.min(best, ms(t0, t1))
  }
  return { label, ms: best, out }
}

// ── 基线 ──────────────────────────────────────────────────────────────────
const SQL_BASE = `
  WITH ranked AS (
    SELECT conversation_id, role, content_json, timestamp,
           ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY timestamp DESC) AS rn
    FROM messages WHERE conversation_id IN (${ph}) AND is_streaming = 0
  )
  SELECT conversation_id, role, content_json, timestamp FROM ranked
  WHERE rn <= ? ORDER BY conversation_id, timestamp ASC`

const base = time('基线（现状）', () => db.prepare(SQL_BASE).all(...ids, LIMIT))
const basePayload = base.out.reduce((a, r) => a + r.content_json.length, 0)
console.log(`${base.label.padEnd(34)} ${f(base.ms).padStart(7)}ms  行 ${base.out.length}  载荷 ${(basePayload / 1048576).toFixed(1)}MB`)

// 基线产出的预览（作为语义基准）
function previewsFrom(rows) {
  const m = new Map()
  for (const r of rows) {
    const l = m.get(r.conversation_id)
    if (l) l.push(r)
    else m.set(r.conversation_id, [r])
  }
  const out = new Map()
  for (const c of convs) out.set(c.id, resolvePreview(m.get(c.id) ?? []))
  return out
}
const expected = previewsFrom(base.out)
const withPreview = [...expected.values()].filter(Boolean).length
console.log(`  ↳ 有预览的会话 ${withPreview}/${convs.length}（作为语义基准）\n`)

// ── 变体 B：窗口函数不带 content_json，最后 JOIN 回取 ──────────────────────
const SQL_JOIN = `
  WITH ranked AS (
    SELECT id, conversation_id, role, timestamp,
           ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY timestamp DESC) AS rn
    FROM messages WHERE conversation_id IN (${ph}) AND is_streaming = 0
  )
  SELECT m.conversation_id, m.role, m.content_json, m.timestamp
  FROM ranked r JOIN messages m ON m.id = r.id
  WHERE r.rn <= ? ORDER BY r.conversation_id, r.timestamp ASC`

const joinVar = time('B 窗口不带 content_json + JOIN', () => db.prepare(SQL_JOIN).all(...ids, LIMIT))
const joinPayload = joinVar.out.reduce((a, r) => a + r.content_json.length, 0)
const joinSame = JSON.stringify([...previewsFrom(joinVar.out)]) === JSON.stringify([...expected])
console.log(`${joinVar.label.padEnd(34)} ${f(joinVar.ms).padStart(7)}ms  行 ${joinVar.out.length}  载荷 ${(joinPayload / 1048576).toFixed(1)}MB  语义一致=${joinSame}`)

// ── 变体 C：每会话相关子查询（走 idx_messages_conversation_ts）─────────────
const SQL_CORR = `
  SELECT m.conversation_id, m.role, m.content_json, m.timestamp
  FROM messages m
  WHERE m.is_streaming = 0
    AND m.conversation_id IN (${ph})
    AND m.id IN (
      SELECT m2.id FROM messages m2
      WHERE m2.conversation_id = m.conversation_id AND m2.is_streaming = 0
      ORDER BY m2.timestamp DESC LIMIT ?
    )
  ORDER BY m.conversation_id, m.timestamp ASC`

try {
  const corr = time('C 相关子查询', () => db.prepare(SQL_CORR).all(...ids, LIMIT))
  const corrSame = JSON.stringify([...previewsFrom(corr.out)]) === JSON.stringify([...expected])
  console.log(`${corr.label.padEnd(34)} ${f(corr.ms).padStart(7)}ms  行 ${corr.out.length}  语义一致=${corrSame}`)
} catch (e) {
  console.log(`C 相关子查询                          失败: ${e.message}`)
}

// ── 变体 D：SQL 里直接提取预览文本（JSON1），只传回文本 ────────────────────
// 复刻 extractPreviewText 的三条分支：
//   parts 数组 → 取 type='text' 的 text，逐个 trim、丢空、' ' 连接、整体 trim
//   否则 → text / content 字段（trim）
const SQL_JSON = `
  WITH ranked AS (
    SELECT id, conversation_id, role, timestamp,
           ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY timestamp DESC) AS rn
    FROM messages WHERE conversation_id IN (${ph}) AND is_streaming = 0
  ),
  picked AS (SELECT * FROM ranked WHERE rn <= ?)
  SELECT p.conversation_id, p.role, p.timestamp,
    CASE
      WHEN json_valid(m.content_json) AND json_type(m.content_json, '$.parts') = 'array' THEN
        trim(COALESCE((
          SELECT group_concat(trim(json_extract(je.value, '$.text')), ' ' ORDER BY je.key)
          FROM json_each(m.content_json, '$.parts') je
          WHERE json_extract(je.value, '$.type') = 'text'
            AND json_type(je.value, '$.text') = 'text'
            AND trim(json_extract(je.value, '$.text')) <> ''
        ), ''))
      WHEN json_valid(m.content_json) AND json_type(m.content_json, '$.text') = 'text' THEN
        trim(json_extract(m.content_json, '$.text'))
      WHEN json_valid(m.content_json) AND json_type(m.content_json, '$.content') = 'text' THEN
        trim(json_extract(m.content_json, '$.content'))
      ELSE ''
    END AS preview_text
  FROM picked p JOIN messages m ON m.id = p.id
  ORDER BY p.conversation_id, p.timestamp ASC`

try {
  const js = time('D SQL 提取预览文本（JSON1）', () => db.prepare(SQL_JSON).all(...ids, LIMIT))
  const payload = js.out.reduce((a, r) => a + (r.preview_text?.length ?? 0), 0)
  // 语义校验：用 SQL 提取的文本直接跑 resolveLastMessagePreview 的挑选逻辑
  const m2 = new Map()
  for (const r of js.out) {
    const l = m2.get(r.conversation_id)
    if (l) l.push(r)
    else m2.set(r.conversation_id, [r])
  }
  const sqlSide = new Map()
  for (const c of convs) {
    const list = m2.get(c.id) ?? []
    let userFallback = ''
    let found = ''
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const t = list[i].preview_text
      if (!t) continue
      if (list[i].role === 'assistant') { found = t; break }
      if (list[i].role === 'user' && !userFallback) userFallback = t
    }
    sqlSide.set(c.id, found || userFallback)
  }
  let diff = 0
  const samples = []
  for (const [k, v] of expected) {
    if (sqlSide.get(k) !== v) {
      diff++
      if (samples.length < 3) samples.push({ id: k.slice(0, 20), js: v.slice(0, 70), sql: (sqlSide.get(k) ?? '').slice(0, 70) })
    }
  }
  console.log(`${js.label.padEnd(34)} ${f(js.ms).padStart(7)}ms  行 ${js.out.length}  载荷 ${(payload / 1024).toFixed(0)}KB  语义差异 ${diff}/${convs.length}`)
  for (const s of samples) console.log(`     JS=${JSON.stringify(s.js)}\n     SQL=${JSON.stringify(s.sql)}`)
} catch (e) {
  console.log(`D SQL 提取预览文本                    失败: ${e.message}`)
}

// ── 变体 E：D 但不 JOIN（ranked 里直接带 content_json 做子查询）────────────
// 用于区分「窗口函数成本」与「JOIN 成本」
const SQL_JSON_NOJOIN = SQL_JSON.replace(
  /WITH ranked AS \(\s*SELECT id, conversation_id, role, timestamp,/,
  'WITH ranked AS (\n    SELECT id, conversation_id, role, content_json, timestamp,',
).replace('FROM picked p JOIN messages m ON m.id = p.id', 'FROM picked p JOIN messages m ON m.id = p.id')
try {
  const t = time('E = D（保留原样，仅复核）', () => db.prepare(SQL_JSON).all(...ids, LIMIT))
  console.log(`${t.label.padEnd(34)} ${f(t.ms).padStart(7)}ms`)
} catch { /* ignore */ }

console.log('\n=== 对照：不带窗口函数，纯 JSON 提取全部行（上限参考）===')
try {
  const t = time(
    'JSON 提取（无窗口函数、全量）',
    () =>
      db
        .prepare(
          `SELECT conversation_id, trim(COALESCE((
             SELECT group_concat(trim(json_extract(je.value,'$.text')),' ')
             FROM json_each(messages.content_json,'$.parts') je
             WHERE json_extract(je.value,'$.type')='text' AND trim(json_extract(je.value,'$.text'))<>''
           ),'')) t FROM messages WHERE is_streaming=0`,
        )
        .all(),
    2,
  )
  console.log(`${t.label.padEnd(34)} ${f(t.ms).padStart(7)}ms  行 ${t.out.length}`)
} catch (e) {
  console.log('失败:', e.message)
}
