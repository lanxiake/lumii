#!/usr/bin/env node
/**
 * 桌宠派发端到端验收（三期 T3.3/T3.4/T3.5 的真机链路）
 *
 * 对应：docs/plans/客户端UI/2026-09-23-宠物智能化实施计划.md
 *      「三/四期代码审查修复轮」（2026-09-24）
 *
 * ---------------------------------------------------------------------------
 * 为什么单独一个脚本
 * ---------------------------------------------------------------------------
 * 三期交付时只跑过手工验证，代码审查（15 条发现）之后主进程那条链路改动很大：
 * 实例创建挪进 try、加超时兜底、执行抛错也要落终态、日门判据从 created_at 换成
 * completed_at、回执多了 goalId、闸门拒绝也要发回执。**这些恰恰是单测覆盖不到的**——
 * 单测拿 vi.fn 替换了 `executePetGoal`，而真机上它要真的建实例、真的调模型、真的落库。
 *
 * 所以这个脚本只用**真链路**：播种一条真目标 → `cron run pet-dispatch` → 等终态 →
 * 查库查日志。不 mock 任何东西，也不直接调内部函数。
 *
 * ---------------------------------------------------------------------------
 * 判据（P1–P7）
 * ---------------------------------------------------------------------------
 * | # | 判据 | 硬/软 |
 * |---|---|---|
 * | P1 | cron job 形态：`agent_id IS NULL` / `schedule_type='every'` / enabled | 硬 |
 * | P2 | 派发 → 目标落到终态（不再停在 executing，即不再每 5 分钟被重捞） | 硬 |
 * | P3 | token 记在**宠物自己**的键上，助手键一动不动 | 硬 |
 * | P4 | 宠物会话的 agent 参与者是 `pet:<模型ID>`，不是 `main`/`assistant` | 硬 |
 * | P5 | 回执成对落库（user 目标 + assistant 产出） | 硬 |
 * | P6 | 回执冒泡（渲染层日志 `[notice] ... id=petgoal:<会话>:<goalId>`） | 硬 |
 * | P7 | 第二拍不是 `skipped: busy`（实例没泄漏） | 硬 |
 *
 * ⚠ 不测的：硬闸门拒绝那条路要先把当天配额跑满（5 次真实模型往返），代价太大；
 * 它由 `apps/windows/src/main/agent-runtime/pet-dispatch.test.ts` 的单测钉住。
 *
 * ---------------------------------------------------------------------------
 * 数据安全（CLI-TEST-SPEC §6）
 * ---------------------------------------------------------------------------
 * 只写**探针行**（`description` 带 `[pet-e2e]` 前缀的目标），跑完删掉；
 * 宠物今天的 token 账**写前快照、收尾还原**（每个探针真花 8000，日闸门只有 40000，
 * 不还原就等于用测试挤掉用户今天的宠物预算）。
 * 会话与消息**保留**——那是这次真实运行的真实产物，抹掉才是撒谎。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../../..')
const LUMII_UI = path.join(ROOT, 'apps/windows/resources/app-ui-cli/lumii-ui.mjs')
const DB_PATH = path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db')

const EVID = path.join(__dirname, 'pet-dispatch-e2e-evidence.jsonl')
const VERBOSE = process.env.PET_E2E_VERBOSE === '1'

/** 被测宠物（`pet:<模型ID>`，见 pet-core 的 pet-identity.ts） */
const PET_AGENT_ID = process.env.PET_E2E_AGENT ?? 'pet:demo_cartoon_cat'
/** 宠物自己的会话（主进程 evolutionConversationIdFor 的产物） */
const PET_SESSION = `evolution:${PET_AGENT_ID}`
/**
 * P9 用的**第二只**宠物：必须是本机**没跑过**的模型，才拿得到"全新会话"。
 *
 * 为什么非要另一只：`ensureConversationExists` 只在**新建**时写参与者，而"第一轮到底落没落库"
 * 这个判据（2026-09-24 的回归 #4）只在会话不存在时才成立 —— 拿主宠物测是测不出来的
 * （它的会话早就在了），而**删掉主宠物的会话**会把用户真实的历史一起 CASCADE 掉。
 */
const FRESH_PET_AGENT_ID = process.env.PET_E2E_FRESH_AGENT ?? 'pet:mao_pro'
const FRESH_PET_SESSION = `evolution:${FRESH_PET_AGENT_ID}`
const CRON_JOB_ID = 'pet-dispatch'
const INSTRUCTION = '__pet_dispatch__'
const PROBE_PREFIX = '[pet-e2e]'

const results = []

if (fs.existsSync(EVID)) fs.unlinkSync(EVID)

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function withDb(fn) {
  const db = new DatabaseSync(DB_PATH)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function localDateKey(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** token 账键的统一口径（`token-budget.ts` 的 tokenStateKey） */
const tokenKeyFor = (agentId) => `autonomous.tokens:${agentId}:${localDateKey()}`
/** 宠物自己的 token 账键 */
const petTokenKey = () => tokenKeyFor(PET_AGENT_ID)
/** 第二只宠物的账键——P9 真实花了钱，收尾要一起还原 */
const freshPetTokenKey = () => tokenKeyFor(FRESH_PET_AGENT_ID)
/** 助手的账键——用来证明**没有被误记** */
const assistantTokenKey = () => `autonomous.tokens:assistant:${localDateKey()}`

const LOG_DIR = path.join(os.homedir(), '.lumii', 'logs', 'app')
const LOG_PATH = path.join(LOG_DIR, `mtbot-${localDateKey()}.log`)

// ── CLI ──

function ui(args, { retries = 4, timeoutMs = 180000 } = {}) {
  let last = { code: 1, out: '', json: null }
  for (let i = 0; i <= retries; i++) {
    const r = spawnSync(process.execPath, [LUMII_UI, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      timeout: timeoutMs,
    })
    const out = (r.stdout || '') + (r.stderr || '')
    let json = null
    const trimmed = (r.stdout || '').trim()
    if (trimmed) {
      try {
        json = JSON.parse(trimmed)
      } catch {
        /* 非 JSON 保留在 out */
      }
    }
    last = { code: r.status ?? 1, out, json }
    if (json?.error !== 'rate_limited' && !/rate_limited/.test(out)) return last
    sleep(Math.min(20000, 5000 * (i + 1)))
  }
  return last
}

function okJson(r, label) {
  assert(r.code === 0, `${label} 退出码 ${r.code}: ${r.out.slice(0, 300)}`)
  assert(r.json, `${label} 未返回 JSON: ${r.out.slice(0, 300)}`)
  assert(r.json.ok !== false, `${label} 控制口拒绝: ${JSON.stringify(r.json).slice(0, 300)}`)
  return r.json
}

function record(id, status, note, extra = {}) {
  const row = { ts: new Date().toISOString(), id, status, note, ...extra }
  results.push(row)
  fs.appendFileSync(EVID, JSON.stringify(row) + '\n', 'utf8')
  const icon = status === 'PASS' ? 'PASS' : status === 'SKIP' ? 'SKIP' : 'FAIL'
  console.log(`[${id}] ${icon} — ${note}`)
  if (VERBOSE && extra.stack) console.log(extra.stack)
}

function runTest(id, name, fn) {
  try {
    const note = fn()
    record(id, 'PASS', note ? `${name}: ${note}` : name)
  } catch (err) {
    record(id, 'FAIL', `${name}: ${err.message}`, { stack: VERBOSE ? err.stack : undefined })
  }
}

// ── 读库 ──

const readState = (key) =>
  withDb((db) => db.prepare('SELECT value FROM runtime_state WHERE key = ?').get(key)?.value)

const goalRow = (id) =>
  withDb((db) =>
    db.prepare('SELECT status, completed_at, agent_id FROM autonomous_goals WHERE id = ?').get(id),
  )

const latestRun = () =>
  withDb((db) =>
    db
      .prepare(
        'SELECT summary, status, error, started_at FROM local_cron_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 1',
      )
      .get(CRON_JOB_ID),
  )

const participantsOf = (convId) =>
  withDb((db) =>
    db
      .prepare(
        "SELECT participant_id FROM conversation_participants WHERE conversation_id = ? AND participant_type = 'agent'",
      )
      .all(convId)
      .map((r) => r.participant_id),
  )

const messagesOf = (convId, limit = 10) =>
  withDb((db) => db.prepare('SELECT role, content_json FROM messages WHERE conversation_id = ? ORDER BY timestamp DESC LIMIT ?').all(convId, limit))

const conversationExists = (convId) =>
  withDb((db) => Boolean(db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(convId)))

const messageCount = (convId) =>
  withDb((db) => db.prepare('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?').get(convId).c)

/**
 * 那一轮**真实产出**的条数（`assistant_parts` 是收尾时定稿的形态）。
 *
 * ⚠ 它**不是**"新会话第一轮"那条回归的判据——实测两条路最后都是 3 条：
 * 会话不存在时 `agent:start` 跳过占位行，但收尾会走 `持久化 AI 回复（无流式占位）`
 * 兜底把正文/工具/思考写进去（2026-09-24 15:53:49 那次就是）。
 * 真正的判据是日志里那两条**机制签名**（"跳过占位行" 与 "（无流式占位）"），见 P9。
 * 这条只当佐证：真产出在不在。
 */
const roundRows = (convId) =>
  withDb((db) =>
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND content_json LIKE '%assistant_parts%'",
      )
      .get(convId).c,
  )

// ── 写库（只写探针行）──

function seedPetGoal(description, agentId = PET_AGENT_ID) {
  return withDb((db) => {
    const id = `pet-e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    db.prepare(
      `INSERT INTO autonomous_goals
       (id, agent_id, type, description, trigger_reason, status, priority, metadata,
        planned_by, scheduled_for, created_at)
       VALUES (?, ?, 'learning', ?, 'user-assigned', 'executing', 0.5, '{}', 'pet', NULL, ?)`,
    ).run(id, agentId, `${PROBE_PREFIX} ${description}`, new Date().toISOString())
    return id
  })
}

function cleanupProbeGoals(agentId = PET_AGENT_ID) {
  return withDb((db) => {
    const rows = db
      .prepare("SELECT id FROM autonomous_goals WHERE description LIKE ? AND agent_id = ?")
      .all(`${PROBE_PREFIX}%`, agentId)
    for (const r of rows) db.prepare('DELETE FROM autonomous_goals WHERE id = ?').run(r.id)
    return rows.length
  })
}

/** 把会话的 agent 参与者**强迫成老版本的形态**（只有实例 id `main`）——P8 的预置步骤 */
function forceLegacyParticipant(convId) {
  return withDb((db) => {
    db.prepare(
      "DELETE FROM conversation_participants WHERE conversation_id = ? AND participant_type = 'agent'",
    ).run(convId)
    db.prepare(
      `INSERT INTO conversation_participants (conversation_id, participant_type, participant_id, joined_at)
       VALUES (?, 'agent', 'main', ?)`,
    ).run(convId, new Date().toISOString())
  })
}

/**
 * 收尾兜底：把参与者恢复成预置之前的样子。
 *
 * 只在**修复没生效**时才需要（那时留着 `main` 就是把用户的数据留在坏状态），
 * 修复生效时它是个空操作——`ensurePetConversation` 已经写成对的了。
 */
function restoreParticipants(convId, ids) {
  return withDb((db) => {
    db.prepare(
      "DELETE FROM conversation_participants WHERE conversation_id = ? AND participant_type = 'agent'",
    ).run(convId)
    for (const id of ids) {
      db.prepare(
        `INSERT OR IGNORE INTO conversation_participants (conversation_id, participant_type, participant_id, joined_at)
         VALUES (?, 'agent', ?, ?)`,
      ).run(convId, id, new Date().toISOString())
    }
  })
}

/**
 * 删掉一条**测试自己建出来**的会话（连带消息与参与者）。
 *
 * 显式逐表删，不依赖 `ON DELETE CASCADE`：那是每条连接一个 pragma 的开关，
 * 这里不赌它开着——赌错的形态是留下孤儿消息，既不报错也看不出来。
 */
function deleteConversation(convId) {
  return withDb((db) => {
    const m = db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(convId).changes
    const p = db
      .prepare('DELETE FROM conversation_participants WHERE conversation_id = ?')
      .run(convId).changes
    db.prepare('DELETE FROM conversations WHERE id = ?').run(convId)
    return { messages: m, participants: p }
  })
}

/**
 * 把宠物今天的 token 账**还原到测试前**（写前快照 → 收尾恢复，CLI-TEST-SPEC §6）。
 *
 * 为什么连账一起还原：每个探针目标真实花掉 8000，而日闸门只有 40000。
 * 探针目标都删了、账却留着的话，用户今天的宠物被我这次测试挤掉了大半预算——
 * 那比"还原一行记账"严重得多。还原的是**这次测试的副作用**，不是用户的数据。
 */
function restoreTokenLedger(before, key = petTokenKey()) {
  return withDb((db) => {
    if (before === undefined) {
      const r = db.prepare('DELETE FROM runtime_state WHERE key = ?').run(key)
      return r.changes
    }
    db.prepare(
      `INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, before, new Date().toISOString())
    return 1
  })
}

/** 等目标落终态；返回 { status, waitedMs } */
function waitForTerminal(goalId, timeoutMs = 180000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const row = goalRow(goalId)
    if (row && row.status !== 'executing' && row.status !== 'pending' && row.status !== 'approved') {
      return { status: row.status, waitedMs: Date.now() - start }
    }
    sleep(2000)
  }
  return { status: goalRow(goalId)?.status ?? '(目标不存在)', waitedMs: Date.now() - start }
}

/**
 * 日志游标：只认**本次运行之后**写入的行。
 *
 * ⚠ 偏移量一律按**字节**算（`statSync().size` / `Buffer.subarray`）。
 * 第一版写成 `readFileSync(path,'utf8').slice(offset)`——字节偏移拿去切字符下标，
 * 而这份日志是大半中文的 4MB 文件（字节数 > 字符数），切出来直接是**空串**：
 * 于是"没冒泡"这条假失败稳定复现了两次，还差点让人去修一个没坏的东西。
 */
function logSize() {
  try {
    return fs.statSync(LOG_PATH).size
  } catch {
    return 0
  }
}

function logSince(offset) {
  try {
    return fs.readFileSync(LOG_PATH).subarray(offset).toString('utf8')
  } catch {
    return ''
  }
}

/**
 * 轮询日志直到出现匹配行；超时返回 null。
 *
 * ⚠ **必须轮询，不能读一次**。渲染层处理 IPC 是异步的：`cron run` 在主进程返回时，
 * 宠物窗那行冒泡日志可能还差十几毫秒才落盘（2026-09-24 实测 15ms）。
 * 读一次的写法会把这十几毫秒判成"没冒泡"——**假失败**，而假失败比漏测更坏：
 * 它会让人去修一个没坏的东西。
 */
function waitForLogLine(offset, predicate, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const hit = logSince(offset)
      .split('\n')
      .filter((l) => predicate(l))
    if (hit.length > 0) return hit[hit.length - 1]
    sleep(500)
  }
  return null
}

// ==================== 用例 ====================

function run() {
  console.log('桌宠派发端到端验收（真机 · 真链路 · 真模型）\n')
  assert(fs.existsSync(DB_PATH), `数据库不存在: ${DB_PATH}，请先启动应用`)
  assert(fs.existsSync(LUMII_UI), `CLI 不存在: ${LUMII_UI}`)

  const leftover = cleanupProbeGoals()
  if (leftover) console.log(`[cleanup] 清掉 ${leftover} 条残留探针目标\n`)

  const baseline = {
    petTokens: readState(petTokenKey()),
    freshPetTokens: readState(freshPetTokenKey()),
    assistantTokens: readState(assistantTokenKey()),
    logOffset: logSize(),
  }
  console.log(
    `基准：宠物账=${baseline.petTokens ?? '(无)'} 第二只=${baseline.freshPetTokens ?? '(无)'} ` +
      `助手账=${baseline.assistantTokens ?? '(无)'} 会话=${PET_SESSION}\n`,
  )

  // ── P1：cron job 形态 ──
  runTest('P1', 'cron job 形态正确（魔法指令 / agent_id=NULL / every / enabled）', () => {
    const r = okJson(ui(['cron', 'list']), 'cron list')
    const job = (r.jobs ?? []).find((j) => j.id === CRON_JOB_ID)
    assert(job, `没找到 ${CRON_JOB_ID} 这个 job（播种失败了？）`)
    assert(job.taskText === INSTRUCTION, `taskText 应为 ${INSTRUCTION}，实际 ${job.taskText}`)
    assert(job.scheduleType === 'every', `scheduleType 应为 every，实际 ${job.scheduleType}`)
    assert(job.enabled === true, 'job 应处于启用状态（用户没暂停过它）')
    assert((job.intervalMs ?? 0) > 0, 'intervalMs 应 > 0')
    return `intervalMs=${job.intervalMs} lastStatus=${job.lastStatus}`
  })

  // ── P2：派发 → 终态 ──
  let goalId = null
  let status = null
  runTest('P2', '派发执行 → 目标落到终态（不再烂在 executing 里）', () => {
    goalId = seedPetGoal('看看当前工作区根目录下有哪些文件夹，报一句')
    // `cron run` 是**同步**的：它等整轮派发走完（含真实模型往返）才返回，
    // 所以下面那次 waitForTerminal 通常几毫秒就命中——真实耗时记在这里
    const t0 = Date.now()
    okJson(ui(['cron', 'run', CRON_JOB_ID]), 'cron run pet-dispatch')
    const dispatchMs = Date.now() - t0
    const waited = waitForTerminal(goalId)
    status = waited.status
    assert(
      status === 'completed' || status === 'failed',
      `目标应落终态，实际 ${status}（派发 ${dispatchMs}ms + 等待 ${waited.waitedMs}ms）`,
    )
    // 回执那条路要求「跑完必有 completed_at」——它是下一拍闸门计数与"不再重捞"的依据
    const row = goalRow(goalId)
    assert(row.completed_at, 'completed_at 应有值（否则日门计数把它当没跑过）')
    return `status=${status}，整轮派发 ${dispatchMs}ms（含真实模型往返）`
  })

  runTest('P2b', 'run summary 是 pet-goal 而非 skipped/busy', () => {
    const run = latestRun()
    assert(run, 'local_cron_runs 没有 pet-dispatch 记录')
    assert(
      /pet-goal/.test(run.summary ?? ''),
      `summary 应为 pet-goal:…，实际 "${run.summary}"（skipped/busy 说明单飞锁没释放）`,
    )
    return `summary="${run.summary}"`
  })

  // ── P3：记账归属 ──
  runTest('P3', 'token 记在宠物自己的键上，助手账没被碰', () => {
    const petNow = Number(readState(petTokenKey()) ?? 0)
    const petBefore = Number(baseline.petTokens ?? 0)
    assert(petNow > petBefore, `${petTokenKey()} 应从 ${petBefore} 增长，实际 ${petNow}`)
    const assistantNow = readState(assistantTokenKey())
    assert(
      assistantNow === baseline.assistantTokens,
      `助手账不该变（分键的全部意义）：${baseline.assistantTokens} → ${assistantNow}`,
    )
    return `${petTokenKey()} = ${petBefore} → ${petNow}；助手账保持 ${assistantNow ?? '(无)'}`
  })

  // ── P4：会话归属 ──
  runTest('P4', '宠物会话的 agent 参与者是宠物自己（不是 main/assistant）', () => {
    const parts = participantsOf(PET_SESSION)
    assert(parts.length > 0, `会话 ${PET_SESSION} 没有 agent 参与者（会话没建？）`)
    assert(
      parts.includes(PET_AGENT_ID),
      `参与者应为 ${PET_AGENT_ID}，实际 ${JSON.stringify(parts)}——写成 main 会让宫殿把宠物的内容记在助手名下`,
    )
    assert(!parts.includes('main'), '参与者里不该有实例 id main')
    return `participants=${JSON.stringify(parts)}`
  })

  // ── P5：回执落库 ──
  runTest('P5', '回执成对落库（user 目标 + assistant 产出）', () => {
    const msgs = messagesOf(PET_SESSION, 6)
    assert(msgs.length >= 2, `宠物会话应至少有一对消息，实际 ${msgs.length} 条`)
    const assistant = msgs.find((m) => m.role === 'assistant')
    const user = msgs.find((m) => m.role === 'user')
    assert(user, '缺少 user 那条（目标描述）')
    assert(assistant, '缺少 assistant 那条（产出/失败原因）')
    const text = (() => {
      try {
        return JSON.parse(assistant.content_json)?.text ?? ''
      } catch {
        return ''
      }
    })()
    assert(text.trim().length > 0, 'assistant 那条内容为空——回执宁可含糊也不能空')
    return `产出前 60 字：「${text.replace(/\s+/g, ' ').slice(0, 60)}」`
  })

  // ── P6：渲染层冒泡 ──
  runTest('P6', '回执到达宠物窗并冒了泡（渲染层日志）', () => {
    const line = waitForLogLine(
      baseline.logOffset,
      (l) => l.includes('[notice]') && l.includes('id=petgoal:'),
    )
    if (!line) {
      const tail = logSince(baseline.logOffset)
      assert(
        false,
        `渲染层没冒泡。可能：事件没进宠物窗 / 被同会话的 turn:end 吃掉额度 / 被判重。\n` +
          `日志尾部（notice 相关）：\n${tail
            .split('\n')
            .filter((l) => l.includes('notice') || l.includes('pet:goal:result'))
            .slice(-6)
            .join('\n')}`,
      )
    }
    // 幂等键必须带 goalId——带文案哈希的话第二次失败会被当成重放永久挡掉
    assert(line.includes(goalId), `气泡 id 里应含 goalId=${goalId}：${line.slice(0, 200)}`)
    return line.replace(/^.*\[notice\]/, '[notice]').slice(0, 150)
  })

  // ── P7：无实例泄漏 ──
  runTest('P7', '第二拍不是 skipped: busy（实例在 finally 里被销毁了）', () => {
    const id2 = seedPetGoal('再确认一次：根目录第一个文件夹叫什么')
    okJson(ui(['cron', 'run', CRON_JOB_ID]), 'cron run pet-dispatch #2')
    const waited = waitForTerminal(id2)
    assert(
      waited.status === 'completed' || waited.status === 'failed',
      `第二条也应收尾，实际 ${waited.status}`,
    )
    const run = latestRun()
    assert(
      !/busy/.test(run.summary ?? ''),
      `第二次派发被单飞锁挡住了（"${run.summary}"）——实例没销毁，或者 findActivePetAgent 没清`,
    )
    // 第二条跑完 → 今天已跑 2 条，日门还远
    return `第二条 status=${waited.status} summary="${run.summary}"`
  })

  // ── P8：存量会话的归属校正（2026-09-24 复审补的盲区）──
  /**
   * P4 只证明了**新建**的会话写对了参与者。真实用户手上那条是老版本建的、写着 `main`，
   * 而 `ensureConversationExists` 在建会话时 `if (existing) return false`——新建路径根本轮不到它。
   * 所以这里**先把它强迫成老形态**，再跑一拍，看有没有被校正回来。
   */
  let legacyBefore = null
  let legacyRepaired = false
  runTest('P8', '存量会话的归属会被校正（预置 main → 跑一拍 → 变回宠物自己）', () => {
    legacyBefore = participantsOf(PET_SESSION)
    assert(legacyBefore.length > 0, `会话 ${PET_SESSION} 没有 agent 参与者（会话没建？）`)
    forceLegacyParticipant(PET_SESSION)
    assert(
      participantsOf(PET_SESSION).includes('main'),
      '预置失败：没能把参与者改成 main（这条用例就失去意义了）',
    )

    const id = seedPetGoal('确认一下：这条会话是谁在说话')
    okJson(ui(['cron', 'run', CRON_JOB_ID]), 'cron run pet-dispatch #3')
    waitForTerminal(id)

    const after = participantsOf(PET_SESSION)
    legacyRepaired = !after.includes('main') && after.includes(PET_AGENT_ID)
    assert(
      after.includes(PET_AGENT_ID),
      `参与者应被校正为 ${PET_AGENT_ID}，实际 ${JSON.stringify(after)}` +
        `——没校正的话宫殿继续把宠物的内容记在助手名下`,
    )
    assert(!after.includes('main'), `校正后不该还有实例 id main，实际 ${JSON.stringify(after)}`)
    return `预置前 ${JSON.stringify(legacyBefore)} → 强迫成 ["main"] → 跑一拍 → ${JSON.stringify(after)}`
  })

  // ── P9：全新会话的第一轮真的落库（2026-09-24 回归的判据）──
  /**
   * 会话不存在时 `agent:start` 会跳过流式占位行，`agent:end` 走同一个守卫 ——
   * 整轮的正文/思考/工具调用**一条都不落库**，只剩收尾写进去的两条回执。
   * 判据有两条，缺一不可：日志里不出现"跳过占位行"，且那一轮的真产出（`assistant_parts`）在库里。
   *
   * 用**第二只宠物**拿全新会话：删主宠物的会话会把用户真实历史一起 CASCADE 掉。
   */
  let freshConvExistedBefore = null
  runTest('P9', '全新会话的第一轮会整轮落库（不是只剩两条回执）', () => {
    freshConvExistedBefore = conversationExists(FRESH_PET_SESSION)
    assert(
      !freshConvExistedBefore,
      `会话 ${FRESH_PET_SESSION} 已经存在——这条用例要的是"第一次"新建它的那一轮，` +
        `换一只没跑过的宠物（PET_E2E_FRESH_AGENT=pet:xxx）再跑`,
    )

    const offset = logSize()
    const id = seedPetGoal('报一句你现在能看见的工作目录名', FRESH_PET_AGENT_ID)
    okJson(ui(['cron', 'run', CRON_JOB_ID]), 'cron run pet-dispatch #4')
    const waited = waitForTerminal(id)
    assert(
      waited.status === 'completed' || waited.status === 'failed',
      `第二轮目标应收尾，实际 ${waited.status}`,
    )

    /**
     * ① 正向先等"（收尾）"——**必须轮询**。
     *
     * `message:end` 的落库是异步的，可能晚于"目标落终态"（`waitForTerminal` 一返回就读，
     * 会读到一个还没刷盘的空窗口）。第一版就是这么假的：日志里明明有那行，判据说没有。
     * 这一等还兼着一个作用：**接下来那两条"不该出现"才是非空判**（否则读早了必然全 0）。
     */
    const finalized = waitForLogLine(
      offset,
      (l) => l.includes('持久化 AI 回复（收尾）') && l.includes(FRESH_PET_SESSION),
      30000,
    )
    const logs = logSince(offset).split('\n')
    assert(
      finalized,
      `没等到"持久化 AI 回复（收尾）"——要么占位行根本没建起来（会话没先建好），` +
        `要么日志没刷盘。窗口内与这只宠物相关的行：\n` +
        logs
          .filter((l) => l.includes(FRESH_PET_SESSION))
          .slice(-6)
          .join('\n'),
    )

    // ② 反向：两条坏签名一个都不该有
    const skipped = logs.filter(
      (l) => l.includes('跳过占位行：对话已不存在') && l.includes(FRESH_PET_SESSION),
    )
    assert(
      skipped.length === 0,
      `会话在第一轮跑之前就该建好，可日志里出现了 ${skipped.length} 次"跳过占位行"：\n` +
        skipped.slice(0, 2).join('\n') +
        '\n——那一轮没有流式占位（正文由兜底路径补写）',
    )
    const fallback = logs.filter(
      (l) => l.includes('持久化 AI 回复（无流式占位）') && l.includes(FRESH_PET_SESSION),
    )
    assert(
      fallback.length === 0,
      `出现了 ${fallback.length} 次"持久化 AI 回复（无流式占位）"：说明这一轮没有流式占位：\n` +
        fallback.slice(0, 2).join('\n'),
    )

    // 条数是**佐证**不是判据：上面两条路最后都是 3 条（兜底也会把正文写进去，实测过）
    const n = messageCount(FRESH_PET_SESSION)
    const rounds = roundRows(FRESH_PET_SESSION)
    assert(n >= 3, `一轮应留下 ≥3 条（user 目标 + assistant 回执 + 真产出），实际 ${n}`)
    assert(rounds >= 1, `没找到那一轮的真产出（assistant_parts），实际 ${rounds} 条`)
    return `新会话 ${FRESH_PET_SESSION}：消息 ${n} 条（真产出 ${rounds}）；跳过占位 0 次、兜底 0 次、收尾在 ${finalized.slice(0, 24)}`
  })

  const cleanup = cleanupProbeGoals() + cleanupProbeGoals(FRESH_PET_AGENT_ID)
  restoreTokenLedger(baseline.petTokens)
  restoreTokenLedger(baseline.freshPetTokens, freshPetTokenKey())
  // 修复没生效时把参与者放回原样——留着 main 就是把用户数据留在坏状态
  if (!legacyRepaired && legacyBefore) {
    restoreParticipants(PET_SESSION, legacyBefore)
    console.log(`[cleanup] ⚠ P8 的归属校正没生效，已把参与者恢复成 ${JSON.stringify(legacyBefore)}`)
  }
  // 只删**这次测试自己建出来**的那条会话（本来就在的话一律不动）
  if (freshConvExistedBefore === false && conversationExists(FRESH_PET_SESSION)) {
    const gone = deleteConversation(FRESH_PET_SESSION)
    console.log(
      `[cleanup] 删掉测试建的会话 ${FRESH_PET_SESSION}（消息 ${gone.messages} 条、参与者 ${gone.participants} 条）`,
    )
  }
  console.log(
    `\n[cleanup] 删除探针目标 ${cleanup} 条；宠物 token 账还原为 ${baseline.petTokens ?? '(无)'}` +
      `（会话与消息保留——那是这次真实运行的真实产物）`,
  )

  const pass = results.filter((r) => r.status === 'PASS').length
  const fail = results.filter((r) => r.status === 'FAIL').length
  console.log(`\n合计 ${results.length} 条：PASS ${pass} / FAIL ${fail}`)
  console.log(`证据：${EVID}`)
  if (fail > 0) process.exitCode = 1
}

run()
