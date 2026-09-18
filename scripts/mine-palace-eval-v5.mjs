#!/usr/bin/env node
/**
 * 宫殿对照集 v5 —— **规模 + 客观性**兼顾的取法
 *
 * ## v1~v4 的教训
 *
 * | 版本 | 取法 | 问题 |
 * |---|---|---|
 * | v1 | 我挑 gold、我编查询 | 挑样偏差（我倾向挑措辞差得明显的） |
 * | v3 | 挖真实回忆式提问 | 数据量不够（全会话只有 1008 条用户消息），只挖出 5 条 |
 * | v4 | 同上 + 自动锚定 | 同上；且锚定命中的多是引用的文件路径，不是真 gold |
 *
 * 根因：**本机真实的"回忆式检索"样本量天然就不足以支撑百分点级结论**。
 * 硬凑只能是编造。
 *
 * ## v5 的取法：自动构造 + 关键词重叠过滤（客观、可复现、可扩到任意规模）
 *
 * 对每条**长文抽屉**（content ≥ N 字，默认 1200）：
 * 1. 取它的**会话主题做查询**——但不用开头那句（开头往往是指令，如"清理临时文件"，
 *    与抽屉主体内容无关），而是取**抽屉内容里信息密度最高的那句话**当"用户会怎么问"。
 * 2. gold = 这个抽屉本身。
 *
 * ### 位置偏差的处理（v5 最重要的设计）
 *
 * 向量语料是 `content.slice(0, 300)`。若查询直接取自**开头 300 字内**，
 * gold 在自己的向量里必然"贴近自己"，向量会高估。故 v5：
 * - 查询**取自 300 字之后**（`--minOffset`，默认 400）
 * - 额外跑一档 `head300` 作为**位置偏差的量化**——两档之差就是"开头截断"造成的损失
 *
 * ### 关键词重叠过滤（防止送分题）
 *
 * 查询与 gold 的 bigram 交集若过大，FTS 必中，测不出向量价值。故记录
 * `overlap`（|query∩gold| / |query|），跑分时按档位分层统计——
 * **低重叠档才是向量该起作用的地方**。分层是分析手段，不是筛选（不删题，避免另一种偏差）。
 *
 * 用法：node scripts/mine-palace-eval-v5.mjs [--minChars 1200] [--minOffset 400] [--max 60]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const argv = process.argv.slice(2)
const arg = (k, d) => (argv.includes(k) ? Number(argv[argv.indexOf(k) + 1]) : d)
const MIN_CHARS = arg('--minChars', 1200)
const MIN_OFFSET = arg('--minOffset', 400)
const MAX = arg('--max', 60)
const OUT = argv.includes('--out')
  ? argv[argv.indexOf('--out') + 1]
  : 'docs/test/memory-eval/palace-eval-set-v5.json'

// ── 与生产同口径的分词（内联自 segmentation.ts，值一致）──
const CJK_RE = /[㐀-䶿一-鿿]/
const TOKEN_SEG_RE = /[㐀-䶿一-鿿]+|[a-z0-9]+/g
function tokenizeBigram(text) {
  const tokens = new Set()
  if (!text) return tokens
  const m = text.toLowerCase().match(TOKEN_SEG_RE)
  if (!m) return tokens
  for (const seg of m) {
    if (CJK_RE.test(seg[0])) {
      if (seg.length === 1) tokens.add(seg)
      else for (let i = 0; i < seg.length - 1; i++) tokens.add(seg.slice(i, i + 2))
    } else tokens.add(seg)
  }
  return tokens
}

const db = new DatabaseSync(path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db'))
const drawers = db
  .prepare(
    `SELECT drawer_id AS id, content, char_count AS n, conversation_id AS conv
       FROM palace_drawers WHERE deleted_at IS NULL AND char_count >= ?`,
  )
  .all(MIN_CHARS)
console.log(`长文抽屉（≥${MIN_CHARS} 字）: ${drawers.length} 条`)

/** 通用词：不出现在"用户会怎么问"里 */
const GENERIC = new Set([
  '我们', '这个', '那个', '可以', '需要', '现在', '已经', '如果', '就是', '还是',
  '因为', '所以', '但是', '然后', '一个', '一下', '什么', '怎么', '这里', '这些',
  '那些', '或者', '以及', '并且', '没有', '不是', '他们', '你们', '自己',
])

/**
 * 从抽屉里挑"最能代表它在讲什么"的句子当查询。
 *
 * 取法：**跳过开头 MIN_OFFSET 字**（避开与向量语料重叠的位置偏差），
 * 在之后的文本里找**信息密度最高**的一句——判据是「含较多非通用 bigram」，
 * 且长度落在"用户一句话"的区间（20~60 字）。
 *
 * **如实记录的局限**：这样构造的查询**不是真人写的**，它是"从 gold 里摘一句"。
 * 它与真实查询的差距是：真人不会用 gold 里的原词。所以这里同时记录
 * `overlap` 并在跑分时**按重叠分层**——高重叠档的结果不能外推给真实场景。
 */
function pickQuery(content) {
  const tail = content.slice(MIN_OFFSET)
  // 按句切：中英文句读。**换行必须先切**——否则 `[^\n]` 之外的片段会把
  // "assistant: …" 这类角色前缀切进句子中段（实测产出过 `dClosed\` 捞段` 这种残句）。
  const sentences = tail
    .split(/[。！？!?\n]/)
    .map((s) => s.trim().replace(/^(user|assistant)\s*[:：]\s*/, ''))
    .filter((s) => s.length >= 20 && s.length <= 60)
  if (!sentences.length) return null

  let best = null
  let bestScore = -1
  for (const clean of sentences) {
    // 残句滤除：含 markdown 表格/行内代码残留的段落不是"用户会怎么问"
    if (/[|`]/.test(clean)) continue
    // 必须像一句自然的问句/陈述：不能以标点或半个单词开头
    if (!/^[㐀-䶿一-鿿a-zA-Z0-9]/.test(clean)) continue
    const toks = [...tokenizeBigram(clean)]
    if (toks.length < 8) continue
    // 信息密度：非通用 token 的比例
    const informative = toks.filter((t) => !GENERIC.has(t) && t.length >= 2).length
    const score = informative / toks.length
    if (score > bestScore) {
      bestScore = score
      best = clean
    }
  }
  return best ? { query: best, density: bestScore } : null
}

/** 查询与 gold 的 bigram 重叠率（|交集| / |查询 token|）——分层用 */
function overlapOf(query, content) {
  const q = tokenizeBigram(query)
  const d = tokenizeBigram(content)
  if (!q.size) return 0
  let inter = 0
  for (const t of q) if (d.has(t)) inter++
  return inter / q.size
}

const set = []
for (const d of drawers) {
  const picked = pickQuery(d.content)
  if (!picked) continue
  // 排除：查询本身出现在开头 300 字里（位置偏差，见文件头）
  const head300 = d.content.slice(0, 300)
  if (head300.includes(picked.query)) continue

  set.push({
    id: `v5-${d.id.slice(0, 8)}`,
    query: picked.query,
    gold: d.id,
    /** gold 字面量（跑分脚本用它判命中；取抽屉里查询那段的原文，保证可校验） */
    expect: [picked.query],
    overlap: Number(overlapOf(picked.query, d.content).toFixed(3)),
    goldChars: d.n,
    density: Number(picked.density.toFixed(3)),
    conversation: d.conv,
  })
}

// 按重叠升序取前 MAX 条——**低重叠档优先**，那才是向量该起作用的地方。
// 但**不删高重叠的**：全量写进文件，脚本只跑前 MAX，便于复核时扩样。
set.sort((a, b) => a.overlap - b.overlap)
const chosen = set.slice(0, MAX)

const buckets = { '0.00-0.40': 0, '0.40-0.60': 0, '0.60-0.80': 0, '0.80-1.00': 0 }
for (const s of set) {
  if (s.overlap < 0.4) buckets['0.00-0.40']++
  else if (s.overlap < 0.6) buckets['0.40-0.60']++
  else if (s.overlap < 0.8) buckets['0.60-0.80']++
  else buckets['0.80-1.00']++
}
console.log(`可构造查询 ${set.length} 条，重叠分层：`)
for (const [k, v] of Object.entries(buckets)) console.log(`  ${k}: ${v}`)
console.log(`\n取前 ${chosen.length} 条（低重叠优先）：`)
for (const s of chosen.slice(0, 15)) {
  console.log(`  [重叠${s.overlap} 密度${s.density}] ${s.query.slice(0, 56)}`)
}

fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      _comment:
        'v5 自动构造集。查询取自 gold 抽屉 400 字之后的句子（避开向量语料前 300 字的位置偏差）。' +
        'overlap = 查询与 gold 的 bigram 覆盖率，用于**分层统计**——高重叠档 FTS 必中，不代表真实场景。',
      generatedAt: new Date().toISOString(),
      params: { MIN_CHARS, MIN_OFFSET, MAX },
      buckets,
      all: set,
      queries: chosen,
    },
    null,
    2,
  ),
  'utf-8',
)
console.log(`\n→ ${OUT}（all=${set.length}, queries=${chosen.length}）`)
db.close()
