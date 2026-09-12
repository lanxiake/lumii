#!/usr/bin/env node
/**
 * 自主进化有效性验证（EVO 套件）— 加速实验
 *
 * 回答三个问题：① 真的能进化吗（变体淘汰学习 / 短板闭环）② 有用吗（学习沉淀可召回、日记反映真实经历）
 * ③ 有生命感吗（内在状态由真实事件驱动）。产物：evidence.jsonl + report.md（含结论）。
 *
 * 对应用例文档：docs/test/lumii-cli/autonomous/autonomous-effectiveness-test-cases.md
 * 规范：docs/test/lumii-cli/CLI-TEST-SPEC.md
 *
 * 用法：node docs/test/lumii-cli/autonomous/run-autonomous-effectiveness-e2e.mjs
 *       EVO_ONLY=A node ...（只跑实验 A；可组合如 EVO_ONLY=AB）
 *
 * 环境变量：EVO_ONLY、EVO_SKIP_LLM=1、EVO_NO_RESTORE=1、EVO_PROBE_COUNT（默认 12）、
 *          EVO_TURN_TIMEOUT_MS（默认 180000）、EVO_VERBOSE=1
 *
 * 真实数据操作声明（详见用例文档 §五）：
 * - 快照恢复：autonomous.enabled/settings/mood/concerns/last_diary_date/tokens/outreach/cron enabled/feedback
 * - 不可恢复（即验证证据本身）：prompt_variants 统计、测试目标（[evo-e2e]）、reflections、
 *   agent_memories/wiki_sources 沉淀、autonomous_diaries、evolution:main、探针会话（[evo-e2e-*]）
 * - 不触碰：历史 pending 目标、用户会话
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as h from '../lib/cli-harness.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TURN_TIMEOUT = Number(process.env.EVO_TURN_TIMEOUT_MS) || 180000
const ONLY = (process.env.EVO_ONLY || '').toUpperCase()
const SKIP_LLM = process.env.EVO_SKIP_LLM === '1'
const NO_RESTORE = process.env.EVO_NO_RESTORE === '1'
const PROBE_COUNT = Number(process.env.EVO_PROBE_COUNT) || 12
const DIGEST_ONLY = process.env.EVO_DIGEST_ONLY === '1'
const VERBOSE = process.env.EVO_VERBOSE === '1'

const ev = h.createEvidence(__dirname, 'autonomous-effectiveness', '自主进化有效性验证（EVO 加速实验）')
const fails = { count: 0 }
const selected = (letter) => !ONLY || ONLY.includes(letter)

// ────────────────────────────────────────────────
// 工具
// ────────────────────────────────────────────────

const short = (id) => (id ? String(id).slice(-10) : 'null')
const fmtUcb = (rows) => rows.map((r) => `${short(r.id)}${r.isBaseline ? '(base)' : ''}=${r.ucb.toFixed(4)}`).join(' ')

/** 探针会话统一 [evo-e2e] 前缀（用例文档命名空间约定） */
const createSession = (title) => h.createSession(title, { prefix: '[evo-e2e]' })

/** 新建 n 个探针会话（不发消息），统计变体选择分布 */
function probeVariantDist(n) {
  const dist = {}
  for (let i = 0; i < n; i++) {
    const sk = createSession(`探针-${i + 1}`)
    const v = h.variantOfSession(sk)
    dist[v] = (dist[v] ?? 0) + 1
  }
  return dist
}

/** 格式化分布 {variantId: n} → "id×n"（labels 可标注关键变体） */
function fmtDist(dist, labels = {}) {
  return Object.entries(dist)
    .map(([k, v]) => `${labels[k] ? `[${labels[k]}]` : ''}${short(k)}×${v}`)
    .join(' ')
}

/** 低分配方完成回合：file_read 读「确定不存在」的文件（照做 task=0.5 / 拒绝 task=0.75，均 <0.6） */
const ABSENT_FILE_PROMPT = '请调用 file_read 工具读取这个不存在的文件：/definitely/not/exist/abc.txt'

const LONG_STORY_PROMPTS = [
  '给我讲一个很长很长的睡前故事，关于一只会说话的小狐狸的冒险，要有丰富的细节描写，请写到至少两千字，讲得越详细越好',
  '再讲一个很长的寓言故事，关于勤劳的蜜蜂和懒惰的蝴蝶，要有详细的场景和对白，请写到至少两千字',
]

function abortWith(sk, prompt) {
  h.send(sk, prompt)
  h.sleep(2500)
  const a = h.abortSend(sk)
  h.assert(a.code === 0, `abort 退出码 ${a.code}: ${a.out.slice(0, 200)}`)
  h.sleep(800)
}

function readAbortCounters(sk) {
  const v = h.readRuntimeState(`feedback:${sk}`)
  if (!v) return { edits: 0, resends: 0, aborts: 0 }
  try {
    return JSON.parse(v)
  } catch {
    return { edits: 0, resends: 0, aborts: 0 }
  }
}

/** 累积 2 次 abort 信号（计数校验 + 重试，防生成提前完成吞信号） */
function abortTwice(sk) {
  for (const p of LONG_STORY_PROMPTS) abortWith(sk, p)
  let counters = readAbortCounters(sk)
  let guard = 0
  while (counters.aborts < 2 && guard < 3) {
    guard++
    abortWith(sk, LONG_STORY_PROMPTS[0])
    counters = readAbortCounters(sk)
  }
  h.assert(counters.aborts >= 2, `abort 计数器未累积到 2: ${JSON.stringify(counters)}`)
  return counters
}

/** 发送并等待满意度评分落库（新会话），返回评分行 */
function sendAndWaitScore(sk, text) {
  h.send(sk, text)
  const row = h.pollUntil(() => h.readLatestSatisfaction(sk), TURN_TIMEOUT, 2000)
  h.assert(row, `回合结束后满意度评分未落库（等 ${TURN_TIMEOUT}ms）`)
  return row
}

/** 制造低分会话（abort×2 + 失败完成回合），重试 ≤maxAttempts；失败返回 null */
function makeLowScoreSession(title, maxAttempts = 6) {
  for (let i = 1; i <= maxAttempts; i++) {
    const sk = createSession(`${title}-${i}`)
    abortTwice(sk)
    const score = sendAndWaitScore(sk, ABSENT_FILE_PROMPT)
    if (score.overall_score < 0.6) return { sk, score, attempts: i }
    console.log(`  [${title}] 尝试 ${i}: overall=${score.overall_score.toFixed(3)} 未达低分，换新会话`)
  }
  return null
}

/** 运行 tick 并等待新的运行记录落库 */
function runTickAndWait(timeoutMs = 180000) {
  const before = h.lastCronRunSummary()
  const r = h.cronTick('autonomous-tick', { timeoutMs })
  if (r.timedOut) {
    console.log(`  [tick] 命令超时（${timeoutMs}ms），检查运行记录`)
  }
  const run = h.pollUntil(() => {
    const cur = h.lastCronRunSummary()
    return cur && cur.started_at !== before?.started_at ? cur : null
  }, 15000, 1000)
  h.assert(run, `cron run 未产生新运行记录（code=${r.code}）: ${(r.out + r.stderr).slice(0, 200)}`)
  return run
}

const goalById = (id) => h.dbGet('SELECT id, type, description, status, created_at FROM autonomous_goals WHERE id = ?', id)
const allGoalIds = () => h.dbQuery("SELECT id FROM autonomous_goals WHERE agent_id = 'assistant'").map((r) => r.id)
const newPendingGoals = (excludeIds) =>
  h
    .dbQuery("SELECT id, type, description, status, created_at FROM autonomous_goals WHERE agent_id = 'assistant' AND status = 'pending'")
    .filter((g) => !excludeIds.has(g.id))

const variantStat = (id) =>
  h.dbGet('SELECT trial_count, success_count, avg_satisfaction FROM prompt_variants WHERE id = ?', id)

function pickKeyword(text) {
  if (!text) return null
  const words = text
    .replace(/[^一-龥a-zA-Z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length >= 4 && w.length <= 10)
    .sort((a, b) => b.length - a.length)
  return words[0] ?? null
}

function readConcerns() {
  const v = h.readRuntimeState('autonomous.concerns')
  if (!v) return []
  try {
    return JSON.parse(v)
  } catch {
    return []
  }
}

// ────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────

let snap = null
let cronDisabled = null
// 实验 A 状态
let ucbBefore = null
let ucbAfter = null
let preDist = null
let a2 = null
// 实验 B 状态
let b1 = null // { goal }
let reflectGoal = null
let reflectIssue = null
let execGoal = null
let b4 = null // { text, startIso }
let moodAfterSeed = null
// 实验 C 状态
let diaryInfo = null

function main() {
  console.log('自主进化有效性验证（EVO 加速实验）\n')

  const pf = h.preflight()
  if (!pf.ok) {
    console.error('❌ 预检失败：')
    for (const p of pf.problems) console.error(`  - ${p}`)
    process.exit(3)
  }
  for (const w of pf.warnings) console.warn(`⚠️  ${w}`)
  ev.record('PREFLIGHT', 'INFO', '预检通过')

  // 快照 + 环境保护（禁用全部后台 cron，手动 cron run 不受影响）
  const today = h.localDateKey()
  snap = h.snapshotRuntimeState([
    'autonomous.enabled',
    'autonomous.settings',
    'autonomous.mood',
    'autonomous.concerns',
    'autonomous.last_diary_date',
    'autonomous.last_plan_at',
    'autonomous.outreach.last_sent_at',
    `autonomous.tokens.${today}`,
    `autonomous.outreach.${today}`,
  ])
  cronDisabled = h.disableBackgroundCronJobs()
  ev.record('SNAPSHOT', 'INFO', `runtime_state 快照 ${Object.keys(snap).length} 键；后台 cron 禁用 ${cronDisabled.length} 个`)

  // 启用（兜底；快照已记录原值）
  if (h.readRuntimeState('autonomous.enabled') !== 'true') {
    const r = h.ui(['autonomous', 'enable'])
    ev.record('ENABLE', 'INFO', `autonomous enable（原值 ${snap['autonomous.enabled']}）code=${r.code}`)
  } else {
    ev.record('ENABLE', 'INFO', 'autonomous 已处于启用状态')
  }

  try {
    if (DIGEST_ONLY) {
      runDigestOnly()
    } else {
      runExperimentA()
      runExperimentB()
      runExperimentC()
    }
  } finally {
    if (!NO_RESTORE) {
      h.restoreRuntimeState(snap)
      h.restoreBackgroundCronJobs(cronDisabled)
      ev.record('RESTORE', 'INFO', `快照已恢复（enabled=${snap['autonomous.enabled']}，cron 恢复 ${cronDisabled.length} 个）`)
    } else {
      ev.record('RESTORE', 'INFO', 'EVO_NO_RESTORE=1，保留现场')
    }
  }

  writeFinalReport()
}

// ==================== 积压消化（B0 / DIGEST_ONLY）====================

/** 逐个 tick 执行 due executing 目标（消化积压，使后续 tick 能派发到测试目标） */
function digestExecutingGoals(maxTicks = 8) {
  const dueCount = () =>
    h.dbQuery(
      "SELECT id FROM autonomous_goals WHERE agent_id='assistant' AND status='executing' AND (scheduled_for IS NULL OR scheduled_for <= ?)",
      new Date().toISOString(),
    ).length
  const pre = dueCount()
  let ticks = 0
  const digests = []
  while (dueCount() > 0 && ticks < maxTicks) {
    ticks++
    const run = runTickAndWait(180000)
    digests.push(String(run.summary).slice(0, 40))
    console.log(`  [digest] tick#${ticks}: ${String(run.summary).slice(0, 70)}（剩余 due ${dueCount()}）`)
  }
  return { pre, post: dueCount(), ticks, digests }
}

/** 仅消化模式：禁用 cron + 防 outreach，消化积压后恢复退出（供 EVO_DIGEST_ONLY=1 使用） */
function runDigestOnly() {
  console.log('\n── 仅消化模式：清理 due executing 积压 ──')
  h.okJson(h.ui(['autonomous', 'settings', 'set', '--data', '{"maxOutreachPerDay":0}']), 'settings set')
  const r = digestExecutingGoals(8)
  ev.record('DIGEST', r.post === 0 ? 'PASS' : 'FAIL', `积压 ${r.pre} → ${r.post}（${r.ticks} 次 tick：${r.digests.join(' | ')}）`)
}

// ==================== 实验 A：变体淘汰学习 ====================

function runExperimentA() {
  if (!selected('A')) return
  console.log('\n── 实验 A：变体选择的学习行为 ──')

  if (!h.runCase(ev, 'EVO-A1', () => {
    ucbBefore = h.computeUcb()
    const top = ucbBefore[0]
    h.assert(ucbBefore.length >= 2, `变体数量不足（${ucbBefore.length}）`)
    h.assert(top.n >= 10, `argmax 变体试验数不足（n=${top.n}，需 ≥10 才有 exploitation 意义）`)
    preDist = probeVariantDist(6)
    return `现状：argmax=${short(top.id)}（avg=${top.avg.toFixed(3)} n=${top.n}）｜${fmtUcb(ucbBefore)}｜注入前 6 探针分布：${fmtDist(preDist)}`
  }, { fails })) return

  if (!h.runCase(ev, 'EVO-A2', () => {
    if (SKIP_LLM) throw new Error('SKIP: EVO_SKIP_LLM=1')
    if (!ucbBefore) throw new Error('SKIP: 依赖 EVO-A1 基线')
    const targetId = ucbBefore[0].id
    const b0 = variantStat(targetId) // 注入前统计（必须在制造低分之前读）
    const lows = []
    let sessionsTried = 0
    while (lows.length < 3 && sessionsTried < 4) {
      sessionsTried++
      // 囤一个选中目标变体的会话（create 即写 prompt-variant 键）
      let sk = null
      for (let i = 0; i < 4 && !sk; i++) {
        const cand = createSession(`A2 囤-${sessionsTried}-${i + 1}`)
        if (h.variantOfSession(cand) === targetId) sk = cand
        else console.log(`  [A2] create 选中 ${short(h.variantOfSession(cand))}，继续囤`)
      }
      if (!sk) {
        console.log('  [A2] 未能囤到目标变体会话（可能已翻转）')
        break
      }
      abortTwice(sk)
      const score = sendAndWaitScore(sk, ABSENT_FILE_PROMPT)
      if (score.overall_score >= 0.6) {
        console.log(`  [A2] overall=${score.overall_score.toFixed(3)} 未达低分，继续`)
        continue
      }
      lows.push(score.overall_score)
      console.log(`  [A2] 低分达成 overall=${score.overall_score.toFixed(3)}（第 ${lows.length} 条）`)
      const now = h.computeUcb()
      if (now[0].id !== targetId) {
        console.log(`  [A2] 注入 ${lows.length} 条后 argmax 已易主 → ${short(now[0].id)}`)
        break
      }
    }
    if (lows.length === 0) throw new Error('SKIP: 未能制造出 <0.6 的低分会话（LLM 行为非确定）')
    const b1s = variantStat(targetId)
    h.assert(b1s.trial_count > b0.trial_count, `变体 trial_count 未增长（${b0.trial_count} → ${b1s.trial_count}）——反馈未回写`)
    h.assert(
      b1s.avg_satisfaction < b0.avg_satisfaction,
      `变体 avg_satisfaction 未下降（${b0.avg_satisfaction.toFixed(4)} → ${b1s.avg_satisfaction.toFixed(4)}）`,
    )
    a2 = { targetId, lowCount: lows.length, overalls: lows }
    return `对当前 argmax ${short(targetId)} 注入 ${lows.length} 条低分（overall ${lows.map((o) => o.toFixed(3)).join('/')}）；trial ${b0.trial_count}→${b1s.trial_count}，avg ${b0.avg_satisfaction.toFixed(4)}→${b1s.avg_satisfaction.toFixed(4)}`
  }, { fails })) return

  if (!h.runCase(ev, 'EVO-A3', () => {
    if (!a2) throw new Error('SKIP: 依赖 EVO-A2 低分信号')
    ucbAfter = h.computeUcb()
    const newTop = ucbAfter[0]
    const after = ucbAfter.find((r) => r.id === a2.targetId)
    const before = ucbBefore.find((r) => r.id === a2.targetId)
    if (newTop.id !== a2.targetId) {
      return `UCB 重排：负反馈使 argmax ${short(a2.targetId)} → ${short(newTop.id)}（被测变体 UCB ${before.ucb.toFixed(4)}→${after.ucb.toFixed(4)}，降至第 ${ucbAfter.indexOf(after) + 1} 位）｜${fmtUcb(ucbAfter)}`
    }
    const drop = before.ucb - after.ucb
    if (drop >= 0.003) return `UCB 位移（soft：未易主但下降 ${drop.toFixed(4)}）｜${fmtUcb(ucbAfter)}`
    throw new Error(`注入后 UCB 未见有效位移（Δ=${drop.toFixed(4)}）｜${fmtUcb(ucbAfter)}`)
  }, { fails })) return

  h.runCase(ev, 'EVO-A4', () => {
    if (!ucbAfter) throw new Error('SKIP: 依赖 EVO-A3 重算')
    const dist = probeVariantDist(PROBE_COUNT)
    const curTop = ucbAfter[0].id
    const topCount = dist[curTop] ?? 0
    const oldCount = dist[a2.targetId] ?? 0
    const preOld = preDist?.[a2.targetId] ?? 0
    const detail = fmtDist(dist, { [curTop]: '当前argmax', [a2.targetId]: '被测变体' })
    if (topCount >= 7 && oldCount <= 3)
      return `选择跟随 UCB：${PROBE_COUNT} 个新会话 → ${detail}（当前 argmax ${topCount} 次≥7 / 被测变体 ${oldCount} 次≤3；注入前 6 探针中该变体被选 ${preOld} 次）`
    if (topCount > oldCount) return `选择跟随 UCB（soft）：${detail}`
    throw new Error(`选择未跟随 UCB 变化：${detail}`)
  }, { fails })
}

// ==================== 实验 B：短板闭环 ====================

function runExperimentB() {
  if (!selected('B')) return
  console.log('\n── 实验 B：短板闭环 ──')

  if (!h.runCase(ev, 'EVO-B0', () => {
    h.okJson(
      h.ui(['autonomous', 'settings', 'set', '--data', '{"approvalMode":"always","maxGoalsPerDay":20,"maxOutreachPerDay":0}']),
      'settings set',
    )
    const s = h.okJson(h.ui(['autonomous', 'settings', 'get']), 'settings get')
    h.assert(s.approvalMode === 'always', `approvalMode 未生效：${s.approvalMode}`)
    h.assert(Number(s.maxGoalsPerDay) === 20, `maxGoalsPerDay 未生效：${s.maxGoalsPerDay}`)
    h.assert(Number(s.maxOutreachPerDay) === 0, `maxOutreachPerDay 未生效：${s.maxOutreachPerDay}`)
    // 消化积压：把 due executing 目标（planner 批次）逐个 tick 执行，避免 B4 派发被抢占
    const r = digestExecutingGoals(8)
    return `临时参数（approvalMode=always / maxGoalsPerDay=20 / maxOutreach=0）生效；积压 executing ${r.pre} 个，${r.ticks} 次 tick 消化至 ${r.post} 个${r.digests.length ? `（${r.digests.join(' | ')}）` : ''}`
  }, { fails })) return

  if (!h.runCase(ev, 'EVO-B1', () => {
    if (SKIP_LLM) throw new Error('SKIP: EVO_SKIP_LLM=1')
    const before = new Set(allGoalIds())
    const low = makeLowScoreSession('B1 低满意', 4)
    if (!low) throw new Error('SKIP: 6 次尝试均未产生低分会话')
    const goal = h.pollUntil(() => newPendingGoals(before)[0] ?? null, 30000, 2000)
    if (!goal) throw new Error(`SKIP: 低分 overall=${low.score.overall_score.toFixed(3)} 但未生成新 pending 目标（历史目标去重拦截或配额限制）`)
    b1 = { goal, sk: low.sk, score: low.score.overall_score }
    return `低分 overall=${b1.score.toFixed(3)} → 新目标 ${short(b1.goal.id)} [${b1.goal.type}]「${(b1.goal.description || '').slice(0, 46)}」`
  }, { fails })) return

  h.runCase(ev, 'EVO-B2', () => {
    if (SKIP_LLM) throw new Error('SKIP: EVO_SKIP_LLM=1')
    const refBefore = h.dbCount('reflections')
    const goalIdsBefore = new Set(allGoalIds())
    const r = h.ui(['autonomous', 'reflect', '--agent', 'assistant'], { retries: 1, timeoutMs: 180000 })
    h.assert(r.code === 0 && r.json?.success !== false, `reflect 命令失败: ${(r.out + r.stderr).slice(0, 200)}`)
    h.assert(
      h.pollUntil(() => h.dbCount('reflections') > refBefore, 30000, 2000),
      `reflections 未新增（${refBefore}）`,
    )
    const latest = h.dbGet(
      'SELECT id, trigger_reason, primary_issue, suggested_goals FROM reflections ORDER BY created_at DESC LIMIT 1',
    )
    reflectIssue = latest.primary_issue
    const newGoals = newPendingGoals(goalIdsBefore)
    if (newGoals.length > 0) reflectGoal = newGoals[0]
    let sgCount = 0
    try {
      sgCount = JSON.parse(latest.suggested_goals ?? '[]').length
    } catch {
      /* 脏 JSON 忽略 */
    }
    return `反思落库（${latest.trigger_reason}）「${(latest.primary_issue || '').slice(0, 40)}…」；建议 ${sgCount} 条，新 pending ${newGoals.length} 条${reflectGoal ? `（选用 ${short(reflectGoal.id)}）` : ''}`
  }, { fails })

  const approveTarget = reflectGoal ?? b1?.goal ?? null
  if (!h.runCase(ev, 'EVO-B3', () => {
    if (!approveTarget) throw new Error('SKIP: 无本测试生成的目标（B1/B2 均未产出）')
    const j = h.okJson(h.ui(['autonomous', 'goals', 'approve', approveTarget.id, '--note', 'EVO 有效性测试批准']), 'goals approve')
    h.assert(j.success === true, `批准失败: ${JSON.stringify(j).slice(0, 150)}`)
    const row = h.pollUntil(() => {
      const g = goalById(approveTarget.id)
      return g?.status === 'executing' ? g : null
    }, 20000, 1000)
    h.assert(row, `批准后应 executing，实际 ${goalById(approveTarget.id)?.status}`)
    execGoal = approveTarget
    return `目标 ${short(execGoal.id)} 批准 → executing「${(execGoal.description || '').slice(0, 40)}」`
  }, { fails })) return

  if (!h.runCase(ev, 'EVO-B4', () => {
    if (SKIP_LLM) throw new Error('SKIP: EVO_SKIP_LLM=1')
    if (!execGoal || goalById(execGoal.id)?.status !== 'executing') throw new Error('SKIP: 无 executing 目标')
    moodAfterSeed = { energy: 1, valence: 0.6, arousal: 0.5 }
    h.seedMood(moodAfterSeed)
    b4 = { startIso: new Date().toISOString(), msgBefore: h.evolutionMessageCount() }
    let run = null
    for (let i = 0; i < 6; i++) {
      run = runTickAndWait(180000)
      if (/user turn in progress/.test(run?.summary ?? '')) {
        console.log('  [B4] tick 遇用户回合进行中，等待重试')
        h.sleep(10000)
        continue
      }
      break
    }
    h.assert(/execute-goal: completed/.test(run?.summary ?? ''), `tick 未成功执行目标：summary="${run?.summary}"`)
    const g = goalById(execGoal.id)
    h.assert(g.status === 'completed', `目标应 completed，实际 ${g.status}`)
    const msgAfter = h.evolutionMessageCount()
    h.assert(msgAfter > b4.msgBefore, `evolution:main 未新增消息（${b4.msgBefore} → ${msgAfter}）`)
    b4.text = h.latestEvolutionText()
    b4.msgDelta = msgAfter - b4.msgBefore
    return `tick「${run.summary}」；目标 completed；evolution:main +${b4.msgDelta} 条；产出「${(b4.text || '').slice(0, 50)}…」`
  }, { fails })) return

  h.runCase(ev, 'EVO-B5', () => {
    if (!b4) throw new Error('SKIP: 依赖 EVO-B4 目标执行')
    const mem = h.pollUntil(
      () =>
        h.dbGet(
          "SELECT id, substr(content,1,80) c FROM agent_memories WHERE created_at > ? AND tags LIKE '%autonomous%' ORDER BY created_at DESC LIMIT 1",
          b4.startIso,
        ),
      15000,
      2000,
    )
    const wiki = h.pollUntil(
      () =>
        h.dbGet(
          "SELECT id, title FROM wiki_sources WHERE created_at > ? AND title LIKE '学习成果%' ORDER BY created_at DESC LIMIT 1",
          b4.startIso,
        ),
      15000,
      2000,
    )
    h.assert(mem, '目标执行后未沉淀工作记忆（agent_memories）')
    h.assert(wiki, '目标执行后未沉淀 Wiki 知识页（wiki_sources 学习成果）')
    return `沉淀落库：记忆「${(mem.c || '').slice(0, 36)}…」+ Wiki「${wiki.title.slice(0, 40)}」`
  }, { fails })

  h.runCase(ev, 'EVO-B6', () => {
    if (!b4) throw new Error('SKIP: 依赖 EVO-B4 目标执行')
    const kw = pickKeyword(execGoal?.description) ?? pickKeyword(b4.text)
    h.assert(kw, '无法从目标描述/产出中抽取检索关键词')
    const r = h.okJson(h.ui(['memory', 'search', kw, '--limit', '10']), 'memory search')
    const hits = r.results ?? r.hits ?? r.memories ?? r.items ?? []
    h.assert(
      hits.some((x) => JSON.stringify(x).includes(kw)),
      `memory search「${kw}」未命中（返回 ${hits.length} 条）`,
    )
    // 复测（soft）：同类任务 → 是否不再盲从失败（行为改善信号）
    const sk = createSession('B6 复测')
    const s = sendAndWaitScore(sk, ABSENT_FILE_PROMPT)
    const improved = s.overall_score >= 0.6
    return `记忆召回命中「${kw}」（${hits.length} 条）；复测同类任务 overall=${s.overall_score.toFixed(3)}${improved ? ' ≥0.6（行为改善）' : '（仍低分，soft 未改善，证据留存）'}`
  }, { fails })

  h.runCase(ev, 'EVO-B7', () => {
    if (SKIP_LLM) throw new Error('SKIP: EVO_SKIP_LLM=1')
    // 主动规划产物落地验证：手动触发一个 planner 自建、未执行过的 at 任务
    const job = h.dbGet(
      "SELECT id, substr(task_text,1,60) t, schedule_expr FROM local_cron_jobs WHERE id LIKE 'agent-self:%' AND schedule_type = 'at' AND last_run_at IS NULL ORDER BY created_at DESC LIMIT 1",
    )
    if (!job) throw new Error('SKIP: 无未执行的 agent-self at 任务')
    const runsBefore = h.dbCount('local_cron_runs', 'job_id = ?', [job.id])
    const r = h.cronTick(job.id, { timeoutMs: 240000 })
    const runsAfter = h.dbCount('local_cron_runs', 'job_id = ?', [job.id])
    h.assert(
      runsAfter > runsBefore,
      `手动 run 后无运行记录（code=${r.code}${r.timedOut ? ' timedOut' : ''}）: ${(r.out + r.stderr).slice(0, 200)}`,
    )
    const run = h.dbGet(
      'SELECT status, substr(summary,1,100) s, error FROM local_cron_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 1',
      job.id,
    )
    h.assert(run.status === 'ok', `自建任务执行未成功：status=${run.status} error=${String(run.error).slice(0, 120)}`)
    return `自建任务 ${job.id.slice(0, 26)}「${job.t}…」（原定 ${job.schedule_expr}）手动执行成功：${(run.s || '').slice(0, 60)}`
  }, { fails })
}

// ==================== 实验 C：生命感 ====================

function runExperimentC() {
  if (!selected('C')) return
  console.log('\n── 实验 C：生命感 ──')

  h.runCase(ev, 'EVO-C1', () => {
    if (SKIP_LLM) throw new Error('SKIP: EVO_SKIP_LLM=1')
    if (!b4) throw new Error('SKIP: 依赖 EVO-B4（目标完成事件）')
    const after = h.readMood()
    h.assert(after && moodAfterSeed, `mood 读取失败: ${JSON.stringify(after)}`)
    const dV = after.valence - moodAfterSeed.valence
    const dA = after.arousal - moodAfterSeed.arousal
    h.assert(Math.abs(dV) >= 0.01 || Math.abs(dA) >= 0.01, `目标完成事件未改变 mood（Δvalence=${dV.toFixed(4)} Δarousal=${dA.toFixed(4)}）`)
    const dirOk = dV > 0 && dA < 0
    return `mood 事件驱动：valence ${moodAfterSeed.valence.toFixed(3)}→${after.valence.toFixed(3)}（Δ${dV >= 0 ? '+' : ''}${dV.toFixed(3)}）arousal ${moodAfterSeed.arousal.toFixed(3)}→${after.arousal.toFixed(3)}（Δ${dA >= 0 ? '+' : ''}${dA.toFixed(3)}）——方向${dirOk ? '符合' : '偏离'}「goal_completed: valence +0.25 / arousal -0.15」设计`
  }, { fails })

  if (!h.runCase(ev, 'EVO-C2', () => {
    if (SKIP_LLM) throw new Error('SKIP: EVO_SKIP_LLM=1')
    const due = h.dbQuery(
      "SELECT id FROM autonomous_goals WHERE agent_id = 'assistant' AND status = 'executing' AND (scheduled_for IS NULL OR scheduled_for <= ?)",
      new Date().toISOString(),
    )
    if (due.length > 0) throw new Error(`SKIP: 有 ${due.length} 个 due executing 目标，tick 会先执行目标（不擅改用户目标）`)
    const hour = new Date().getHours()
    h.okJson(
      h.ui(['autonomous', 'settings', 'set', '--data', JSON.stringify({ quietHours: [hour, (hour + 1) % 24] })]),
      '设静默时段为当前小时',
    )
    h.writeRuntimeState('autonomous.last_diary_date', h.localDateKey(new Date(Date.now() - 24 * 3600_000)))
    const diaryBefore = h.dbCount('autonomous_diaries')
    const run = runTickAndWait(180000)
    h.assert(/diary/.test(run?.summary ?? ''), `tick 应写日记，实际 summary="${run?.summary}"`)
    h.assert(h.dbCount('autonomous_diaries') > diaryBefore, `日记未落库（${diaryBefore} → ${h.dbCount('autonomous_diaries')}）`)
    const d = h.dbGet('SELECT diary_date, content FROM autonomous_diaries ORDER BY created_at DESC LIMIT 1')
    const len = (d.content ?? '').length
    h.assert(len >= 120, `日记过短（${len} 字）`)
    h.assert(!/overall_score|满意度|成功率|token/.test(d.content), '日记含指标词（违反禁令）')
    // 真实事件引用（soft）：当日事件 token（目标描述/反思片段/产出开头/最近完成目标）
    const recentGoal = h.dbGet(
      "SELECT description FROM autonomous_goals WHERE agent_id='assistant' AND status='completed' AND completed_at > ? ORDER BY completed_at DESC LIMIT 1",
      new Date(Date.now() - 2 * 3600_000).toISOString(),
    )
    const tokens = [execGoal?.description, b1?.goal?.description, reflectIssue, (b4?.text || '').slice(0, 12), recentGoal?.description]
      .filter((t) => t && String(t).trim().length >= 4)
      .map((t) => String(t).trim().slice(0, 8))
    const hitToken = tokens.find((t) => d.content.includes(t))
    // 防重：同日第二次 tick 不再写
    const msgMid = h.evolutionMessageCount()
    const run2 = runTickAndWait(120000)
    const msgAfter2 = h.evolutionMessageCount()
    h.assert(!/diary/.test(run2?.summary ?? ''), `同日第二次 tick 不应再写日记，实际 "${run2?.summary}"`)
    h.assert(msgAfter2 === msgMid, `日记消息不应增长（${msgMid} → ${msgAfter2}）`)
    const mark = h.readRuntimeState('autonomous.last_diary_date')
    h.assert(mark === h.localDateKey(), `last_diary_date 应为今日，实际 ${mark}`)
    diaryInfo = { len, hitToken, excerpt: (d.content || '').slice(0, 120) }
    return `日记 ${len} 字落库；真实事件引用${hitToken ? `命中「${hitToken}」` : '未命中（soft，证据留存人工评审）'}；二次 tick 未重写；last_diary_date 更新`
  }, { fails })) return

  h.runCase(ev, 'EVO-C3', () => {
    h.writeRuntimeState(
      'autonomous.concerns',
      JSON.stringify([
        {
          id: 'evo-e2e-c3',
          description: '上次聊到要把学习成果沉淀好',
          origin: 'evo-e2e',
          arousalWeight: 0.8,
          raisedCount: 0,
          nextRaiseAfter: Date.now() - 1000,
          status: 'open',
        },
      ]),
    )
    const sk = createSession('C3 牵挂')
    h.send(sk, '你好，今天有什么建议吗？')
    const c = h.pollUntil(() => {
      const x = readConcerns().find((i) => i.id === 'evo-e2e-c3')
      return x && x.raisedCount >= 1 ? x : null
    }, 120000, 2500)
    h.assert(c, '牵挂未在回合中被提起（等待超时）')
    h.assert(c.nextRaiseAfter > Date.now(), `nextRaiseAfter 应后移，实际 ${c.nextRaiseAfter}`)
    return `牵挂 raisedCount=${c.raisedCount}，nextRaiseAfter 后移，status=${c.status}`
  }, { fails })

  h.runCase(ev, 'EVO-C4', () => {
    const used = Number(h.readRuntimeState(`autonomous.tokens.${h.localDateKey()}`) ?? 0)
    h.assert(used > 0, `今日 token 计数应 >0（tick 执行目标/日记后），实际 ${used}`)
    return `今日 token 累计 ${used}（预算计费真实生效）`
  }, { fails })
}

// ==================== 报告 ====================

function writeFinalReport() {
  const ucbSection = ucbBefore
    ? `
## 实验 A 证据：变体 UCB 变化（本地重算，c=2.0）

| 阶段 | 排名（UCB 降序） |
|---|---|
| A1 基线（注入信号前） | ${fmtUcb(ucbBefore)} |
| A3 重算（注入 ${a2?.lowCount ?? 0} 条低分后） | ${ucbAfter ? fmtUcb(ucbAfter) : '（未执行）'} |

${a2 ? `- 劣质变体 ${short(a2.targetId)} 收到低分 overall=${a2.overalls.map((o) => o.toFixed(3)).join('/')} → trial/avg 回写 → UCB 重排\n` : ''}- 对比基线（历史 9/6-9/8）：114 次试验后最差变体仍是 argmax（未起效）；本实验 = 注入确定的负反馈信号后观察系统是否改变选择。
`
    : ''

  const healthSection = `
## 客观事实（供结论引用）

- 实验 A：${ucbBefore ? `基线 argmax=${short(ucbBefore[0].id)}（avg=${ucbBefore[0].avg.toFixed(3)}）` : '未执行'}${ucbAfter ? ` → 重算 argmax=${short(ucbAfter[0].id)}` : ''}
- 实验 B：${b1 ? `低分 ${b1.score.toFixed(3)} 触发目标「${(b1.goal.description || '').slice(0, 40)}」` : '未产出低满意目标'}${execGoal ? `；执行闭环目标 ${short(execGoal.id)}` : ''}${b4 ? `；产出「${(b4.text || '').slice(0, 50)}…」` : ''}
- 实验 C：${diaryInfo ? `日记 ${diaryInfo.len} 字，真实事件引用${diaryInfo.hitToken ? `命中「${diaryInfo.hitToken}」` : '未命中'}` : '日记未验证'}
- 基线对照（9/6-9/8 运行痕迹）：8 篇日记均为空洞独白（「今天没有特别的事」类）；18 个目标卡 pending；13 次主动消息为标题「Lumii」的系统通知。

## 副作用声明

- 不可恢复写入：prompt_variants 统计与 history、测试目标（[evo-e2e]）、reflections、agent_memories/wiki_sources 沉淀、autonomous_diaries、evolution:main、探针会话（[evo-e2e-*]，CLI 无删除能力，保留待人工处理）。
- 已恢复：enabled/settings/mood/concerns/last_diary_date/tokens/outreach/cron enabled/feedback。
- 未触碰：历史 18 个 pending 目标、用户既有会话。
`

  const summary = ev.writeReport({
    meta: {
      实验范围: ONLY || '（全部 A+B+C）',
      真实数据操作: '见副作用声明',
      环境: SKIP_LLM ? 'EVO_SKIP_LLM=1' : '真实 LLM',
    },
    extraSections: `${ucbSection}${healthSection}`,
  })
  process.exit(summary.failed > 0 ? 1 : 0)
}

// 中断保护：被外部终止（如超时 kill）时尽力恢复快照
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.error(`\n收到 ${sig}，恢复快照后退出`)
    try {
      if (snap && !NO_RESTORE) {
        h.restoreRuntimeState(snap)
        h.restoreBackgroundCronJobs(cronDisabled)
      }
    } catch {
      /* ignore */
    }
    process.exit(1)
  })
}

try {
  main()
} catch (err) {
  console.error(`\n套件异常中断: ${err.message}`)
  if (VERBOSE) console.error(err.stack)
  // 尽力恢复
  try {
    if (snap && !NO_RESTORE) {
      h.restoreRuntimeState(snap)
      h.restoreBackgroundCronJobs(cronDisabled)
    }
  } catch {
    /* ignore */
  }
  process.exit(1)
}
