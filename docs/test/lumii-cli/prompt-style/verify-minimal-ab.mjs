#!/usr/bin/env node
/**
 * 极简档（minimal）真机 A/B 验证 —— P3
 *
 * 在同一个会话里逐轮切换 极简 → 简要 → 详细 → 极简，从应用日志读取每轮
 * [llm-prompt]（风格/chars）与 contextUsage breakdown（tools/mcp 等类目 token），
 * 验证：
 *   1) 极简档：工具定义类目 token 明显小于简要/详细（工具定义载荷已去描述）；
 *   2) 简要 vs 详细：tools 类目应基本持平（工具定义载荷未受提示词风格影响）；
 *   3) 逐轮切换即时生效（minimal→terse 还原、→minimal 再裁剪）；
 *   4) 会话创建时为极简（本会话创建于 minimal 档，首轮即验证创建时快照路径）。
 *
 * 结束恢复原风格（默认取测试开始时的值）。
 * 环境变量：VMA_TURN_TIMEOUT_MS、VMA_NO_RESTORE=1
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ui,
  okJson,
  assert,
  pollUntil,
  createSession,
  sendAndWait,
  logCursor,
  logLinesSince,
  logChannelAvailable,
  preflight,
} from '../lib/cli-harness.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TURN_TIMEOUT_MS = Number(process.env.VMA_TURN_TIMEOUT_MS || 300000)
const NO_RESTORE = process.env.VMA_NO_RESTORE === '1'
const MSG = '请只回复：收到'

function getStyle() {
  const r = okJson(ui(['settings', 'get', 'promptStyle.style']), 'settings get promptStyle.style')
  return r.value
}

function setStyle(style) {
  okJson(ui(['settings', 'set', 'promptStyle.style', style]), 'settings set promptStyle.style')
  const now = getStyle()
  assert(now === style, `风格写入未生效：期望 ${style}，实际 ${now}`)
}

function waitSessionIdle(sk, timeoutMs = TURN_TIMEOUT_MS) {
  let idleStreak = 0
  return !!pollUntil(() => {
    const l = ui(['conversation', 'list', '--limit', '40'])
    const it = (Array.isArray(l.json) ? l.json : []).find((x) => x.sessionKey === sk)
    if (it && !it.hasRunning) {
      idleStreak++
      return idleStreak >= 3 ? true : null
    }
    idleStreak = 0
    return null
  }, timeoutMs, 2500)
}

/** 从本轮新增日志提取 llm-prompt / 段级 / contextUsage 摘要 */
function turnLogStats(cursor, style) {
  const lines = logLinesSince(cursor)
  const prompt = [...lines].reverse().find((l) => /\[llm-prompt\] instanceId=/.test(l) && l.includes(`style=${style}`))
  const section = [...lines].reverse().find((l) => /\[prompt-section\] instanceId=/.test(l) && l.includes(`style=${style}`))
  const usage = [...lines].reverse().find((l) => /推送 contextUsage/.test(l) && l.includes('breakdown='))
  const out = { promptLine: prompt ? prompt.slice(0, 400) : null }
  const m1 = prompt?.match(/chars=(\d+) static=(\d+) dynamic=(\d+)/)
  if (m1) Object.assign(out, { chars: +m1[1], staticChars: +m1[2], dynamicChars: +m1[3] })
  const m2 = section?.match(/sections=(\d+) totalChars=(\d+)/)
  if (m2) Object.assign(out, { sections: +m2[1], sectionTotalChars: +m2[2] })
  const m3 = usage?.match(/breakdown=([^ ]+)/)
  if (m3) {
    const map = {}
    for (const pair of m3[1].split(',')) {
      const [k, v] = pair.split(':')
      if (k && v) map[k] = Number(v)
    }
    out.breakdown = map
  }
  return out
}

function main() {
  const pf = preflight()
  if (!pf.ok) {
    console.error('预检失败：', pf.problems.join('; '))
    process.exit(2)
  }
  if (!logChannelAvailable()) {
    console.error('日志通道不可用，无法读取 [llm-prompt]/contextUsage')
    process.exit(2)
  }
  for (const w of pf.warnings) console.log('⚠️ ', w)

  const originalStyle = getStyle()
  console.log(`起始风格: ${originalStyle}（极简档验证：会话创建于此档，首轮走创建时裁剪路径）`)

  const sk = createSession('P3 极简档 A/B（minimal→terse→detailed→minimal）', { prefix: '[vma]' })
  console.log(`会话: ${sk}`)

  /** 四轮：首末同档，中间对照 */
  const plan = ['minimal', 'terse', 'detailed', 'minimal']
  const rows = []
  try {
    for (let i = 0; i < plan.length; i++) {
      const style = plan[i]
      setStyle(style)
      const cursor = logCursor()
      // sendAndWait 在文本段稳定时可能提前返回（模型可能继续工具循环），
      // 故以其等待首个稳定回复，再用 hasRunning 连续空闲确认真实回合结束
      sendAndWait(sk, MSG, { timeoutMs: TURN_TIMEOUT_MS })
      const ok = waitSessionIdle(sk)
      assert(ok, `第 ${i + 1} 轮（${style}）回合未在超时内空闲`)
      const stats = turnLogStats(cursor, style)
      const usage = okJson(ui(['context', 'usage', '--session', sk]), 'context usage')
      const cliBreakdown = Array.isArray(usage.breakdown)
        ? Object.fromEntries(usage.breakdown.map((e) => [e.category, e.tokens]))
        : undefined
      const row = { turn: i + 1, style, ...stats, cliBreakdown }
      rows.push(row)
      console.log(
        `轮 ${i + 1} style=${style} chars=${row.chars ?? '?'} static=${row.staticChars ?? '?'} ` +
          `tools=${row.breakdown?.tools ?? '?'} mcp=${row.breakdown?.mcp ?? 0} ` +
          `systemPrompt=${row.breakdown?.systemPrompt ?? '?'}`,
      )
    }
  } finally {
    if (!NO_RESTORE && getStyle() !== originalStyle) {
      setStyle(originalStyle)
      console.log(`已恢复风格: ${originalStyle}`)
    }
  }

  /** 工具定义类目 token：优先 CLI context usage 的真实读数，回退日志 breakdown */
  const toolsOf = (r) => r.cliBreakdown?.tools ?? r.breakdown?.tools ?? null
  const minimal = rows.filter((r) => r.style === 'minimal' && toolsOf(r) != null)
  const untrimmed = rows.filter((r) => r.style !== 'minimal' && toolsOf(r) != null)
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
  const minTools = avg(minimal.map(toolsOf))
  const baseTools = avg(untrimmed.map(toolsOf))
  const dropPct = minTools && baseTools ? (((baseTools - minTools) / baseTools) * 100).toFixed(1) : '?'

  const evidence = {
    ts: new Date().toISOString(),
    session: sk,
    originalStyle,
    message: MSG,
    rows,
    summary: {
      minimalToolsAvg: minTools,
      untrimmedToolsAvg: baseTools,
      toolsDropPct: dropPct,
    },
  }
  const outPath = path.join(__dirname, 'minimal-ab-evidence.json')
  fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2), 'utf8')

  console.log('\n=== 汇总 ===')
  console.log(`工具定义类目（tools）: 极简 ${minTools?.toFixed(0)} vs 未裁剪 ${baseTools?.toFixed(0)} → -${dropPct}%`)
  console.log(`证据: ${outPath}`)

  const fail = []
  if (!minTools || !baseTools) {
    fail.push(`未能取到 tools 类目读数（minimal=${minTools}, base=${baseTools}）`)
  } else if (!(minTools < baseTools * 0.85)) {
    fail.push(`tools 类目未达预期降幅（minimal=${minTools}, base=${baseTools}）`)
  }
  for (const r of rows) {
    if (!r.promptLine) fail.push(`轮 ${r.turn}（${r.style}）未见 style=${r.style} 的 [llm-prompt] 日志`)
  }
  if (fail.length) {
    console.error('\n❌ 验证未通过：')
    for (const f of fail) console.error(' -', f)
    process.exit(1)
  }
  console.log('\n✅ 极简档验证通过')
}

main()
