#!/usr/bin/env node
/**
 * 宫殿对照集 v4 —— **扩容**：从真实用户提问里批量取题，自动锚定 gold
 *
 * ## 为什么要扩容
 *
 * v1 集子只有 8 条，**一条翻转 = ±12.5pp**，撑不起「提高了多少」这种量级结论。
 * 需要至少 30 条（一条 ≈ ±3.3pp）才有资格谈百分点。
 *
 * ## 取法与它的边界（必须如实写在结果里）
 *
 * 从 `messages` 里取**用户真实发过的提问**（排除探针/定时/进化会话），按
 * 「这个提问之后那次会话的归档抽屉」作为 gold 候选。这不是完美的 recall 标注
 * ——用户提问的会话 ≠ 归档抽屉一一对应——但比"我挑一条再编个查询"的**挑样偏差小**：
 * 提问是用户自己说的，措辞错配是天然的。
 *
 * ## 输出的用法
 *
 * 脚本只**收集**，不判定。产出的候选要人工过一遍：删掉 gold 不在宫殿的、
 * 提问过短的、以及"其实在问当前会话"的。人工那步不可省——这正是 v1 集子
 * 号称"客观"却仍有挑样偏差的地方。
 *
 * 用法：node scripts/mine-palace-eval-v4.mjs [--limit 4000] [--out <path>]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const argv = process.argv.slice(2)
const LIMIT = argv.includes('--limit') ? Number(argv[argv.indexOf('--limit') + 1]) : 4000
const OUT = argv.includes('--out')
  ? argv[argv.indexOf('--out') + 1]
  : 'docs/test/memory-eval/palace-eval-candidates-v4.json'

const db = new DatabaseSync(path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db'))

// 回忆式 / 追问式提问：这类查询的 gold 是**客观的**——问题本身就指了它在问哪段过去
const RECALL =
  /之前|上次|上回|刚才|还记得|记得|聊过|说过|结论是什么|是什么来着|回顾一下|那次|当时|那个问题|怎么解决|怎么处理/

const SQL = `SELECT conversation_id, content_json, timestamp
               FROM messages
              WHERE role = 'user'
                AND conversation_id NOT LIKE 'probe-%'
                AND conversation_id NOT LIKE 'cron:%'
                AND conversation_id NOT LIKE 'evolution:%'
                AND conversation_id NOT LIKE 'autonomous%'
              ORDER BY timestamp DESC
              LIMIT ?`

const rows = db.prepare(SQL).all(LIMIT)

/** 宫殿里全部抽屉，供 gold 锚定 */
const drawers = db
  .prepare('SELECT drawer_id, content FROM palace_drawers WHERE deleted_at IS NULL')
  .all()

function extractText(contentJson) {
  try {
    const o = JSON.parse(contentJson)
    if (typeof o.text === 'string') return o.text
    // 用户消息实测两种形状：{type:'text',text} 与 {parts:[...]}
    if (Array.isArray(o.parts)) {
      return o.parts
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n')
    }
  } catch {
    /* 形状异常就当没这条 */
  }
  return ''
}

const seen = new Set()
const candidates = []
for (const r of rows) {
  const text = extractText(r.content_json).trim()
  if (!text || text.length < 8 || text.length > 150) continue
  if (!RECALL.test(text)) continue
  // 去重：同一句话问多次只留一条
  const key = text.slice(0, 40)
  if (seen.has(key)) continue
  seen.add(key)

  // gold 锚定：这条提问所在的会话，其归档抽屉在不在宫殿里？
  // 宫殿 drawer 的来源会话记在 content 里（`user: ...` / `assistant: ...`），
  // 但更可靠的锚是**内容子串**——取提问里最长的连续 CJK 串去宫殿里找。
  const segs = text.match(/[㐀-䶿一-鿿]{3,}/g) ?? []
  const anchored = []
  for (const d of drawers) {
    for (const s of segs) {
      if (s.length >= 4 && d.content.includes(s)) {
        anchored.push({ drawerId: d.drawer_id, via: s.slice(0, 12) })
        break
      }
    }
  }
  candidates.push({
    query: text,
    fromConversation: r.conversation_id,
    at: r.timestamp,
    anchoredDrawers: anchored.length,
    /** 锚定用的抽屉 + 命中的那个串；人工筛的时候能一眼看出锚得对不对 */
    anchors: anchored.slice(0, 3),
  })
}

const strong = candidates.filter((c) => c.anchoredDrawers > 0)
console.log(`扫描 ${rows.length} 条用户消息`)
console.log(`回忆式候选 ${candidates.length} 条，其中能锚定到宫殿抽屉的 ${strong.length} 条\n`)
for (const c of strong.slice(0, 40)) {
  console.log(`  [${c.anchoredDrawers}条] ${c.query.replace(/\n/g, ' ').slice(0, 70)}`)
  for (const a of c.anchors) console.log(`        ↳ ${a.drawerId.slice(0, 8)} via「${a.via}」`)
}

fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), candidates }, null, 2), 'utf-8')
console.log(`\n全量候选（含未锚定）→ ${OUT}`)
db.close()
