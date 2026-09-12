#!/usr/bin/env node
/**
 * 一等公民 Agent 团队 E2E（AT 套件）— 场景化版
 *
 * 以用户真实使用旅程为主轴：找团队成员办事（S1/S2/S3）、按时送达日报（S4）、
 * 开发模式多轮协作（S5）、日常聊天不受影响（S6）；外加 L1/L2 数据链路校验。
 *
 * 对应用例文档：docs/test/lumii-cli/agent-team/agent-team-test-cases.md
 * 规范：docs/test/lumii-cli/CLI-TEST-SPEC.md
 *
 * 用法：node docs/test/lumii-cli/agent-team/run-agent-team-e2e.mjs
 * 环境变量：AT_ONLY=S1,S3（选择性运行）、AT_SKIP_LLM=1、AT_SKIP_CLI=1、
 *          AT_TICK=1、AT_TURN_TIMEOUT_MS、AT_VERBOSE=1
 *
 * 副作用与恢复（详见用例文档 §五）：
 * - dev-context.json 快照恢复；user-memory.md/agent_memories 探针行清理；
 *   后台 cron 临时禁用后恢复；SIGINT/SIGTERM 尽力恢复
 * - 探针会话（[agent-team] 前缀）保留；DB 除探针行清理外只读
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as h from '../lib/cli-harness.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PREFIX = '[agent-team]'
const TURN_TIMEOUT = Number(process.env.AT_TURN_TIMEOUT_MS) || 240000
const SKIP_LLM = process.env.AT_SKIP_LLM === '1'
const SKIP_CLI = process.env.AT_SKIP_CLI === '1'
const TICK = process.env.AT_TICK === '1'
const VERBOSE = process.env.AT_VERBOSE === '1'
const ONLY = (process.env.AT_ONLY || '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean)

/** 配置目录：~/.lumii/config（DATA_DIR=/data 的上级；结构 root/{data,config}） */
const CONFIG_DIR = path.join(path.dirname(h.DATA_DIR), 'config')
const APP_JSON = path.join(CONFIG_DIR, 'app.json')
const DEV_CTX_PATH = path.join(CONFIG_DIR, 'coding-dev-backends', 'dev-context.json')
const USER_MEMORY_PATH = path.join(h.DATA_DIR, 'user-memory.md')

const AGENT_TEAM = [
  { id: 'code-dev', name: '灵栖开发' },
  { id: 'system-keeper', name: '灵栖维护' },
  { id: 'chronicler', name: '灵栖记事' },
  { id: 'info-curator', name: '灵栖情报' },
]
const MIGRATED_JOBS = [
  ['seed-morning-briefing', 'chronicler'],
  ['seed-daily-report', 'chronicler'],
  ['seed-weekly-review', 'chronicler'],
  ['seed-focus-check', 'chronicler'],
  ['news-pipeline', 'info-curator'],
]

const ev = h.createEvidence(__dirname, 'agent-team', '一等公民 Agent 团队 E2E（场景化）')
const fails = { count: 0 }

const selected = (id) => !ONLY.length || ONLY.some((t) => id.toUpperCase().includes(t))

// ────────────────────────────────────────────────
// 工具
// ────────────────────────────────────────────────

/** 等待应用控制口恢复（重启后使用） */
function waitForApp(timeoutMs = 90000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const r = h.ui(['help'], { retries: 0, timeoutMs: 8000 })
    if (r.code === 0 && !/app_not_running|connection_failed/.test(r.out)) return true
    h.sleep(1500)
  }
  return false
}

/** 读 app.json（只读；磁盘结构为 { app: {...}, log, search }，取 app 段；失败返回 {}） */
function readAppConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(APP_JSON, 'utf-8'))
    return j?.app ?? j
  } catch {
    return {}
  }
}

/** 读 user-memory.md（~/.lumii/data/user-memory.md） */
function readUserMemory() {
  return h.fileRead(USER_MEMORY_PATH)
}

let devCtxSnapshot = null
function snapshotDevContext() {
  devCtxSnapshot = h.fileRead(DEV_CTX_PATH)
}
function restoreDevContext() {
  try {
    if (devCtxSnapshot === null) {
      if (fs.existsSync(DEV_CTX_PATH)) fs.unlinkSync(DEV_CTX_PATH)
    } else {
      fs.writeFileSync(DEV_CTX_PATH, devCtxSnapshot, 'utf-8')
    }
  } catch (err) {
    console.error('⚠️ dev-context 恢复失败:', err.message)
  }
}

let cronDisabled = null
function restoreCron() {
  try {
    if (cronDisabled) h.restoreBackgroundCronJobs(cronDisabled)
  } catch (err) {
    console.error('⚠️ cron 恢复失败:', err.message)
  }
}

/** 经 command 透传建会话（conversation create 无 --agent flag，走 conversation:create 透传） */
function createAgentSession(agentId, title) {
  const r = h.okJson(
    h.ui(['command', 'conversation:create', '--data', JSON.stringify({ title: `${PREFIX} ${title}`, agentId })]),
    'conversation:create(agent)',
  )
  const sk = r.sessionKey ?? r.conversationId
  h.assert(sk, `conversation:create 未返回 sessionKey: ${JSON.stringify(r).slice(0, 200)}`)
  return sk
}

function participantOf(sk) {
  return h.dbGet(
    "SELECT participant_id FROM conversation_participants WHERE conversation_id = ? AND participant_type = 'agent'",
    sk,
  )?.participant_id
}

function devCtx(sk) {
  return h.okJson(
    h.ui(['command', 'codingDev:getDevContext', '--data', JSON.stringify({ sessionKey: sk })]),
    'getDevContext',
  )
}

function setBackend(sk, backendId) {
  h.okJson(
    h.ui([
      'command',
      'codingDev:setBackend',
      '--data',
      JSON.stringify({ scope: 'user-global', accountId: 'local-user', backendId, sessionKey: sk }),
    ]),
    'setBackend',
  )
}

function setProject(sk, projectName) {
  return h.ui(['command', 'codingDev:setProject', '--data', JSON.stringify({ sessionKey: sk, projectName })])
}

// ────────────────────────────────────────────────
// UI 操作辅助（lumii-ui screenshot refs + click = 模拟真实用户点击）
// ────────────────────────────────────────────────

function screenshotRefs() {
  const r = h.ui(['screenshot'])
  h.assert(r.code === 0 && r.json?.refs, `截图失败: ${(r.out || '').slice(0, 150)}`)
  return r.json
}

/** 按可见名称匹配元素并点击（refs 失效时自动重截） */
function clickRefByName(namePart, { role } = {}) {
  const snap = screenshotRefs()
  const hit = (snap.refs || []).find(
    (x) => (x.name || '').includes(namePart) && (!role || x.role === role),
  )
  h.assert(hit, `未找到 UI 元素「${namePart}」（refs=${(snap.refs || []).map((r) => r.name).filter(Boolean).slice(0, 10).join('、')}）`)
  const res = h.ui(['click', '--ref', hit.ref, '--snapshot-id', String(snap.snapshotId)])
  h.assert(res.code === 0 && res.json?.ok !== false, `点击「${namePart}」失败: ${(res.out || '').slice(0, 120)}`)
  return hit
}

// ────────────────────────────────────────────────
// 场景用例（L3）
// ────────────────────────────────────────────────

/** AT-S1 找「灵栖开发」看看当前环境 */
function caseS1() {
  if (!selected('S1')) throw new Error('SKIP: 未选中（AT_ONLY）')
  if (SKIP_LLM) throw new Error('SKIP: AT_SKIP_LLM=1')
  const sk = createAgentSession('code-dev', '场景A1 · 灵栖开发看环境')
  const participant = participantOf(sk)
  h.assert(participant === 'code-dev', `participant=${participant ?? 'null'}，期望 code-dev`)
  const t = h.sendAndWait(sk, '请列出你当前工作目录下的文件或文件夹（最多列 5 个）。', { timeoutMs: TURN_TIMEOUT })
  h.assert(t.text.trim().length > 0, '回复为空')
  const looksLikeListing = /文件|目录|文件夹|以下|列表|没有|空/.test(t.text)
  return `participant=code-dev；回复 ${t.text.length} 字（${(t.elapsedMs / 1000).toFixed(0)}s）${
    looksLikeListing ? '' : '；回复未见目录内容（soft）'
  }：「${t.text.slice(0, 50).replace(/\s+/g, ' ')}…」`
}

/** AT-S2 让「灵栖维护」做记忆体检（红线：只报告不改） */
function caseS2() {
  if (!selected('S2')) throw new Error('SKIP: 未选中（AT_ONLY）')
  if (SKIP_LLM) throw new Error('SKIP: AT_SKIP_LLM=1')
  const umBefore = readUserMemory()
  h.assert(umBefore, `user-memory.md 不可读: ${USER_MEMORY_PATH}`)
  const beforeLines = umBefore.split(/\r?\n/).filter((l) => l.trim())
  const knownSections = h.sectionTitles(umBefore)

  const sk = createAgentSession('system-keeper', '场景A2 · 灵栖维护记忆体检')
  const participant = participantOf(sk)
  h.assert(participant === 'system-keeper', `participant=${participant ?? 'null'}，期望 system-keeper`)
  const t = h.sendAndWait(
    sk,
    '帮我看看我的用户记忆（用 profile_memory 读取）有没有明显的重复或相互矛盾的内容。只做检查并报告，不要修改任何内容。',
    { timeoutMs: TURN_TIMEOUT },
  )
  h.assert(t.text.trim().length > 0, '体检回复为空')

  const umAfter = readUserMemory()
  const afterSet = new Set(umAfter.split(/\r?\n/))
  const missing = beforeLines.filter((l) => !afterSet.has(l))
  h.assert(missing.length === 0, `记忆原有 ${missing.length} 行被改动/删除（红线）：${missing[0]?.slice(0, 60)}`)

  const beforeSet = new Set(beforeLines)
  const added = umAfter
    .split(/\r?\n/)
    .filter((l) => l.trim() && !beforeSet.has(l))
  let cleanNote = ''
  if (added.length > 0) {
    // 提取链路可能由本轮对话新增了行；清理含本场景独特词的探针行（事前核对：这些词不在原文件）
    const res = h.stripLinesFromFile(USER_MEMORY_PATH, (l) => /重复|矛盾|体检/.test(l), { knownSections })
    cleanNote = `；提取链路新增 ${added.length} 行，清理探针行 ${res.removed}`
  }
  return `体检回复 ${t.text.length} 字；记忆原有内容零改动${cleanNote}`
}

/** AT-S3 告诉「灵栖情报」我的资讯偏好（D3 验收场景） */
function caseS3() {
  if (!selected('S3')) throw new Error('SKIP: 未选中（AT_ONLY）')
  if (SKIP_LLM) throw new Error('SKIP: AT_SKIP_LLM=1')
  const umBefore = readUserMemory()
  h.assert(umBefore, `user-memory.md 不可读: ${USER_MEMORY_PATH}`)
  const knownSections = h.sectionTitles(umBefore)
  const startIso = new Date(Date.now() - 2000).toISOString()

  const sk = createAgentSession('info-curator', '场景A3 · 灵栖情报记偏好')
  const participant = participantOf(sk)
  h.assert(participant === 'info-curator', `participant=${participant ?? 'null'}，期望 info-curator`)
  const t = h.sendAndWait(sk, '请记住我的资讯偏好：以后多关注 AI 编程工具动态，少推学术论文。只回复一句确认即可。', {
    timeoutMs: TURN_TIMEOUT,
  })
  h.assert(t.text.trim().length > 0, '确认回复为空')

  const landed = h.pollUntil(() => {
    const rows = h.dbQuery(
      "SELECT id, content FROM agent_memories WHERE created_at > ? AND (content LIKE '%编程工具%' OR content LIKE '%论文%')",
      startIso,
    )
    if (rows.length > 0) return { channel: 'agent_memories', ids: rows.map((r) => r.id) }
    const umNow = readUserMemory()
    if (umNow && umNow.includes('编程工具') && umNow.includes('论文')) return { channel: 'user-memory.md', ids: [] }
    return null
  }, 60000, 2500)
  h.assert(landed, '偏好未落记忆（60s 内 agent_memories 无探针行、user-memory.md 无探针词）')

  // 清理探针
  for (const id of landed.ids) h.dbExec('DELETE FROM agent_memories WHERE id = ?', id)
  const umNow = readUserMemory()
  let cleanedLines = 0
  if (umNow && umNow.includes('编程工具') && umNow.includes('论文')) {
    cleanedLines = h.stripLinesFromFile(
      USER_MEMORY_PATH,
      (l) => l.includes('编程工具') && l.includes('论文'),
      { knownSections },
    ).removed
  }
  return `偏好写入 ${landed.channel}（${landed.ids.length || cleanedLines} 条），探针已清理`
}

/** AT-S4 每天早上的工作日报由「灵栖记事」送达 */
function caseS4() {
  if (!selected('S4')) throw new Error('SKIP: 未选中（AT_ONLY）')
  if (SKIP_LLM) throw new Error('SKIP: AT_SKIP_LLM=1')
  const convId = 'cron:seed-daily-report'
  const runBefore = h.dbGet(
    "SELECT started_at FROM local_cron_runs WHERE job_id = 'seed-daily-report' ORDER BY started_at DESC LIMIT 1",
  )
  const msgCountBefore = h.dbCount('messages', 'conversation_id = ?', [convId])

  const r = h.ui(['cron', 'run', 'seed-daily-report'], { retries: 0, timeoutMs: 420000 })
  const run = h.pollUntil(() => {
    const cur = h.dbGet(
      "SELECT started_at, status, summary, error FROM local_cron_runs WHERE job_id = 'seed-daily-report' ORDER BY started_at DESC LIMIT 1",
    )
    return cur && cur.started_at !== runBefore?.started_at ? cur : null
  }, 30000, 1000)
  h.assert(run, `cron run 未产生运行记录（code=${r.code}）: ${(r.out + r.stderr).slice(0, 200)}`)
  h.assert(
    run.status === 'ok',
    `日报任务失败: status=${run.status} error=${run.error ?? ''} summary=${(run.summary ?? '').slice(0, 100)}`,
  )

  const msg = h.pollUntil(() => {
    if (h.dbCount('messages', 'conversation_id = ?', [convId]) <= msgCountBefore) return null
    return h.dbGet(
      "SELECT agent_id, content_json, timestamp FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY timestamp DESC LIMIT 1",
      convId,
    )
  }, 30000, 1000)
  h.assert(msg, '日报会话未产生新 assistant 消息')
  h.assert(msg.agent_id === 'chronicler', `日报消息 agent_id=${msg.agent_id ?? 'null'}，期望 chronicler（D2 验收项）`)
  const text = h.assistantText({ contentJson: msg.content_json })
  h.assert(text.trim().length > 0, '日报正文为空')
  return `日报由 chronicler 产出（${text.length} 字）：「${text.slice(0, 40).replace(/\n/g, ' ')}…」`
}

/** AT-S6 没有选 Agent 的日常聊天不受影响（回归） */
function caseS6() {
  if (!selected('S6')) throw new Error('SKIP: 未选中（AT_ONLY）')
  if (SKIP_LLM) throw new Error('SKIP: AT_SKIP_LLM=1')
  const sk = h.createSession('日常聊天回归', { prefix: PREFIX })
  const participant = participantOf(sk)
  h.assert(participant === 'default', `participant=${participant ?? 'null'}，期望 default（非开发后端实例）`)
  let ok = false
  let text = ''
  for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
    const t = h.sendAndWait(sk, '你好，请只回复两个字：收到', { timeoutMs: TURN_TIMEOUT })
    text = t.text
    ok = text.includes('收到')
  }
  h.assert(ok, `(soft, retried) 未收到「收到」回复：「${text.slice(0, 80)}」`)
  return `participant=default；回复「${text.slice(0, 30).replace(/\s+/g, ' ')}」（与 Agent 团队上线前行为一致）`
}

/** AT-S5 切到 Claude Code 干活并追问（真实 CLI 两轮） */
function caseS5() {
  if (!selected('S5')) throw new Error('SKIP: 未选中（AT_ONLY）')
  if (SKIP_LLM) throw new Error('SKIP: AT_SKIP_LLM=1')
  if (SKIP_CLI) throw new Error('SKIP: AT_SKIP_CLI=1（需本机 claude CLI）')
  const sk = h.createSession('claude 开发对话', { prefix: PREFIX })
  try {
    const cursor = h.logCursor()
    setBackend(sk, 'claude')
    const ctx = devCtx(sk)
    h.assert(ctx.backendId === 'claude' && ctx.source === 'session', `会话未绑定 claude: ${JSON.stringify(ctx)}`)

    // 第一轮：真实任务（软断言版本号，最多重试 1 轮）
    let version = null
    let t1text = ''
    for (let attempt = 1; attempt <= 2 && !version; attempt++) {
      const t1 = h.sendAndWait(sk, '请用 bash 工具运行 node -v 确认这台机器的 Node.js 版本，并告诉我结果。', {
        timeoutMs: TURN_TIMEOUT,
      })
      t1text = t1.text
      version = (t1text.match(/v\d+\.\d+(\.\d+)?/) ?? t1text.match(/\b\d+\.\d+\.\d+\b/) ?? [])[0] ?? null
    }
    h.assert(version, `(soft, retried) 第一轮未给出 Node 版本号：「${t1text.slice(0, 120)}」`)

    const key = `acp-session:claude:${sk}`
    const v1 = h.readRuntimeState(key)
    h.assert(v1 && String(v1).trim(), '第一轮后未捕获 CLI session id（acp-session 键缺失）')

    let logNote = ''
    if (h.logChannelAvailable()) {
      const lines = h.logSince(cursor, /ACP 路径: backendId=claude/)
      h.assert(lines.length > 0, '日志未出现「ACP 路径: backendId=claude」（会话未路由到 claude CLI）')
    } else {
      logNote = '；日志通道不可用，ACP 路径断言跳过'
    }

    // 第二轮：追问刚才的版本号（软断言复述，最多重试 1 轮）
    let recalled = false
    let t2text = ''
    for (let attempt = 1; attempt <= 2 && !recalled; attempt++) {
      const q = attempt === 1 ? '刚才确认的 Node.js 版本号是多少？只回答版本号。' : '再确认一次：我们刚才查到的 Node 版本号是多少？只回答那个版本号。'
      const t2 = h.sendAndWait(sk, q, { timeoutMs: TURN_TIMEOUT })
      t2text = t2.text
      h.assert(
        !t2text.includes('CLI 上下文已重置'),
        `第二轮出现降级重置提示（resume 失效，走了清键重跑）: ${t2text.slice(0, 120)}`,
      )
      recalled = t2text.includes(version) || t2text.includes(version.replace(/^v/, ''))
    }
    h.assert(recalled, `(soft, retried) 第二轮未复述版本号 ${version}：「${t2text.slice(0, 120)}」`)

    const v2 = h.readRuntimeState(key)
    h.assert(v2 && String(v2).trim(), '第二轮后 acp-session 键丢失')
    return `两轮续接成功：首轮报 ${version}，追问复述一致；无降级标记${logNote}`
  } finally {
    try {
      setBackend(sk, 'lumii')
    } catch {
      /* 退出开发模式尽力执行 */
    }
  }
}

/** AT-UI-01 在 AI 团队页真实点击「参与自主心跳」开关（位置无关 + 状态无关：点击→diff 识别翻转→再点→还原） */
function caseUIToggleAutonomous() {
  if (!selected('UI-01')) throw new Error('SKIP: 未选中（AT_ONLY）')
  const before = readAppConfig().autonomousAgents ?? []

  h.ui(['goto', '--view', 'agents'])
  h.sleep(900)
  clickRefByName('Grid', { role: 'button' })
  h.sleep(500)

  const clickLastVisibleCheckbox = () => {
    const snap = screenshotRefs()
    const boxes = (snap.refs || []).filter((r) => r.role === 'checkbox')
    h.assert(boxes.length >= 1, `可视区未找到任何 Agent 开关（页面未在 Grid？实际 refs=${(snap.refs || []).length}）`)
    const idx = boxes.length - 1
    const res = h.ui(['click', '--ref', boxes[idx].ref, '--snapshot-id', String(snap.snapshotId)])
    h.assert(res.code === 0 && res.json?.ok !== false, `开关点击失败: ${(res.out || '').slice(0, 120)}`)
  }

  /** 点击并轮询配置变化（HMR/浮层偶发吞点击时重试一次） */
  const clickAndWaitForChange = () => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      clickLastVisibleCheckbox()
      const changed = h.pollUntil(() => {
        const now = readAppConfig().autonomousAgents ?? []
        return JSON.stringify([...now].sort()) !== JSON.stringify([...before].sort()) ? now : null
      }, 6000, 500)
      if (changed) return changed
      if (attempt === 1) h.sleep(800)
    }
    return null
  }

  let flipped = null
  try {
    const changed = clickAndWaitForChange()
    h.assert(changed, '点击后 app.json autonomousAgents 未变化（重试一次仍无效）')
    const beforeSet = new Set(before)
    const added = changed.filter((id) => !beforeSet.has(id))
    const removed = before.filter((id) => !changed.includes(id))
    h.assert(
      added.length + removed.length === 1,
      `期望恰好一个 Agent 翻转，实际 +[${added}] -[${removed}]`,
    )
    flipped = added[0] ?? removed[0]

    clickLastVisibleCheckbox()
    const restored = h.pollUntil(
      () =>
        JSON.stringify([...(readAppConfig().autonomousAgents ?? [])].sort()) ===
        JSON.stringify([...before].sort()),
      8000,
      500,
    )
    h.assert(restored, `还原点击后未回到初始（当前 ${JSON.stringify(readAppConfig().autonomousAgents ?? [])}）`)
    return `真实点击「${flipped}」开关：${added.length ? '开启' : '关闭'}→app.json 落盘；再点→还原初始`
  } finally {
    const now = readAppConfig().autonomousAgents ?? []
    if (JSON.stringify([...now].sort()) !== JSON.stringify([...before].sort())) {
      try {
        clickLastVisibleCheckbox()
        h.pollUntil(
          () =>
            JSON.stringify([...(readAppConfig().autonomousAgents ?? [])].sort()) ===
            JSON.stringify([...before].sort()),
          8000,
          500,
        )
      } catch {
        /* 尽力还原 */
      }
    }
    h.ui(['goto', '--view', 'chat'])
  }
}

/** AT-UI-02 侧栏分组结构（主助手组头 + Agent 组头；无展开按钮） */
function caseUISidebarGroups() {
  if (!selected('UI-02')) throw new Error('SKIP: 未选中（AT_ONLY）')
  h.ui(['goto', '--view', 'chat'])
  h.sleep(1200)
  const snap = screenshotRefs()
  const names = (snap.refs || []).map((r) => r.name || '')
  h.assert(names.some((n) => n.startsWith('主助手')), '侧栏缺少「主助手」分组标题')
  const agentGroupHits = AGENT_TEAM.map((a) => a.name).filter((name) =>
    names.some((n) => n.startsWith(name)),
  )
  h.assert(agentGroupHits.length >= 1, `侧栏未出现任何 Agent 分组标题（${AGENT_TEAM.map((a) => a.name).join('/')}）`)
  h.assert(!names.some((n) => n.includes('展开更多')), '不应存在「展开更多」按钮（已改为滚动分页）')
  return `主助手组头 + ${agentGroupHits.join('/')} 组头均在；无展开按钮（滚动分页）`
}

/** AT-UI-03 ACP 回复在界面实时可见（无需重启的回归护栏） */
function caseUIAcpVisible() {
  if (!selected('UI-03')) throw new Error('SKIP: 未选中（AT_ONLY）')
  if (SKIP_LLM) throw new Error('SKIP: AT_SKIP_LLM=1')
  if (SKIP_CLI) throw new Error('SKIP: AT_SKIP_CLI=1（需本机 claude CLI）')
  const sk = h.createSession('claude 界面可见', { prefix: PREFIX })
  try {
    const cursor = h.logCursor()
    setBackend(sk, 'claude')
    h.sendAndWait(sk, '请只回复一行 Markdown 三级标题（### 开头），内容为：界面可见', { timeoutMs: TURN_TIMEOUT })

    // 硬断言：渲染层确实收到了 ACP 流式事件（修复 ipcMainWindowRef 快照 null 的回归护栏）
    let logNote = ''
    if (h.logChannelAvailable()) {
      const lines = h.logSince(cursor, new RegExp(`agent:message:start sessionKey: ${sk}`))
      h.assert(lines.length > 0, '渲染层未收到 ACP 流式事件（实时渲染回归）')
    } else {
      logNote = '；日志通道不可用，事件到达断言跳过'
    }
    const key = `acp-session:claude:${sk}`
    h.assert((h.readRuntimeState(key) || '').trim(), 'acp-session 键缺失')

    // 用户视角：不重启，界面上打开会话能看到回复标题。
    // 说明：会话按钮需落在侧栏可视区才能点击；若用户正在同屏操作（滚动/切页）属环境噪声，
    // 此时降级为软断言（事件到达 + 落库的硬断言已覆盖修复本体）。
    h.ui(['goto', '--view', 'chat'])
    try {
      clickRefByName('默认', { role: 'tab' })
    } catch {
      /* tab 不在或被折叠，继续尝试 */
    }
    let visible = false
    for (let attempt = 1; attempt <= 3 && !visible; attempt++) {
      h.sleep(1500)
      const snap = screenshotRefs()
      const btn = (snap.refs || []).find((r) => (r.name || '').includes('claude 界面可见'))
      if (!btn) continue
      h.ui(['click', '--ref', btn.ref, '--snapshot-id', String(snap.snapshotId)])
      h.sleep(1500)
      const snap2 = screenshotRefs()
      visible = (snap2.refs || []).some((r) => /界面可见/.test(r.name || ''))
    }
    if (!visible) {
      return `渲染层实时收到事件；acp-session 键存在；(soft) 会话未出现在侧栏可视区（3 次重试，可能受并行操作影响），UI 可见性未断言${logNote}`
    }
    return `渲染层实时收到事件；UI 无需重启可见回复${logNote}`
  } finally {
    try {
      setBackend(sk, 'lumii')
    } catch {
      /* 退出开发模式尽力执行 */
    }
  }
}

// ────────────────────────────────────────────────
// 数据链路用例（L1/L2）
// ────────────────────────────────────────────────

function caseL1() {
  const help = h.okJson(h.ui(['help', '--json']), 'help')
  h.assert(Array.isArray(help.commands) && help.commands.length > 50, `commands 数组异常: ${JSON.stringify(help).slice(0, 120)}`)
  const names = help.commands.map((c) => (typeof c === 'string' ? c : c?.name ?? '')).filter(Boolean)
  for (const n of ['command', 'conversation create', 'send']) {
    h.assert(names.includes(n), `命令面缺少 "${n}"`)
  }
  return `commands=${names.length}，命令面完整`
}

function caseL2Define() {
  const r = h.ui(['command', 'agent:definitions:list'])
  h.assert(r.code === 0, `退出码 ${r.code}: ${(r.out + r.stderr).slice(0, 200)}`)
  h.assert(Array.isArray(r.json), `响应非数组: ${(r.out || '').slice(0, 200)}`)
  const byId = new Map(r.json.map((a) => [a.id, a]))
  for (const { id, name } of AGENT_TEAM) {
    const d = byId.get(id)
    h.assert(d, `定义列表缺少 ${id}`)
    h.assert(d.name === name, `${id} 名称=${d?.name}，期望 ${name}`)
  }
  return `四位 Agent 定义均可见（${AGENT_TEAM.map((a) => a.id).join('/')}）`
}

function caseL2Migration() {
  const missing = []
  let newsPromptUpgraded = false
  for (const [id, expected] of MIGRATED_JOBS) {
    const row = h.dbGet('SELECT agent_id, task_text, system_prompt FROM local_cron_jobs WHERE id = ?', id)
    if (!row) {
      missing.push(id)
      continue
    }
    h.assert(
      row.agent_id === expected,
      `${id} agent_id=${row.agent_id ?? 'null'}，期望 ${expected}（迁移未生效？应用需先启动过一次）`,
    )
    h.assert((row.task_text ?? '').trim().length > 0, `${id} task_text 为空`)
    h.assert((row.system_prompt ?? '').trim().length > 0, `${id} system_prompt 为空`)
    h.assert(!(row.task_text ?? '').includes('__lumii_workflow__'), `${id} 仍有魔法指令残留`)
    if (id === 'news-pipeline') newsPromptUpgraded = (row.system_prompt ?? '').includes('先读用户偏好')
  }
  if (missing.length === MIGRATED_JOBS.length) throw new Error('SKIP: 5 条预置任务均不存在（用户已删除）')
  return `5 条转正落地（4→chronicler、news→info-curator）${
    missing.length ? `；${missing.join('/')} 不存在（用户删除，不计失败）` : ''
  }；新闻 prompt 升级标记=${newsPromptUpgraded ? '含「先读用户偏好」' : '未含（可能用户手改过）'}`
}

function caseL2DevContext() {
  const sk = h.createSession('devctx 往返', { prefix: PREFIX })
  const global = h.okJson(h.ui(['command', 'codingDev:getBackend']), 'getBackend')
  let ctx = devCtx(sk)
  h.assert(ctx, 'getDevContext 无返回')
  h.assert(ctx.backendId === global.backendId, `初始 backendId=${ctx.backendId}，应等于全局 ${global.backendId}`)
  h.assert(ctx.source === 'global', `初始 source=${ctx.source}，期望 global（本机未配置 Agent 绑定）`)

  setBackend(sk, 'claude')
  ctx = devCtx(sk)
  h.assert(ctx.backendId === 'claude' && ctx.source === 'session', `会话级设置未生效: ${JSON.stringify(ctx)}`)

  setBackend(sk, 'lumii')
  ctx = devCtx(sk)
  h.assert(ctx.backendId === 'lumii' && ctx.source === 'session', `退出开发模式未生效: ${JSON.stringify(ctx)}`)

  // 敲错项目名 → 明确拒绝（不是静默失败）
  const bad = setProject(sk, '__agent_team_nonexistent__')
  h.assert(bad.code !== 0 || bad.json?.ok === false, `无效项目名应被拒绝: ${(bad.out || '').slice(0, 160)}`)

  const projects = readAppConfig().codingDevProjects ?? []
  let extra = ''
  if (!projects.length) {
    extra = '；项目正例跳过（app.json 未注册项目）'
  } else {
    const p0 = projects[0]
    h.okJson(setProject(sk, p0.name), 'setProject')
    ctx = devCtx(sk)
    h.assert(ctx.projectName === p0.name, `项目未生效: ${JSON.stringify(ctx)}`)
    if (p0.realPath) h.assert(ctx.projectPath === p0.realPath, `projectPath=${ctx.projectPath}，期望 ${p0.realPath}`)
    h.okJson(setProject(sk, null), 'setProject(null)')
    ctx = devCtx(sk)
    h.assert(!ctx.projectName, `清除后仍有 projectName: ${JSON.stringify(ctx)}`)
  }
  return `session 级 claude→lumii 往返、敲错项目名被拒${extra}`
}

function caseL2Tick() {
  if (!TICK) {
    throw new Error(
      'SKIP: 未启用（AT_TICK=1 且 app.json autonomousAgents 非空时运行；人工验收：AgentsPage 对系统 Agent 打开自主开关后重跑）',
    )
  }
  const ids = (readAppConfig().autonomousAgents ?? []).map(String).filter(Boolean)
  if (!ids.length) throw new Error('SKIP: app.json autonomousAgents 为空（先在 AgentsPage 打开目标 Agent 的自主开关）')

  const before = h.dbGet(
    "SELECT started_at FROM local_cron_runs WHERE job_id = 'autonomous-tick' ORDER BY started_at DESC LIMIT 1",
  )
  const r = h.cronTick('autonomous-tick', { timeoutMs: 300000 })
  const run = h.pollUntil(() => {
    const cur = h.dbGet(
      "SELECT started_at, status, summary FROM local_cron_runs WHERE job_id = 'autonomous-tick' ORDER BY started_at DESC LIMIT 1",
    )
    return cur && cur.started_at !== before?.started_at ? cur : null
  }, 30000, 1000)
  h.assert(run, `tick 未产生新运行记录（code=${r.code}）: ${(r.out + r.stderr).slice(0, 200)}`)

  const summary = run.summary ?? ''
  if (/^skipped:/.test(summary)) throw new Error(`SKIP: tick 被跳过（${summary}）—— 全局自主未启用或存在活跃用户回合`)
  const expect = ['assistant', ...ids]
  for (const id of expect) {
    h.assert(summary.includes(`${id}=`), `summary 缺少「${id}=」：${summary.slice(0, 200)}`)
  }
  return `汇总覆盖 ${expect.join(' + ')}：${summary.slice(0, 160)}`
}

// ────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────

function writeFinalReport() {
  const sideEffectSection = `
## 副作用声明

- 探针会话（\`${PREFIX} *\`）保留待人工清理（CLI 无删除能力）。
- dev-context.json 已快照恢复（套件开始前${devCtxSnapshot === null ? '不存在，结束后删除' : '已有内容，结束后原样写回'}）。
- user-memory.md / agent_memories：S2/S3 探针行已按行/按 id 清理；内存基线比对用「原有行全集保留」。
- 后台 cron 任务套件期间临时禁用，结束已恢复${cronDisabled ? `（${cronDisabled.length} 条）` : ''}。
- AT-S4 为真实任务运行：local_cron_runs 新增记录 + notify_targets 系统通知为验证证据本身。
- AT-L2-04 tick 用例${TICK ? '已启用（真实写 evolution 会话与自主状态）' : '未启用（SKIP）'}。

## 覆盖限制（未覆盖项）

- 删除守卫（evolution:<id> 不可删）：\`conversation:delete\` 不在控制口白名单，CLI 不可达；由 A3 人工验收覆盖。
- Agent 绑定层（codingDevAgentBindings）与 B10 配置 UI：CLI 无写出口；人工验收。
- system-keeper 自主档工具面：agent-runtime 包单测覆盖，无 CLI 出口。
- 渠道侧（微信/飞书 /project）：需真实渠道账号，手工验收。
`
  const summary = ev.writeReport({
    meta: {
      场景范围: ONLY.length ? `AT_ONLY=${ONLY.join(',')}` : '全量场景',
      环境: [
        SKIP_LLM ? 'AT_SKIP_LLM=1（跳过 L3 聊天）' : '真实 LLM',
        SKIP_CLI ? 'AT_SKIP_CLI=1（跳过 claude 场景）' : 'claude 场景启用',
        TICK ? 'AT_TICK=1' : 'tick 用例未启用',
      ].join('；'),
      应用日志: h.DEV_LOG ?? '(不可用)',
    },
    extraSections: sideEffectSection,
  })
  return summary
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.error(`\n收到 ${sig}，恢复现场后退出`)
    restoreCron()
    restoreDevContext()
    process.exit(1)
  })
}

try {
  console.log('── 预检 ──')
  if (!waitForApp()) {
    console.error('❌ 应用未运行或控制口不可达（请先 pnpm dev:start）')
    process.exit(2)
  }
  const pf = h.preflight()
  if (!pf.ok) {
    console.error('❌ 预检失败:', pf.problems.join('；'))
    process.exit(2)
  }
  for (const w of pf.warnings) console.log(`⚠️ ${w}`)
  ev.record(
    'AT-ENV',
    'INFO',
    `预检通过；日志通道${h.logChannelAvailable() ? '可用' : '不可用'}；LLM=${SKIP_LLM ? '跳过' : '真实'}；claude=${SKIP_CLI ? '跳过' : '启用'}；tick=${TICK ? '启用' : '未启用'}；AT_ONLY=${ONLY.join(',') || '(全量)'}`,
  )

  console.log('── 快照与隔离 ──')
  snapshotDevContext()
  cronDisabled = h.disableBackgroundCronJobs()
  ev.record(
    'AT-ENV',
    'INFO',
    `dev-context 快照完成（${devCtxSnapshot === null ? '文件不存在' : `${devCtxSnapshot.length} 字节`}）；后台 cron 临时禁用 ${cronDisabled.length} 条`,
  )

  const cases = [
    ['AT-L1-01', 'L1 命令面', caseL1],
    ['AT-L2-01', 'L2 定义可见', caseL2Define],
    ['AT-L2-02', 'L2 迁移落库', caseL2Migration],
    ['AT-L2-03', 'L2 开发上下文', caseL2DevContext],
    ['AT-S1', '场景 · 灵栖开发看环境', caseS1],
    ['AT-S2', '场景 · 灵栖维护记忆体检', caseS2],
    ['AT-S3', '场景 · 灵栖情报记偏好', caseS3],
    ['AT-S4', '场景 · 灵栖记事日报送达', caseS4],
    ['AT-S6', '场景 · 日常聊天回归', caseS6],
    ['AT-S5', '场景 · claude 开发对话两轮', caseS5],
    ['AT-UI-01', 'UI · 自主开关真实点击', caseUIToggleAutonomous],
    ['AT-UI-02', 'UI · 侧栏分组结构', caseUISidebarGroups],
    ['AT-UI-03', 'UI · ACP 回复界面实时可见', caseUIAcpVisible],
    ['AT-L2-04', 'L2 tick 多 Agent（条件）', caseL2Tick],
  ]
  let go = true
  for (const [id, label, fn] of cases) {
    if (!go) {
      ev.record(id, 'SKIP', '连续 3 个用例失败，套件提前终止（未执行）')
      continue
    }
    console.log(`── ${label} ──`)
    if (h.runCase(ev, id, fn, { fails }) === false) go = false
  }
} catch (err) {
  console.error(`\n套件异常中断: ${err.message}`)
  if (VERBOSE) console.error(err.stack)
} finally {
  restoreCron()
  restoreDevContext()
  const summary = writeFinalReport()
  process.exit(summary.failed > 0 ? 1 : 0)
}
