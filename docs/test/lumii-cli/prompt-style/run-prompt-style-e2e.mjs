#!/usr/bin/env node
/**
 * 提示词风格实验（PS）CLI 场景化验收执行器 —— P1-T5
 *
 * 驱动真实客户端（lumii-ui CLI + 真实 LLM）：同一批真实用户任务分别在
 * detailed / terse 两档执行，断言提示词转储形态（[llm-prompt] 日志），
 * 并汇总两档对照指标（完成 / 引导命中 / 提示词体量 / 回合耗时）。
 *
 * 用例文档：prompt-style-test-cases.md；规范：../CLI-TEST-SPEC.md
 * 环境变量：PS_ONLY=<用例ID前缀>、PS_NO_RESTORE=1、PS_TURN_TIMEOUT_MS=240000
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
  dbQuery,
  dbExec,
  logCursor,
  logLinesSince,
  logChannelAvailable,
  createEvidence,
  runCase,
  preflight,
  DATA_ROOT,
} from '../lib/cli-harness.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SESSION_PREFIX = '[ps-suite]'
const TURN_TIMEOUT_MS = Number(process.env.PS_TURN_TIMEOUT_MS || 240000)
const NO_RESTORE = process.env.PS_NO_RESTORE === '1'
const ONLY = process.env.PS_ONLY || ''
const CRON_PROBE_PHRASE = '给物业打电话确认快递'

/** 工作区 outputs 的真实路径：优先取设置里配置的 workspace.directory（用户可自定义） */
function resolveWorkspaceOutputs() {
  try {
    const r = okJson(ui(['settings', 'get', 'workspace.directory']), 'settings get workspace.directory')
    const dir = typeof r.value === 'string' && r.value.trim() ? r.value.trim() : null
    if (dir) return path.join(dir, 'outputs')
  } catch {
    /* 回退默认 */
  }
  return path.join(DATA_ROOT, 'workspace', 'outputs')
}

const ev = createEvidence(__dirname, 'prompt-style-suite', '提示词风格实验（PS）CLI 场景化验收')
const fails = { count: 0 }
/** 双档对照指标：{ case, style, chars, elapsedMs, guideHit, note } */
const metrics = []

function maybe(id, fn) {
  if (ONLY && !id.startsWith(ONLY)) {
    ev.record(id, 'SKIP', `PS_ONLY=${ONLY} 过滤跳过`)
    return true
  }
  return runCase(ev, id, fn, { fails })
}

// ────────────────────────────────────────────────
// 风格切换（真实设置写入；套件结束恢复）
// ────────────────────────────────────────────────

function getStyle() {
  const r = okJson(ui(['settings', 'get', 'promptStyle.style']), 'settings get promptStyle.style')
  return r.value === 'terse' ? 'terse' : 'detailed'
}

function setStyle(style) {
  okJson(ui(['settings', 'set', 'promptStyle.style', style]), 'settings set promptStyle.style')
  const got = getStyle()
  assert(got === style, `风格写入未生效：期望 ${style}，回读 ${got}`)
}

// ────────────────────────────────────────────────
// 提示词转储解析（[llm-prompt] / [llm-prompt:full:begin/end]）
// ────────────────────────────────────────────────

function parsePromptLog(lines) {
  const items = []
  let cur = null
  for (const l of lines) {
    if (l.includes('[llm-prompt:full:begin]')) {
      const m = l.match(/instanceId=(\S+) style=(\S+)/)
      cur = { kind: 'full', instanceId: m?.[1], style: m?.[2], text: '' }
      continue
    }
    if (l.includes('[llm-prompt:full:end]')) {
      if (cur) items.push(cur)
      cur = null
      continue
    }
    if (cur) {
      cur.text += l + '\n'
      continue
    }
    const m = l.match(/\[llm-prompt\] instanceId=(\S+) style=(\S+) chars=(\d+)/)
    if (m) items.push({ kind: 'summary', instanceId: m[1], style: m[2], chars: Number(m[3]) })
  }
  return items
}

/** 取本轮新产生的最后一个完整转储块（含 style 与正文） */
function lastPromptBlock(cursor) {
  const items = parsePromptLog(logLinesSince(cursor))
  const fulls = items.filter((i) => i.kind === 'full' && i.text.length > 100)
  if (fulls.length === 0) return null
  const block = fulls[fulls.length - 1]
  const summary = [...items].reverse().find((i) => i.kind === 'summary' && i.instanceId === block.instanceId)
  return { ...block, chars: summary?.chars }
}

/** 轮询等待日志出现完整转储块（文件流有写入延迟） */
function waitPromptBlock(cursor, timeoutMs = 15000) {
  return pollUntil(() => lastPromptBlock(cursor), timeoutMs, 1000)
}

/** 清理轮次产物 */
function cleanupCronProbe() {
  const like = `%${CRON_PROBE_PHRASE}%`
  dbExec('DELETE FROM local_cron_runs WHERE job_id IN (SELECT id FROM local_cron_jobs WHERE task_text LIKE ?)', like)
  dbExec('DELETE FROM local_cron_jobs WHERE task_text LIKE ?', like)
}

// ────────────────────────────────────────────────
// PS-LOG-01 / PS-LOG-02：提示词转储形态（编排正确性，硬断言）
// ────────────────────────────────────────────────

function runLogShapeCase(style, id) {
  return maybe(id, () => {
    if (!logChannelAvailable()) throw new Error('SKIP: 日志通道不可用（提示词转储断言依赖应用日志）')
    setStyle(style)
    const sk = createSession(`${style} 提示词形态`, { prefix: SESSION_PREFIX })
    const cursor = logCursor()
    const { elapsedMs } = sendAndWait(sk, '帮我把这句话润色一下：周五之前把方案发给老王', {
      timeoutMs: TURN_TIMEOUT_MS,
    })
    const block = waitPromptBlock(cursor)
    assert(block, `未在应用日志中找到 [llm-prompt:full] 转储块（style=${style}）`)
    assert(block.style === style, `转储 style=${block.style}，与期望 ${style} 不符`)
    if (style === 'detailed') {
      assert(block.text.includes('### Disk-Index Pattern'), 'detailed 转储缺少 Disk-Index（完整细则）')
      assert(block.text.includes('## Tool Naming Contract'), 'detailed 转储缺少 Tool Naming Contract')
      assert(!block.text.includes('prompt_guide(section:'), 'detailed 转储不应含 prompt_guide 引导句')
    } else {
      assert(block.text.includes('prompt_guide(section: "operatingPrinciples")'), 'terse 转储缺少 operatingPrinciples 引导句')
      assert(block.text.includes('prompt_guide(section: "fileOutput")'), 'terse 转储缺少 fileOutput 引导句')
      assert(!block.text.includes('### Disk-Index Pattern'), 'terse 转储不应含 Disk-Index')
      assert(!block.text.includes('## Tool Naming Contract'), 'terse 转储不应含 Tool Naming Contract')
    }
    metrics.push({ case: id, style, chars: block.chars, elapsedMs, guideHit: null, note: '转储形态硬断言' })
    return `${style} 档转储形态正确（chars=${block.chars ?? '?'}，${elapsedMs}ms）`
  })
}

// ────────────────────────────────────────────────
// PS-TASK-01：定时提醒（真实任务，双档）
// ────────────────────────────────────────────────

/** 提醒探针关键词：模型会对 task_text 做改写，用关键词组合而非整句匹配 */
const REMINDER_PROBE_RE = /物业|快递/

function runReminderCase(style) {
  const id = `PS-TASK-01-${style.toUpperCase()}`
  return maybe(id, () => {
    setStyle(style)
    const sk = createSession(`${style} 定时提醒`, { prefix: SESSION_PREFIX })
    const cursor = logCursor()
    // 基线：既有任务 id 集合；只认「新增 + 关键词命中」的行（模型会改写 task_text，
    // 整句 LIKE 会被改写漏掉——2026-09-13 实测："给物业打电话，确认快递的事"）
    const baselineIds = new Set(dbQuery('SELECT id FROM local_cron_jobs').map((r) => r.id))
    const createdIds = []
    try {
      const { assistant, text, elapsedMs } = sendAndWait(sk, '明天早上九点提醒我给物业打电话确认快递', {
        timeoutMs: TURN_TIMEOUT_MS,
      })
      const rows = pollUntil(() => {
        const fresh = dbQuery('SELECT id, name, task_text, schedule_type, schedule_expr FROM local_cron_jobs').filter(
          (r) => !baselineIds.has(r.id) && (REMINDER_PROBE_RE.test(r.name || '') || REMINDER_PROBE_RE.test(r.task_text || '')),
        )
        return fresh.length > 0 ? fresh : null
      }, 20000, 2000)
      assert(rows, '未发现新创建的探针提醒行（任务未落地）')
      const row = rows[rows.length - 1]
      createdIds.push(...rows.map((r) => r.id))

      const block = waitPromptBlock(cursor)
      const toolRaw = JSON.stringify(assistant ?? {})
      const guideHit = /cron_guide/.test(toolRaw)
      const replyOk = /提醒/.test(text || '')
      metrics.push({
        case: id, style, chars: block?.chars, elapsedMs, guideHit,
        note: `提醒行=${row.schedule_type}:${row.schedule_expr}；回复语义=${replyOk ? '命中' : '未命中(soft)'}`,
      })
      return `已创建提醒 ${row.schedule_type}=${row.schedule_expr}；guideHit=${guideHit}；${elapsedMs}ms${replyOk ? '' : '；(soft) 回复未含「提醒」语义，供引导句迭代参考'}`
    } finally {
      for (const jobId of createdIds) {
        dbExec('DELETE FROM local_cron_runs WHERE job_id = ?', jobId)
        dbExec('DELETE FROM local_cron_jobs WHERE id = ?', jobId)
      }
    }
  })
}

// ────────────────────────────────────────────────
// PS-TASK-02：代码小任务（真实任务，双档）
// ────────────────────────────────────────────────

function listPyFiles(root) {
  const out = new Map()
  const walk = (dir) => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && e.name.endsWith('.py')) out.set(p, fs.statSync(p).mtimeMs)
    }
  }
  walk(root)
  return out
}

function runCodeCase(style) {
  const id = `PS-TASK-02-${style.toUpperCase()}`
  return maybe(id, () => {
    const wsOutputs = resolveWorkspaceOutputs()
    if (!fs.existsSync(wsOutputs)) throw new Error(`SKIP: 工作区 outputs 不存在（${wsOutputs}）`)
    setStyle(style)
    const sk = createSession(`${style} 代码小任务`, { prefix: SESSION_PREFIX })
    const before = listPyFiles(wsOutputs)
    const createdPaths = []
    try {
      const cursor1 = logCursor()
      const r1 = sendAndWait(sk, '帮我写个 Python 小脚本，运行后打印今天的日期，放到工作区 outputs 里', {
        timeoutMs: TURN_TIMEOUT_MS,
      })
      const found = pollUntil(() => {
        const now = listPyFiles(wsOutputs)
        const fresh = [...now.keys()].filter((p) => !before.has(p))
        return fresh.length > 0 ? fresh : null
      }, 20000, 2000)
      assert(found, '未在 outputs 下发现新增 .py 文件（任务一未落地）')
      const target = found[found.length - 1]
      createdPaths.push(target)
      const block1 = waitPromptBlock(cursor1)

      const cursor2 = logCursor()
      const r2 = sendAndWait(sk, '再加一下，把星期几也打印出来', { timeoutMs: TURN_TIMEOUT_MS })
      const changed = pollUntil(() => {
        const content = fs.readFileSync(target, 'utf-8')
        return /星期|weekday|%A|strftime|isoweekday|weekday\(\)/i.test(content) ? content : null
      }, 20000, 2000)
      assert(changed, `轮 2 后文件未体现星期逻辑：${target}`)
      const block2 = waitPromptBlock(cursor2)

      const toolRaw = JSON.stringify(r2.assistant ?? {})
      const guideHit = /prompt_guide|spawn_agent|file_(read|write|edit)/.test(toolRaw)
      metrics.push({
        case: id, style, chars: block1?.chars, elapsedMs: r1.elapsedMs + r2.elapsedMs, guideHit,
        note: `产物=${path.relative(wsOutputs, target)}；轮2文件含星期逻辑`,
      })
      return `产物 ${path.relative(wsOutputs, target)}（轮1 ${r1.elapsedMs}ms / 轮2 ${r2.elapsedMs}ms；chars=${block2?.chars ?? block1?.chars ?? '?'}）`
    } finally {
      // 清理本次新增文件与该文件独占的新目录（自底向上，非空不删）
      for (const p of createdPaths) {
        try {
          fs.unlinkSync(p)
        } catch {
          /* 忽略 */
        }
        let dir = path.dirname(p)
        while (dir.startsWith(wsOutputs) && dir !== wsOutputs) {
          try {
            fs.rmdirSync(dir)
          } catch {
            break
          }
          dir = path.dirname(dir)
        }
      }
    }
  })
}

// ────────────────────────────────────────────────
// PS-TASK-03：会话内连续性（真实任务，双档）
// ────────────────────────────────────────────────

function runContinuityCase(style) {
  const id = `PS-TASK-03-${style.toUpperCase()}`
  return maybe(id, () => {
    setStyle(style)
    const sk = createSession(`${style} 会话连续性`, { prefix: SESSION_PREFIX })
    const cursor = logCursor()
    const r1 = sendAndWait(sk, '记住一个事：我们项目代号叫「青竹」，以后我说青竹就是指这个项目', {
      timeoutMs: TURN_TIMEOUT_MS,
    })
    let r2 = sendAndWait(sk, '青竹是什么项目来着？', { timeoutMs: TURN_TIMEOUT_MS })
    let hit = /青竹/.test(r2.text || '')
    if (!hit) {
      // 软断言允许一次追问（同会话重发，保持连续性语境）
      r2 = sendAndWait(sk, '刚才提到的项目代号是什么？', { timeoutMs: TURN_TIMEOUT_MS })
      hit = /青竹/.test(r2.text || '')
    }
    const block = waitPromptBlock(cursor)
    metrics.push({
      case: id, style, chars: block?.chars, elapsedMs: r1.elapsedMs + r2.elapsedMs, guideHit: null,
      note: `连续性=${hit ? '命中' : '未命中(soft,retried)'}`,
    })
    assert(hit, '(soft, retried) 轮 2 回复未复述代号「青竹」')
    return `连续性命中（轮1 ${r1.elapsedMs}ms / 轮2 ${r2.elapsedMs}ms）`
  })
}

// ────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────

const pf = preflight()
if (!pf.ok) {
  console.error('❌ 环境预检失败：')
  for (const p of pf.problems) console.error('  -', p)
  process.exit(3)
}
for (const w of pf.warnings) console.warn('⚠️ ', w)

let originalStyle
try {
  originalStyle = getStyle()
} catch (err) {
  console.error('❌ 无法读取当前提示词风格（应用是否为当前分支代码？settings get promptStyle.style 失败）：', String(err))
  process.exit(3)
}
console.log(`ℹ️  当前风格=${originalStyle}（套件结束${NO_RESTORE ? '不' : ''}恢复）`)

try {
  runLogShapeCase('detailed', 'PS-LOG-01')
  if (fails.count < 3) runLogShapeCase('terse', 'PS-LOG-02')
  if (fails.count < 3) runReminderCase('detailed')
  if (fails.count < 3) runReminderCase('terse')
  if (fails.count < 3) runCodeCase('detailed')
  if (fails.count < 3) runCodeCase('terse')
  if (fails.count < 3) runContinuityCase('detailed')
  if (fails.count < 3) runContinuityCase('terse')
} catch (err) {
  console.error('❌ 套件异常中断：', err)
}

if (!NO_RESTORE) {
  try {
    setStyle(originalStyle)
    console.log(`↩️  已恢复风格=${originalStyle}`)
  } catch (err) {
    console.error('⚠️  风格恢复失败：', String(err))
  }
}

const cmpRows = metrics.filter((m) => m.case.startsWith('PS-TASK'))
  .map((m) => `| ${m.case} | ${m.style} | ${m.chars ?? '-'} | ${m.guideHit === null ? '-' : m.guideHit ? '✓' : '—'} | ${(m.elapsedMs / 1000).toFixed(1)}s | ${m.note ?? ''} |`)
  .join('\n')

ev.writeReport({
  meta: { '风格切换方式': 'app-ui CLI `settings set promptStyle.style`（真实设置写入；结束恢复原值）', '探针会话前缀': SESSION_PREFIX },
  extraSections: `## 双档对照（任务实施差别）

| 用例 | 档位 | 提示词 chars | 展开引导命中 | 回合耗时 | 备注 |
|---|---|---|---|---|---|
${cmpRows || '| - | - | - | - | - | 无 |'}

> 硬断言：任务落地（cron 行 / outputs 产物 / 连续性回复）；软信号（回复语义 / 引导命中）供引导句迭代参考，详见各用例 note。
> 微信渠道两场景（cron_guide / weixin_send_guide）需真实微信会话，见用例文档「人工验证补充」。`,
})
