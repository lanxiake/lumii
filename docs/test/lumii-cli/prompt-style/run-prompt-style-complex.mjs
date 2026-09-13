#!/usr/bin/env node
/**
 * 提示词风格实验 P2 —— 复杂长任务 / 多工具调用 场景化实测
 *
 * 目的：验证 terse（极简索引式）提示词下，工具使用（选择/顺序/参数）与
 * 技能使用（skill 检索/加载/执行）的准确性，与 detailed 档对照。
 *
 * 场景（×2 档，共 6 轮真实 LLM 任务）：
 *   PC-C1 文件工具链：建目录→写脚本→跑→写报告（file 工具/bash/todo 编排）
 *   PC-C2 调研+输出规范：web_search → 简报落盘（路径/命名规范）
 *   PC-C3 技能命中：天气查询（skill 检索/加载 或按技能走 curl）
 *
 * 观测：回合耗时 / 工具序列（助手消息 JSON）/ 提示词 chars（应用日志转储）/
 *       产物落地硬断言 / 回复语义软断言。
 * 规范：../CLI-TEST-SPEC.md；环境变量 PC_ONLY / PC_NO_RESTORE / PC_TURN_TIMEOUT_MS
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
  createEvidence,
  runCase,
  preflight,
  parseContentJson,
  DATA_ROOT,
} from '../lib/cli-harness.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SESSION_PREFIX = '[pc-suite]'
const TURN_TIMEOUT_MS = Number(process.env.PC_TURN_TIMEOUT_MS || 300000)
const NO_RESTORE = process.env.PC_NO_RESTORE === '1'
const ONLY = process.env.PC_ONLY || ''

/** 工作区 outputs 真实路径（设置里 workspace.directory，用户可自定义） */
function resolveWorkspaceOutputs() {
  try {
    const r = okJson(ui(['settings', 'get', 'workspace.directory']), 'settings get workspace.directory')
    const dir = typeof r.value === 'string' && r.value.trim() ? r.value.trim() : null
    if (dir) return path.join(dir, 'outputs')
  } catch {
    /* 回退默认 */
  }
  return path.join(DATA_ROOT, 'outputs')
}

const ev = createEvidence(__dirname, 'prompt-style-complex', '提示词风格实验 P2 复杂任务实测')
const fails = { count: 0 }
/** 双档对照指标 */
const metrics = []
/** 逐轮工具序列与提示词统计（另存 JSON 供深析） */
const traces = []

function maybe(id, fn) {
  if (ONLY && !id.startsWith(ONLY)) {
    ev.record(id, 'SKIP', `PC_ONLY=${ONLY} 过滤跳过`)
    return true
  }
  return runCase(ev, id, fn, { fails })
}

// ────────────────────────────────────────────────
// 风格与提示词观测
// ────────────────────────────────────────────────

function getStyle() {
  const r = okJson(ui(['settings', 'get', 'promptStyle.style']), 'settings get promptStyle.style')
  return r.value === 'terse' ? 'terse' : 'detailed'
}

function setStyle(style) {
  okJson(ui(['settings', 'set', 'promptStyle.style', style]), 'settings set promptStyle.style')
  assert(getStyle() === style, `风格写入未生效：期望 ${style}`)
}

/** 本轮 [llm-prompt] / [prompt-section] 摘要（应用日志） */
function turnPromptStats(cursor, style) {
  if (!logChannelAvailable()) return null
  const lines = logLinesSince(cursor)
  const summary = [...lines].reverse().find((l) => /\[llm-prompt\] instanceId=/.test(l) && l.includes(`style=${style}`))
  const section = [...lines].reverse().find((l) => /\[prompt-section\] instanceId=/.test(l) && l.includes(`style=${style}`))
  const out = {}
  const m1 = summary?.match(/chars=(\d+) static=(\d+) dynamic=(\d+)/)
  if (m1) {
    out.chars = Number(m1[1])
    out.staticChars = Number(m1[2])
    out.dynamicChars = Number(m1[3])
  }
  const m2 = section?.match(/sections=(\d+) totalChars=(\d+)/)
  if (m2) {
    out.sections = Number(m2[1])
    out.sectionTotal = Number(m2[2])
  }
  return Object.keys(out).length ? out : null
}

/**
 * 等待回合真正结束。
 * sendAndWait 在「文本段两次轮询稳定」时即返回，但模型可能在文本段之后继续工具调用——
 * 会话列表的 hasRunning 才是权威完成信号（连续 3 次空闲确认，避免工具间隙的瞬时假空闲）。
 */
function waitSessionIdle(sk, timeoutMs = TURN_TIMEOUT_MS) {
  let idleStreak = 0
  const ok = pollUntil(() => {
    const l = ui(['conversation', 'list', '--limit', '40'])
    const it = (Array.isArray(l.json) ? l.json : []).find((x) => x.sessionKey === sk)
    if (it && !it.hasRunning) {
      idleStreak++
      return idleStreak >= 3 ? true : null
    }
    idleStreak = 0
    return null
  }, timeoutMs, 2500)
  return !!ok
}

// ────────────────────────────────────────────────
// 工具序列提取（助手消息 JSON → 工具名列表）
// ────────────────────────────────────────────────

/**
 * 回合全量工具轨迹：遍历会话内全部 assistant 消息的 parts。
 * 单条消息的 parts 可能被拆分为多条 assistant 消息存储，只取最后一条会漏调用
 * （2026-09-13 实测：末条缺 file_write/file_edit/task_complete 等前置调用）。
 */
function fullToolTrace(sk) {
  const r = ui(['context', 'messages', '--session', sk, '--limit', '40'])
  const arr = r.json?.items || []
  const names = []
  for (const m of arr) {
    if (m.role !== 'assistant') continue
    const parsed = parseContentJson(m)
    collectToolParts(parsed, (p) => names.push(p.name))
  }
  return names
}

/** 只收集 type==='tool' 的 part（parts 位于 contentJson JSON 字符串内，需先解析） */
function collectToolParts(obj, fn) {
  if (!obj || typeof obj !== 'object') return
  if (Array.isArray(obj)) {
    for (const it of obj) collectToolParts(it, fn)
    return
  }
  if (obj.type === 'tool' && typeof obj.name === 'string') fn(obj)
  for (const v of Object.values(obj)) collectToolParts(v, fn)
}

// ────────────────────────────────────────────────
// PC-C1 文件工具链（多步：目录/脚本/运行/报告）
// ────────────────────────────────────────────────

function listDirRec(root) {
  const out = []
  const walk = (d) => {
    let es = []
    try {
      es = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of es) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(p)
    }
  }
  walk(root)
  return out
}

function runFileChainCase(style) {
  const id = `PC-C1-${style.toUpperCase()}`
  return maybe(id, () => {
    const wsOutputs = resolveWorkspaceOutputs()
    if (!fs.existsSync(wsOutputs)) throw new Error(`SKIP: 工作区 outputs 不存在（${wsOutputs}）`)
    const taskDir = path.join(wsOutputs, 'file-stats')
    const dirExistedBefore = fs.existsSync(taskDir)
    const filesBefore = new Set(listDirRec(wsOutputs))
    setStyle(style)
    const sk = createSession(`${style} 文件工具链`, { prefix: SESSION_PREFIX })
    const cursor = logCursor()
    try {
      const turnStart = Date.now()
      sendAndWait(
        sk,
        '帮我做个小工具，按步骤来：\n' +
          '1. 在工作区 outputs 下新建任务目录 file-stats；\n' +
          '2. 往里面放几个示例文件（至少一个 .txt、一个 .md）；\n' +
          '3. 写一个 Python 脚本 stats.py，统计该目录（含子目录）里各扩展名的文件数量并打印结果；\n' +
          '4. 运行脚本，确认输出正确；\n' +
          '5. 把结果整理成 report.md 放进同一个目录。',
        { timeoutMs: TURN_TIMEOUT_MS },
      )
      waitSessionIdle(sk)
      const elapsedMs = Date.now() - turnStart

      // 产物硬断言：脚本 + 报告
      const py = pollUntil(() => {
        const found = listDirRec(wsOutputs).filter((p) => p.endsWith('.py') && p.includes('file-stats') && !filesBefore.has(p))
        return found.length > 0 ? found : null
      }, 20000, 2000)
      assert(py, '未发现新建的 .py 脚本（步骤 3 未落地）')
      const report = pollUntil(() => {
        const found = listDirRec(wsOutputs).filter((p) => p.endsWith('.md') && p.includes('file-stats') && !filesBefore.has(p))
        return found.length > 0 ? found : null
      }, 20000, 2000)
      assert(report, '未发现 report.md（步骤 5 未落地）')

      const reportContent = fs.readFileSync(report[report.length - 1], 'utf-8')
      const pyContent = fs.readFileSync(py[py.length - 1], 'utf-8')
      const stats = turnPromptStats(cursor, style)
      const tools = fullToolTrace(sk)
      const ranBash = tools.includes('bash')
      const usedFileWrite = tools.some((t) => t === 'file_write')
      const usedTodo = tools.includes('todo_write')

      metrics.push({
        case: id, style, elapsedMs, tools: tools.join('>') || '(未解析出)',
        promptChars: stats?.chars, note: `报告含统计=${/txt|\.md|扩展名/.test(reportContent) ? '是' : '否'}；bash=${ranBash}`,
      })
      ev.record(`${id}-trace`, 'INFO', `工具序列=[${tools.join('>')}]`, {})
      traces.push({ case: id, style, tools, promptStats: stats, py: path.relative(wsOutputs, py[0]), report: path.relative(wsOutputs, report[0]) })

      // 工具选择为软信号（完成度已由产物硬断言兜底；选择质量供对照分析）
      return `${path.relative(wsOutputs, py[0])} + report.md 落地；工具序列=[${tools.join('>')}]；${elapsedMs}ms；prompt=${stats?.chars ?? '?'}${usedTodo ? '；含 todo' : ''}；file_write=${usedFileWrite}；bash=${ranBash}；脚本含统计逻辑=${/walk|glob|listdir|suffix|os\./.test(pyContent) ? '是' : '否'}`
    } finally {
      // 清理：仅删本次新增文件与新增目录（含模型自建的空子目录，自底向上）
      try {
        for (const p of listDirRec(wsOutputs)) {
          if (p.includes('file-stats') && !filesBefore.has(p)) fs.unlinkSync(p)
        }
        const pruneEmpty = (d) => {
          if (!fs.existsSync(d)) return
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.isDirectory()) pruneEmpty(path.join(d, e.name))
          }
          try {
            if (fs.readdirSync(d).length === 0) fs.rmdirSync(d)
          } catch {
            /* 忽略 */
          }
        }
        if (!dirExistedBefore) pruneEmpty(taskDir)
      } catch {
        /* 忽略清理异常 */
      }
    }
  })
}

// ────────────────────────────────────────────────
// PC-C2 调研 + 输出规范（web_search → 简报落盘）
// ────────────────────────────────────────────────

function runResearchCase(style) {
  const id = `PC-C2-${style.toUpperCase()}`
  return maybe(id, () => {
    const wsOutputs = resolveWorkspaceOutputs()
    if (!fs.existsSync(wsOutputs)) throw new Error(`SKIP: 工作区 outputs 不存在`)
    const filesBefore = new Set(listDirRec(wsOutputs))
    const startMs = Date.now()
    setStyle(style)
    const sk = createSession(`${style} 调研简报`, { prefix: SESSION_PREFIX })
    const cursor = logCursor()
    const created = []
    try {
      const turnStart = Date.now()
      sendAndWait(
        sk,
        '帮我调研一下最近有哪些值得关注的 AI 编程工具动态，挑 3 条写成一页简报，放到工作区里，文件名自拟。',
        { timeoutMs: TURN_TIMEOUT_MS },
      )
      waitSessionIdle(sk)
      const elapsedMs = Date.now() - turnStart

      const found = pollUntil(() => {
        const fresh = listDirRec(wsOutputs).filter(
          (p) => /\.(md|html)$/i.test(p) && !filesBefore.has(p) && fs.statSync(p).mtimeMs > startMs - 5000,
        )
        return fresh.length > 0 ? fresh : null
      }, 25000, 2000)
      assert(found, '未在工作区发现新建的简报文件（任务未落地）')
      created.push(...found)

      const target = found[found.length - 1]
      const content = fs.readFileSync(target, 'utf-8')
      const rel = path.relative(wsOutputs, target)
      const stats = turnPromptStats(cursor, style)
      const tools = fullToolTrace(sk)
      const usedSearch = tools.includes('web_search')
      const usedWrite = tools.includes('file_write')
      // 路径与命名规范检查（软信号，供文案迭代参考）
      const pathOk = rel.split(/[\\/]/).length >= 2 // 位于子目录（outputs/<task>/）或 outputs 根（容错）
      const nameOk = !/[:<>|?*"]/.test(path.basename(target))
      const hasThreeItems = (content.match(/^#{1,4}\s|\n\s*\d+\.\s|^-\s/gm) || []).length >= 3

      metrics.push({
        case: id, style, elapsedMs, tools: tools.join('>') || '(未解析出)', promptChars: stats?.chars,
        note: `${rel}；web_search=${usedSearch}；3条=${hasThreeItems}；命名=${nameOk}`,
      })
      ev.record(`${id}-trace`, 'INFO', `工具序列=[${tools.join('>')}]`, {})
      traces.push({ case: id, style, tools, promptStats: stats, file: rel })

      // 动态事实必须经 web_search（无检索 = 凭记忆编造，属准确性硬约束）；落盘手段为软信号
      assert(usedSearch, '未使用 web_search（动态事实任务却无检索，准确性异常）')
      return `简报 ${rel}（${content.length} 字符）；工具序列=[${tools.join('>')}]；web_search=${usedSearch}；file_write=${usedWrite}；3条=${hasThreeItems}；命名合规=${nameOk}；${elapsedMs}ms；prompt=${stats?.chars ?? '?'}`
    } finally {
      for (const p of created) {
        try {
          fs.unlinkSync(p)
          // 清理模型自建的空父目录（自底向上，止于 outputs 根）
          let dir = path.dirname(p)
          while (dir.startsWith(wsOutputs) && dir !== wsOutputs) {
            if (fs.readdirSync(dir).length === 0) {
              fs.rmdirSync(dir)
              dir = path.dirname(dir)
            } else break
          }
        } catch {
          /* 忽略 */
        }
      }
    }
  })
}

// ────────────────────────────────────────────────
// PC-C3 技能命中（天气：skill 检索/加载 或按技能 curl）
// ────────────────────────────────────────────────

function runSkillCase(style) {
  const id = `PC-C3-${style.toUpperCase()}`
  return maybe(id, () => {
    setStyle(style)
    const sk = createSession(`${style} 技能命中`, { prefix: SESSION_PREFIX })
    const cursor = logCursor()
    const turnStart = Date.now()
    const { text } = sendAndWait(
      sk,
      '帮我查一下北京现在的天气怎么样，用一句话告诉我温度就行。',
      { timeoutMs: TURN_TIMEOUT_MS },
    )
    waitSessionIdle(sk)
    const elapsedMs = Date.now() - turnStart
    const stats = turnPromptStats(cursor, style)
    const tools = fullToolTrace(sk)
    const usedSkillSearch = tools.includes('skill_search')
    const usedSkillInvoke = tools.includes('skill_invoke')
    const usedBash = tools.includes('bash')
    const replyOk = /(℃|°C|度|温度|weather)/i.test(text || '')

    metrics.push({
      case: id, style, elapsedMs, tools: tools.join('>') || '(未解析出)', promptChars: stats?.chars,
      note: `skill检索=${usedSkillSearch}；skill加载=${usedSkillInvoke}；bash=${usedBash}；回复含温度=${replyOk}`,
    })
    ev.record(`${id}-trace`, 'INFO', `工具序列=[${tools.join('>')}]`, {})
    traces.push({ case: id, style, tools, promptStats: stats, reply: (text || '').slice(0, 300) })

    assert(replyOk, '回复未包含温度信息（任务未完成）')
    assert(usedSkillSearch || usedSkillInvoke || usedBash, '未观察到技能检索/加载或执行动作（技能命中异常）')
    return `工具序列=[${tools.join('>')}]；回复含温度=${replyOk}；${elapsedMs}ms；prompt=${stats?.chars ?? '?'}`
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
  console.error('❌ 无法读取当前提示词风格：', String(err))
  process.exit(3)
}
console.log(`ℹ️  当前风格=${originalStyle}（套件结束${NO_RESTORE ? '不' : ''}恢复）`)

try {
  runFileChainCase('detailed')
  if (fails.count < 3) runFileChainCase('terse')
  if (fails.count < 3) runResearchCase('detailed')
  if (fails.count < 3) runResearchCase('terse')
  if (fails.count < 3) runSkillCase('detailed')
  if (fails.count < 3) runSkillCase('terse')
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

fs.writeFileSync(
  path.join(__dirname, 'prompt-style-complex-traces.json'),
  JSON.stringify(traces, null, 2),
  'utf-8',
)

const cmpRows = metrics
  .map((m) => `| ${m.case} | ${m.style} | ${m.promptChars ?? '-'} | ${m.elapsedMs ? (m.elapsedMs / 1000).toFixed(1) + 's' : '-'} | ${m.tools ?? '-'} | ${m.note ?? ''} |`)
  .join('\n')

ev.writeReport({
  meta: {
    风格切换: 'app-ui CLI `settings set promptStyle.style`（结束恢复原值）',
    探针会话前缀: SESSION_PREFIX,
    说明: '复杂任务（多工具调用）双档对照；工具序列来自助手消息 JSON 解析',
  },
  extraSections: `## 复杂任务双档对照

| 用例 | 档位 | 提示词 chars | 回合耗时 | 工具序列 | 备注 |
|---|---|---|---|---|---|
${cmpRows || '| - | - | - | - | - | 无 |'}
`,
})
