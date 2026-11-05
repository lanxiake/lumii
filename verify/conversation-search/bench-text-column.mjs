/**
 * 候选优化实测：把 content_json 预处理成「纯文本」列，扫描量能降多少。
 *
 * 动因（2026-11-05）：用户输入搜索关键字就卡。实测在 10117 行 / 160M 字符上：
 *   - LIKE 扫 content_json：170–430ms
 *   - 连带把 60 行命中整段搬进 JS：最高 1.2s（大行单体 1MB）
 *   - 以上两条在主进程**同步**跑，且会话级与逐条各跑一次
 *
 * 这里量的是「只扫可见正文」能省多少：thinking / 工具结果 / JSON 结构都不参与搜索，
 * 但它们占了 content_json 的绝大部分。
 *
 * 用法：node verify/conversation-search/bench-text-column.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const srcPath = path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db')
const tmp = path.join(os.tmpdir(), 'lumii-textcol-bench.db')
fs.rmSync(tmp, { force: true })

/** 与 message-content-json.ts 的 extractMessageText 同语义（只取可见正文） */
function visibleText(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return ''
  }
  if (!parsed || typeof parsed !== 'object') return ''
  if (parsed.type === 'text') return String(parsed.text ?? '').trim()
  if (parsed.type === 'assistant_parts') {
    return (parsed.parts ?? [])
      .filter((p) => p && p.type === 'text')
      .map((p) => String(p.text ?? '').trim())
      .filter(Boolean)
      .join('\n')
      .trim()
  }
  return ''
}

const src = new DatabaseSync(srcPath, { readOnly: true })
const dst = new DatabaseSync(tmp)
dst.exec('CREATE TABLE m(id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, timestamp TEXT, text TEXT)')

const rows = src.prepare('SELECT id, conversation_id, role, timestamp, content_json FROM messages').all()
let t = Date.now()
dst.exec('BEGIN')
const ins = dst.prepare('INSERT INTO m VALUES (?, ?, ?, ?, ?)')
let rawChars = 0
let textChars = 0
for (const r of rows) {
  const text = visibleText(r.content_json).replace(/\s+/g, ' ')
  rawChars += r.content_json.length
  textChars += text.length
  ins.run(r.id, r.conversation_id, r.role, r.timestamp, text)
}
dst.exec('COMMIT')
console.log(`导入 ${rows.length} 行：${Date.now() - t}ms`)
console.log(
  `正文字符：${(rawChars / 1e6).toFixed(1)}M → ${(textChars / 1e6).toFixed(1)}M`,
  `（压缩到 ${((textChars / rawChars) * 100).toFixed(1)}%）`,
)
console.log(`临时库体积：${(fs.statSync(tmp).size / 1024 / 1024).toFixed(0)}MB`)

const idsOnly = dst.prepare(
  `SELECT id FROM m WHERE text LIKE ? ESCAPE '\\' ORDER BY timestamp DESC LIMIT 60`,
)
const withText = dst.prepare(
  `SELECT id, conversation_id, role, timestamp, text FROM m
    WHERE text LIKE ? ESCAPE '\\' ORDER BY timestamp DESC LIMIT 60`,
)

function bench(label, fn, n = 7) {
  const times = []
  let hits = 0
  for (let i = 0; i < n; i++) {
    const s = process.hrtime.bigint()
    hits = fn().length
    times.push(Number(process.hrtime.bigint() - s) / 1e6)
  }
  times.sort((a, b) => a - b)
  console.log(
    label.padEnd(34),
    `med ${times[Math.floor(n / 2)].toFixed(1)}ms`.padEnd(14),
    `(前 60 条命中 ${hits})`,
  )
}

for (const kw of ['微信', 'B站', '精灵图', 'xzqw', '一']) {
  const pattern = `%${kw}%`
  console.log(`关键词「${kw}」`)
  bench('  只取 id', () => idsOnly.all(pattern))
  bench('  取 id + 正文本体', () => withText.all(pattern))
}
