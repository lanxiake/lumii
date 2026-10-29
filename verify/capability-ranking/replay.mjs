#!/usr/bin/env node
/**
 * 能力面排序策略 · 历史回放评测
 *
 * 用真实聊天记录（messages 表里含工具调用的 assistant 消息）按时间切分回放，
 * 比较不同"常驻前 N"策略的 Recall。**严格只用该时刻之前的信息**，无泄漏。
 *
 * 设计依据：docs/design/能力面治理/2026-10-29-能力面治理与流水线生命周期设计.md §5.6
 *
 * 用法：
 *   node verify/capability-ranking/replay.mjs            # 默认表格
 *   node verify/capability-ranking/replay.mjs --by-agent # 分组对比
 *   node verify/capability-ranking/replay.mjs --global   # 全局作用域对照
 *   node verify/capability-ranking/replay.mjs --curve    # 扫 N 曲线
 *
 * 为什么是 .mjs 而不是 .test.ts：它是**评测工具**不是测试，人在改算法时反复跑；
 * 且要读本机运行时库（测试环境里没有）。
 */
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'

const DB = path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db')
const byAgent = process.argv.includes('--by-agent')
const scope = process.argv.includes('--global') ? 'global' : 'agent'

function loadEvents() {
  const db = new DatabaseSync(DB, { readOnly: true })
  const rows = db
    .prepare(
      "SELECT conversation_id, timestamp, content_json FROM messages " +
        "WHERE content_json LIKE '%\"type\":\"tool\"%' ORDER BY timestamp ASC",
    )
    .all()
  db.close()
  const evts = []
  for (const r of rows) {
    let o
    try {
      o = JSON.parse(r.content_json)
    } catch {
      continue
    }
    const tools = (o.parts || []).filter((p) => p.type === 'tool').map((p) => p.name)
    if (tools.length) {
      evts.push({ t: Date.parse(r.timestamp), conv: r.conversation_id, tools: [...new Set(tools)] })
    }
  }
  return evts
}

const agentOf = (c) =>
  c.startsWith('cron:') ? 'cron'
  : c.startsWith('pcwechat:') ? 'pcwechat'
  : c.startsWith('weixin:') ? 'weixin'
  : c.startsWith('feishu:') ? 'feishu'
  : c.startsWith('evolution:') ? 'evolution'
  : 'local'

const L = Math.log
const rec7 = ({ arr, now }) => {
  const last = arr.at(-1) || 0
  return last ? Math.pow(0.5, (now - last) / 864e5 / 7) : 0
}
const freq = ({ arr, now }) => {
  let c = 0
  for (let i = arr.length - 1; i >= 0; i--) {
    if (now - arr[i] <= 30 * 864e5) c++
    else break
  }
  return c
}

/** 每策略一条曲线：返回 {N: recall%} */
function evalStrategy(evts, scorer, Ns) {
  const acc = Object.fromEntries(Ns.map((n) => [n, 0]))
  const hist = new Map() // agent -> Map(tool -> [ts])
  let sess = new Set()
  let prevConv = null
  for (const e of evts) {
    if (e.conv !== prevConv) {
      sess = new Set()
      prevConv = e.conv
    }
    const ag = scope === 'global' ? '_' : agentOf(e.conv)
    const m = hist.get(ag) || new Map()
    const ranked = [...m.entries()]
      .map(([tool, arr]) => ({ tool, v: scorer({ arr, now: e.t, sess: sess.has(tool) }) }))
      .sort((a, b) => b.v - a.v)
      .map((x) => x.tool)
    for (const N of Ns) {
      const set = new Set(ranked.slice(0, N))
      acc[N] += e.tools.filter((t) => set.has(t)).length / e.tools.length
    }
    for (const t of e.tools) {
      const arr = m.get(t) || []
      arr.push(e.t)
      m.set(t, arr)
      sess.add(t)
    }
    hist.set(ag, m)
  }
  return Object.fromEntries(Ns.map((n) => [n, (acc[n] / evts.length) * 100]))
}

const STRATEGIES = [
  ['纯近期（LRU）', rec7],
  ['纯累计次数', ({ arr }) => arr.length],
  ['30天次数', ({ arr, now }) => freq({ arr, now })],
  ['30天对数', ({ arr, now }) => L(1 + freq({ arr, now }))],
  ['频率+近期', ({ arr, now }) => 0.5 * L(1 + freq({ arr, now })) + 0.3 * rec7({ arr, now })],
  [
    '六项公式(初稿)',
    ({ arr, now, sess }) =>
      0.5 * L(1 + freq({ arr, now })) +
      0.3 * rec7({ arr, now }) +
      (sess ? 0.4 : 0),
  ],
]

const Ns = process.argv.includes('--curve') ? [10,15,20,25,30] : [10, 20, 30]
const evts = loadEvents()
console.log(`事件数 ${evts.length}，不同工具 ${new Set(evts.flatMap((e) => e.tools)).size}，窗口 256K\n`)

console.log('策略'.padEnd(20) + Ns.map((n) => `N=${n}`.padStart(9)).join(''))
console.log('-'.repeat(20 + Ns.length * 9))
for (const [name, sc] of STRATEGIES) {
  const r = evalStrategy(evts, sc, Ns)
  console.log(name.padEnd(20) + Ns.map((n) => (r[n].toFixed(1) + '%').padStart(9)).join(''))
}

if (byAgent) {
  console.log('\n=== 按渠道分组：组内 LRU vs 全局热度（N=20）===')
  const groups = {}
  for (const e of evts) (groups[agentOf(e.conv)] ??= []).push(e)
  console.log('分组'.padEnd(12) + '事件'.padStart(8) + '组内 LRU'.padStart(12) + '全局 LRU'.padStart(12))
  const globalOrder = []
  for (const e of evts) {
    for (const t of e.tools) {
      const i = globalOrder.indexOf(t)
      if (i >= 0) globalOrder.splice(i, 1)
      globalOrder.unshift(t)
    }
  }
  for (const [k, v] of Object.entries(groups)) {
    const inner = evalStrategy(v, rec7, [20])[20]
    let h = 0
    for (const e of v) {
      const set = new Set(globalOrder.slice(0, 20))
      h += e.tools.filter((t) => set.has(t)).length / e.tools.length
    }
    console.log(
      k.padEnd(12) + String(v.length).padStart(8) + (inner.toFixed(1) + '%').padStart(12) + ((h / v.length) * 100).toFixed(1).padStart(11) + '%',
    )
  }
}
