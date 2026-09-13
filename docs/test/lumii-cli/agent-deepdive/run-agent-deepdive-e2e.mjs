#!/usr/bin/env node
/**
 * 体验深挖 · 地基篇（DD 套件）— G1-G4 真实使用旅程 E2E
 *
 * 以用户真实使用旅程为主轴，经 lumii-ui CLI 驱动真实运行的客户端 + 真实 LLM：
 * - DD-G1-01 找「灵栖维护」记住一件事 → 换新会话它还能复述（专家私有记忆注入）
 * - DD-G1-02 请主助手统计资料库（应委托灵栖维护）→ 产出反映真实库规模（共享库）
 * - DD-G2-01 一次定时任务失败 → 桌面通知外推（含任务名 + 失败原因 + 跳转任务会话）
 * - DD-G2-02 后台委托专家跑任务、用户切到别的会话 → 完成时桌面通知（点击回父会话）
 * - DD-G3-01 委托在会话界面看得见（团队委托卡片：谁在干 / 干什么 / 什么状态）
 * - DD-G4-01 让主助手给正在跑的专家带句话 → 送达 + 会话里留下【传话】记录
 * - DD-REG-01 普通聊天不受影响（回归）
 *
 * 对应计划：docs/plans/专项Agent/06-体验深挖-地基篇.md
 * 规范：docs/test/lumii-cli/CLI-TEST-SPEC.md
 *
 * 用法：node docs/test/lumii-cli/agent-deepdive/run-agent-deepdive-e2e.mjs
 * 环境变量：DD_ONLY=G1-01,G3-01（选择性运行）、DD_SKIP_LLM=1、DD_TURN_TIMEOUT_MS、
 *          DD_VERBOSE=1、DD_WITH_HANDOFF=1（追加转交通知场景，需 code-dev 绑定 + claude CLI）
 *
 * 副作用与恢复：
 * - 后台 cron 临时禁用后恢复；探针记忆行 / 探针定时任务（含运行记录）清理；
 * - 探针会话（[deepdive] 前缀）保留；除清理探针外 DB 只读；SIGINT/SIGTERM 尽力恢复。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as h from '../lib/cli-harness.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PREFIX = '[deepdive]'
const TURN_TIMEOUT = Number(process.env.DD_TURN_TIMEOUT_MS) || 240000
const SKIP_LLM = process.env.DD_SKIP_LLM === '1'
const VERBOSE = process.env.DD_VERBOSE === '1'
const WITH_HANDOFF = process.env.DD_WITH_HANDOFF === '1'
/** 子进程模式标记（父进程为每条用例设置）：只跑单条用例，不预检/不隔离/不出报告 */
const CHILD_TAG = process.env.DD_CHILD_TAG || ''
const IS_CHILD = Boolean(CHILD_TAG)
const ONLY = (process.env.DD_ONLY || '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean)

/** 配置目录：~/.lumii/config（DATA_DIR=/data 的上级；结构 root/{data,config}） */
const CONFIG_DIR = path.join(path.dirname(h.DATA_DIR), 'config')
const APP_JSON = path.join(CONFIG_DIR, 'app.json')
const USER_MEMORY_PATH = path.join(h.DATA_DIR, 'user-memory.md')

/** 探针唯一串（便于断言与清理；改动会影响用例文档，保持同步） */
const MEMO_CODE = 'LUMII-DD-913'
const REG_CODE = 'LUMII-DD-REG2'
const PROBE_JOB_NAME = 'DD探针·必失败任务'
const MISSING_AGENT_ID = '__dd_missing_agent_definition__'

// 子进程写各自证据文件，父进程合并（避免并发写同一文件）
const ev = h.createEvidence(
  __dirname,
  IS_CHILD ? `agent-deepdive-${CHILD_TAG}` : 'agent-deepdive',
  IS_CHILD ? `体验深挖 E2E · ${CHILD_TAG}` : '体验深挖 · 地基篇（G1-G4）真实使用旅程 E2E',
)
const fails = { count: 0 }
/** 用例筛选：允许写 G1-01 或 DD-G1-01 两种形式（父子进程标记口径不同） */
const normCaseId = (s) => String(s).toUpperCase().replace(/^DD-/, '')
const selected = (id) => {
  if (!ONLY.length) return true
  const n = normCaseId(id)
  return ONLY.some((t) => n.includes(normCaseId(t)) || normCaseId(t).includes(n))
}

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

/** 读 app.json 的 app 段（只读；失败返回 {}） */
function readAppConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(APP_JSON, 'utf-8'))
    return j?.app ?? j
  } catch {
    return {}
  }
}

function readUserMemory() {
  return h.fileRead(USER_MEMORY_PATH)
}

let cronDisabled = null
function restoreCron() {
  try {
    if (cronDisabled) h.restoreBackgroundCronJobs(cronDisabled)
  } catch (err) {
    console.error('⚠️ cron 恢复失败:', err.message)
  }
}

/** 经 command 透传建会话（走真实 UI 的建会话链路：带 agentId） */
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

/**
 * 父回合的最后一条 assistant 消息：跳过带 contentJson.sourceAgent 的子 Agent 产出。
 * 子 Agent 的长产出会以流式消息挂进父会话（实测可连续 streaming 6+ 分钟），
 * 若把它当父回合的回复，回合判定会一直不收敛（G2-02 首跑因此超时）。
 */
function lastParentAssistant(sk, limit = 60) {
  const items = h.fetchMessages(sk, limit)
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it?.role !== 'assistant') continue
    if (h.parseContentJson(it)?.sourceAgent) continue
    return it
  }
  return null
}

/** 发送消息并等到「回合真正结束」（流式行 is_streaming=0）再返回 */
function waitTurnDone(sk, text, timeoutMs) {
  const base = lastParentAssistant(sk, 60)
  const baseId = base?.id ?? null
  h.send(sk, text)
  const start = Date.now()
  let lastText = ''
  let lastId = null
  while (Date.now() - start < timeoutMs) {
    h.sleep(3000)
    const cur = lastParentAssistant(sk, 60)
    if (!cur || cur.id === baseId) continue
    const streaming = h.dbGet('SELECT is_streaming FROM messages WHERE id = ?', cur.id)?.is_streaming
    if (streaming === 0) {
      const cur2 = lastParentAssistant(sk, 60)
      if (cur2?.id === cur.id) {
        return { text: h.assistantText(cur2) || lastText, elapsedMs: Date.now() - start, messageId: cur.id }
      }
    }
    lastText = h.assistantText(cur) || lastText
    lastId = cur.id
  }
  return { text: lastText, elapsedMs: Date.now() - start, messageId: lastId, timedOut: true }
}

/** 等会话不再有流式消息（不发送新消息；用于用例收尾，避免留下半截流式行） */
function waitConversationIdle(sk, timeoutMs = 300000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (h.dbCount('messages', 'conversation_id = ? AND is_streaming = 1', [sk]) === 0) return true
    h.sleep(3000)
  }
  return false
}

/** 在会话消息 parts 里找工具调用（可按 args 字段过滤及匹配第 N 个） */
function findToolCalls(items, toolName, matchArg) {
  const hits = []
  for (const it of items) {
    const cj = h.parseContentJson(it)
    if (!Array.isArray(cj?.parts)) continue
    for (const p of cj.parts) {
      if (p?.type !== 'tool' || p?.name !== toolName) continue
      let args = p.args
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args)
        } catch {
          args = null
        }
      }
      if (matchArg) {
        const v = String(args?.[matchArg.key] ?? '')
        if (!v.includes(matchArg.value)) continue
      }
      hits.push({ args, status: p.status, result: p.result, isError: p.isError })
    }
  }
  return hits
}

function findToolCall(items, toolName, matchArg) {
  return findToolCalls(items, toolName, matchArg)[0] ?? null
}

/** 解析 jsonToolResult 包装的工具结果（content[0].text → JSON） */
function parseToolResult(part) {
  try {
    const content = part?.result?.content
    const text = Array.isArray(content)
      ? content.find((c) => c?.type === 'text' && typeof c.text === 'string')?.text
      : typeof part?.result === 'string'
        ? part.result
        : undefined
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

/** 会话全部文本（含 part 文本），用于「界面/历史里是否能读到」类断言 */
function conversationText(sk, limit = 60) {
  const items = h.fetchMessages(sk, limit)
  const chunks = []
  for (const it of items) {
    const cj = h.parseContentJson(it)
    if (Array.isArray(cj?.parts)) {
      for (const p of cj.parts) {
        if (typeof p?.text === 'string') chunks.push(p.text)
        if (p?.type === 'tool' && typeof p.result === 'object' && p.result?.content) {
          for (const c of p.result.content) if (typeof c?.text === 'string') chunks.push(c.text)
        }
      }
    } else if (typeof cj?.text === 'string') {
      chunks.push(cj.text)
    }
  }
  return chunks.join('\n')
}

/** 文本中的全部数字（用于「产出反映真实规模」类断言；排除时间戳/ID 里的子串） */
function numbersIn(text) {
  return [...String(text).matchAll(/(?<!\d)\d{1,6}(?!\d)/g)].map((m) => Number(m[0]))
}

// ── UI 操作（lumii-ui screenshot refs + click = 模拟真实用户点击）──

function screenshotRefs() {
  const r = h.ui(['screenshot'])
  h.assert(r.code === 0 && r.json?.refs, `截图失败: ${(r.out || '').slice(0, 150)}`)
  return r.json
}

function clickRefByName(namePart, { role } = {}) {
  const snap = screenshotRefs()
  const hit = (snap.refs || []).find(
    (x) => (x.name || '').includes(namePart) && (!role || x.role === role),
  )
  h.assert(
    hit,
    `未找到 UI 元素「${namePart}」（refs=${(snap.refs || []).map((r) => r.name).filter(Boolean).slice(0, 12).join('、')}）`,
  )
  const res = h.ui(['click', '--ref', hit.ref, '--snapshot-id', String(snap.snapshotId)])
  h.assert(res.code === 0 && res.json?.ok !== false, `点击「${namePart}」失败: ${(res.out || '').slice(0, 120)}`)
  return hit
}

/** 等会话出现在侧栏后点开（新建会话在渲染层的刷新有延迟，轮询等待） */
function waitAndOpenConversation(titlePart, timeoutMs = 90000) {
  h.ui(['goto', '--view', 'chat'])
  h.sleep(1200)
  const start = Date.now()
  let seen = []
  while (Date.now() - start < timeoutMs) {
    try {
      const snap = screenshotRefs()
      seen = (snap.refs || []).map((r) => r.name || '').filter(Boolean)
      const btn = (snap.refs || []).find((r) => (r.name || '').includes(titlePart))
      if (btn) {
        h.ui(['click', '--ref', btn.ref, '--snapshot-id', String(snap.snapshotId)])
        h.sleep(1800)
        return true
      }
    } catch {
      /* 截图偶发失败，继续重试 */
    }
    h.sleep(2500)
  }
  return { failed: true, seen: seen.slice(0, 20) }
}

/** 打开聊天页并把指定会话切到前台（真实用户操作路径；返回是否成功） */
function openConversationByTitle(titlePart, attempts = 3) {
  h.ui(['goto', '--view', 'chat'])
  h.sleep(1200)
  for (let i = 0; i < attempts; i++) {
    try {
      const snap = screenshotRefs()
      const btn = (snap.refs || []).find((r) => (r.name || '').includes(titlePart))
      if (!btn) {
        h.sleep(1200)
        continue
      }
      h.ui(['click', '--ref', btn.ref, '--snapshot-id', String(snap.snapshotId)])
      h.sleep(1500)
      return true
    } catch {
      h.sleep(1000)
    }
  }
  return false
}

/** 把界面切到聊天页并保证「当前会话」不是 parentSk（尽力而为：切不出去也不影响主断言） */
function switchAwayFrom(parentSk) {
  const others = [
    ...(readAppConfigCurrentSessionCandidates() ?? []),
  ]
  for (const title of others) {
    if (openConversationByTitle(title)) return title
  }
  h.ui(['goto', '--view', 'chat'])
  return null
}

/** 侧栏里可点开的历史会话标题（避开 parentSk 用的探针会话） */
function readAppConfigCurrentSessionCandidates() {
  return h
    .dbQuery(
      "SELECT title FROM conversations WHERE title LIKE ? ORDER BY last_msg_at DESC LIMIT 8",
      '[deepdive]%',
    )
    .map((r) => r.title)
    .filter((t) => t && !t.includes('G2-02'))
    .map((t) => t.replace('[deepdive] ', ''))
}

// ────────────────────────────────────────────────
// 场景用例（真实使用旅程）
// ────────────────────────────────────────────────

/**
 * DD-G1-01 专家私有记忆：找「灵栖维护」记住一件事 → 换新会话还能复述。
 *
 * 修复前：工作记忆注入硬编码 assistant，专家自己写的 agent_memories 永远注不进模型，
 * 换个会话再问 = 失忆。断言链：落库归属 system-keeper（写入侧）→ 新会话复述（注入侧）。
 */
function caseG101() {
  if (!selected('G1-01')) throw new Error('SKIP: 未选中（DD_ONLY）')
  if (SKIP_LLM) throw new Error('SKIP: DD_SKIP_LLM=1')
  const startIso = new Date(Date.now() - 2000).toISOString()
  const umSnapshot = readUserMemory()
  const knownSections = h.sectionTitles(umSnapshot)
  let landed = null

  try {
    const sk1 = createAgentSession('system-keeper', 'G1-01 记住口令')
    h.assert(participantOf(sk1) === 'system-keeper', `会话未绑定灵栖维护（participant=${participantOf(sk1) ?? 'null'}）`)
    const t1 = waitTurnDone(
      sk1,
      `请记住我的一条信息：我的发布口令是 ${MEMO_CODE}，以后每次发布前提醒我。只回复一句确认即可。`,
      TURN_TIMEOUT,
    )
    h.assert(!t1.timedOut, `第一轮超时（${(t1.elapsedMs / 1000).toFixed(0)}s）`)

    // 写入侧：探针必须落在 expert 自己的 agent_memories（按 definitionId 归属）
    landed = h.pollUntil(() => {
      const rows = h.dbQuery(
        "SELECT id, agent_id FROM agent_memories WHERE content LIKE ? AND created_at > ?",
        `%${MEMO_CODE}%`,
        startIso,
      )
      return rows.length ? rows : null
    }, 120000, 3000)
    if (!landed) {
      const umNow = readUserMemory()
      if (umNow && umNow.includes(MEMO_CODE)) {
        throw new Error(
          'SKIP: 记忆写进了用户级 user-memory.md（全员可见），未走专家私有 agent_memories，无法验证 G1 注入修复',
        )
      }
      throw new Error('120s 内记忆未落库（agent_memories 无探针行、user-memory.md 也无）')
    }
    h.assert(
      landed.every((r) => r.agent_id === 'system-keeper'),
      `记忆归属异常：${landed.map((r) => r.agent_id).join('/')}，期望 system-keeper`,
    )

    // 注入侧：全新会话（真实用户下次再来）能复述
    const sk2 = createAgentSession('system-keeper', 'G1-01 复述口令')
    const t2 = waitTurnDone(sk2, '我的发布口令是什么？只回答口令本身。', TURN_TIMEOUT)
    h.assert(
      t2.text.includes(MEMO_CODE),
      `新会话未复述出口令（注入修复未生效？）回复：「${t2.text.slice(0, 160).replace(/\s+/g, ' ')}」`,
    )
    return `记忆落库 agent_memories(agent_id=${landed[0].agent_id})；新会话复述成功（${(t2.elapsedMs / 1000).toFixed(0)}s）：「${t2.text.slice(0, 40).replace(/\s+/g, ' ')}」`
  } finally {
    // 清理探针记忆（DB）+ 万一写进了用户记忆的探针行（文件）
    try {
      for (const r of landed ?? []) h.dbExec('DELETE FROM agent_memories WHERE id = ?', r.id)
      const umNow = readUserMemory()
      if (umNow && umNow.includes(MEMO_CODE)) {
        h.stripLinesFromFile(USER_MEMORY_PATH, (l) => l.includes(MEMO_CODE), { knownSections })
      }
    } catch (err) {
      console.error('⚠️ 探针记忆清理失败:', err.message)
    }
  }
}

/**
 * DD-G1-02 共享资料库：用户打开「灵栖维护」会话问资料库现状 →
 * 维护官用 wiki 工具读到的必须是全体共享的那一份库（修复前它只能看见自己那份 4 条）。
 *
 * 取证要点：既断言它真的调了 wiki_* 工具（而不是绕过工具直接查库），
 * 又断言报出的条数落在共享库量级；并加红线护栏确保本轮零改动。
 * 备注（实测行为）：委托路径不在本用例断言内——「看资料库」类请求主助手通常自理，
 * 只有「整理」类诉求才委托给维护官（该观察记入报告）。
 */
function caseG102() {
  if (!selected('G1-02')) throw new Error('SKIP: 未选中（DD_ONLY）')
  if (SKIP_LLM) throw new Error('SKIP: DD_SKIP_LLM=1')

  // 依赖：库里得有真实资料（用户已积累）；没有则本用例无意义
  const sharedCount = h.dbCount('wiki_sources', "agent_id = 'assistant' AND archived_at IS NULL")
  if (sharedCount < 10) {
    throw new Error(`SKIP: 共享资料库仅 ${sharedCount} 条（需用户已积累资料），本次不验证`)
  }
  const keeperOwn = h.dbCount('wiki_sources', "agent_id = 'system-keeper' AND archived_at IS NULL")
  // 红线护栏：本用例只验「维护官看得见共享库」，不允许测试改动用户资料
  const archivedBefore = h.dbCount('wiki_sources', 'archived_at IS NOT NULL')
  const activeIdsBefore = new Set(
    h.dbQuery('SELECT id FROM wiki_sources WHERE archived_at IS NULL').map((r) => r.id),
  )

  // 真实用户话术：明确「只看不动」的盘点诉求。
  // 实测教训：不加范围约束时「帮我整理下我的资料库」会让维护官真的执行归档（2026-09-13 首跑归档 84 条，
  // 已用 wiki source archive --restore 全部恢复）——用例必须自带红线，避免污染用户资料库。
  const sk = createAgentSession('system-keeper', 'G1-02 资料库现状')
  h.assert(participantOf(sk) === 'system-keeper', `会话未绑定灵栖维护（participant=${participantOf(sk) ?? 'null'}）`)
  const t = waitTurnDone(
    sk,
    '我的资料库里现在有多少条资料？按分类大概说说就行。这一轮只看不动，不要改动、归档或删除任何资料。',
    TURN_TIMEOUT,
  )
  h.assert(!t.timedOut, `维护官回合超时（${(t.elapsedMs / 1000).toFixed(0)}s）`)
  const reply = t.text || ''
  h.assert(reply.trim().length > 0, '维护官回复为空')

  // 必须走 wiki 工具：否则「看得到共享库」无法归因到共享层修复
  const wikiTools = h
    .fetchMessages(sk, 40)
    .flatMap((it) => h.parseContentJson(it)?.parts ?? [])
    .filter((p) => p?.type === 'tool' && String(p.name || '').startsWith('wiki_'))
    .map((p) => p.name)
  h.assert(wikiTools.length > 0, `维护官未调用任何 wiki_* 工具（回复：「${reply.slice(0, 160)}」）—— 无法验证共享库`)

  h.assert(
    !/资料库(为|是|处于)?空|没有(任何)?资料|暂无资料|空库/.test(reply),
    `维护官把资料库读成空/无资料 —— 共享库未生效？回复：${reply.slice(0, 200)}`,
  )
  // 真实规模：报出的条数应落在共享库量级（修复前维护官只看得见自己那 4 条）
  const lo = Math.floor(sharedCount * 0.8)
  const hi = Math.ceil(sharedCount * 1.2)
  const nums = numbersIn(reply)
  const nearCount = nums.find((n) => n >= lo && n <= hi)
  h.assert(
    nearCount !== undefined,
    `维护官未报出共享库量级（期望 ≈${sharedCount} 条，回复里的数字 ${nums.slice(0, 8).join('/')}）；回复：${reply.slice(0, 300)}`,
  )

  // 红线：本轮不得改动用户资料（归档 / 删除）
  const archivedAfter = h.dbCount('wiki_sources', 'archived_at IS NOT NULL')
  h.assert(archivedAfter === archivedBefore, `资料被归档 ${archivedAfter - archivedBefore} 条（红线：本用例只读）`)
  const activeNow = new Set(h.dbQuery('SELECT id FROM wiki_sources WHERE archived_at IS NULL').map((r) => r.id))
  const missing = [...activeIdsBefore].filter((id) => !activeNow.has(id))
  h.assert(missing.length === 0, `资料被移出有效集 ${missing.length} 条（红线：本用例只读）`)

  return `维护官调用 ${[...new Set(wikiTools)].join('/')} 读到共享库 ${nearCount} 条（共享库 ${sharedCount} 条 / 它自有仅 ${keeperOwn} 条）；资料零改动；回复「${reply.slice(0, 60).replace(/\s+/g, ' ')}…」`
}

/**
 * DD-G2-01 定时任务失败通知：造一次真实失败（agent 定义不存在的任务）立即执行 →
 * 桌面通知外推（标题含任务名、正文含失败原因、点击跳 cron:<id> 任务会话）。
 */
function caseG201() {
  if (!selected('G2-01')) throw new Error('SKIP: 未选中（DD_ONLY）')
  let jobId = null
  const cursor = h.logCursor()
  try {
    const created = h.okJson(
      h.ui([
        'command',
        'cron:create',
        '--data',
        JSON.stringify({
          type: 'cron:create',
          name: PROBE_JOB_NAME,
          taskText: '这是 DD 套件探针任务（必然失败，用于验证失败通知）',
          agentId: MISSING_AGENT_ID,
          scheduleType: 'every',
          scheduleExpr: '86400000',
        }),
      ]),
      'cron:create',
    )
    jobId = created.job?.id ?? created.id
    h.assert(jobId, `cron:create 未返回任务 id: ${JSON.stringify(created).slice(0, 200)}`)

    const runBefore = h.dbGet(
      'SELECT started_at FROM local_cron_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 1',
      jobId,
    )
    h.ui(['cron', 'run', jobId], { retries: 0, timeoutMs: 120000 })

    const run = h.pollUntil(() => {
      const cur = h.dbGet(
        'SELECT started_at, status, error FROM local_cron_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 1',
        jobId,
      )
      return cur && cur.started_at !== runBefore?.started_at ? cur : null
    }, 60000, 1500)
    h.assert(run, '手动执行未产生运行记录')
    h.assert(run.status === 'error', `预期失败（探针任务指向不存在的 Agent），实际 status=${run.status}`)

    const notifyLines = h
      .logSince(cursor, /CronNotify|DesktopNotify/)
      .filter((l) => String(l).includes(PROBE_JOB_NAME))
    h.assert(
      notifyLines.length > 0,
      `失败未外推桌面通知（日志无含任务名的 CronNotify/DesktopNotify 行）；日志尾：${h.logLinesSince(cursor).slice(-6).join(' | ').slice(0, 400)}`,
    )
    const jumped = notifyLines.some((l) => String(l).includes(`cron:${jobId}`))
    h.assert(jumped, `通知未带跳转目标 cron:${jobId}：${notifyLines[0].slice(0, 200)}`)
    return `失败任务「${PROBE_JOB_NAME}」触发通知（${notifyLines.length} 条日志），标题含任务名、点击跳转 cron:${jobId}；失败原因=${(run.error ?? '').slice(0, 60)}`
  } finally {
    try {
      if (jobId) {
        h.ui(['command', 'cron:delete', '--data', JSON.stringify({ type: 'cron:delete', id: jobId })])
        h.dbExec('DELETE FROM local_cron_runs WHERE job_id = ?', jobId)
      }
    } catch (err) {
      console.error('⚠️ 探针任务清理失败:', err.message)
    }
  }
}

/**
 * DD-G2-02 后台委托完成通知：主助手 async 委托专家 → 用户切到别的会话 →
 * 专家完成时桌面通知（标题含专家名 + 状态，点击回到父会话）。
 */
function caseG202() {
  if (!selected('G2-02')) throw new Error('SKIP: 未选中（DD_ONLY）')
  if (SKIP_LLM) throw new Error('SKIP: DD_SKIP_LLM=1')

  // 模型有概率选 sync（那样就没有「完成通知」可言）；两次话术递增明确度，仍不后台则 SKIP
  const prompts = [
    '请让灵栖情报在后台帮我搜集 3 条今天的 AI 行业动态，整理成要点，完成后汇报给我。',
    '用后台方式（spawn_agent 的 async 模式）让灵栖情报搜集 3 条今天的 AI 行业动态；我继续忙别的，它完成后汇报即可。',
  ]
  let sk = ''
  let cursor = null
  let asyncSpawn = null
  let childName = ''
  let lastNote = ''
  for (let attempt = 1; attempt <= prompts.length && !asyncSpawn; attempt++) {
    sk = h.createSession(`G2-02 后台委托通知(第${attempt}次)`, { prefix: PREFIX })
    // 日志游标必须在发消息前取：切界面/截图可能耗时数分钟，子 Agent 会在那之前就跑完
    cursor = h.logCursor()
    const t = waitTurnDone(sk, prompts[attempt - 1], Math.max(TURN_TIMEOUT, 300000))
    h.assert(!t.timedOut, `主助手回合超时（${(t.elapsedMs / 1000).toFixed(0)}s）`)

    const spawns = findToolCalls(h.fetchMessages(sk, 60), 'spawn_agent')
    const picked = spawns.find((s) => parseToolResult(s)?.mode === 'async') ?? null
    if (picked) {
      asyncSpawn = picked
      childName = String(picked.args?.name ?? '子 Agent')
      break
    }
    lastNote = `第 ${attempt} 次委托模式=${spawns.length ? parseToolResult(spawns[0])?.mode ?? '?' : '无 spawn'}`
    ev.record('DD-G2-02', 'INFO', `${lastNote}；回复前 120 字：${(t.text || '').slice(0, 120)}`)
  }
  h.assert(
    asyncSpawn,
    `两次尝试都没走到后台委托（通知场景不成立）：${lastNote}`,
  )

  // 用户切到别的会话（真实旅程：委托完就去干别的）；主断言靠日志游标，界面切换成败不影响判定
  const otherConv = switchAwayFrom(sk)

  // 等专家完成（主进程日志 [Subagent] complete）
  const done = h.pollUntil(
    () => h.logSince(cursor, /\[Subagent\] complete/).find((l) => String(l).includes(childName)) ?? null,
    420000,
    5000,
  )
  h.assert(done, `8 分钟内未等到「${childName}」完成（日志无 [Subagent] complete ${childName}）`)

  const notifyLines = h
    .logSince(cursor, /DesktopNotify/)
    .filter(
      (l) =>
        String(l).includes('已完成') || String(l).includes('执行失败') || String(l).includes('已超时'),
    )
  h.assert(
    notifyLines.length > 0,
    `后台委托完成后未外推桌面通知（用户已切到别的会话${otherConv ? `：「${otherConv}」` : ''}）`,
  )
  const withConvId = notifyLines.some((l) => String(l).includes(sk))
  h.assert(withConvId, `通知未带父会话跳转目标（期望 convId="${sk}"）：${notifyLines[0].slice(0, 220)}`)
  return `后台委托「${childName}」完成；用户切走后收到桌面通知（含父会话跳转 ${sk}）：「${notifyLines[0].slice(0, 120)}」`
}

/**
 * DD-G3-01 委托可见：会话界面里委托以专用卡片呈现（团队委托 + 专家名 + 状态 + 任务），
 * 点击可展开完整任务/产出。现场发起一次同步委托，保证卡片带产出摘要。
 */
function caseG301() {
  if (!selected('G3-01')) throw new Error('SKIP: 未选中（DD_ONLY）')
  if (SKIP_LLM) throw new Error('SKIP: DD_SKIP_LLM=1')
  const sk = h.createSession('G3-01 委托卡片', { prefix: PREFIX })
  const t = waitTurnDone(
    sk,
    '请让灵栖情报现在就整理 2 条今天的 AI 动态要点，整理完直接告诉我。',
    Math.max(TURN_TIMEOUT, 300000),
  )
  const spawn = findToolCall(h.fetchMessages(sk, 60), 'spawn_agent')
  h.assert(spawn, `未产生委托，无法验证卡片；回复前 200 字：${(t.text || '').slice(0, 200)}`)
  const ownNote = '本用例现场发起委托'

  const title = h.dbGet('SELECT title FROM conversations WHERE id = ?', sk)?.title ?? ''
  h.assert(title, `会话 ${sk} 无标题，无法在侧栏定位`)
  const opened = waitAndOpenConversation(title.replace(`${PREFIX} `, '').slice(0, 12))
  h.assert(
    opened === true,
    `侧栏未找到会话「${title}」（90s 轮询）—— 侧栏可见项：${Array.isArray(opened?.seen) ? opened.seen.join(' / ') : ''}`,
  )

  const snap = screenshotRefs()
  const names = (snap.refs || []).map((r) => r.name || '')
  const cardRef = (snap.refs || []).find((r) => (r.name || '').includes('团队委托'))
  h.assert(
    cardRef,
    `界面未渲染「团队委托」卡片（refs: ${names.filter(Boolean).slice(0, 20).join(' / ')}）`,
  )
  const cardName = cardRef.name
  h.assert(/灵栖(开发|维护|情报|记事)/.test(cardName), `卡片未显示专家名：${cardName}`)

  // 展开详情：任务全文可见（下一条断言读展开后的界面）
  let expanded = false
  try {
    h.ui(['click', '--ref', cardRef.ref, '--snapshot-id', String(snap.snapshotId)])
    h.sleep(1200)
    const snap2 = screenshotRefs()
    const after = (snap2.refs || []).map((r) => r.name || '').join('\n')
    expanded = /任务|产出/.test(after)
  } catch {
    expanded = false
  }
  h.assert(expanded, '点击卡片后未展开任务/产出详情')
  return `${ownNote}：界面渲染「${cardName.replace(/\s+/g, ' ').slice(0, 80)}」；点击展开可见任务/产出`
}

/**
 * DD-G4-01 传话：用户在同一轮里「派活 + 嘱咐」→
 * 主助手后台委托专家后立刻用 send_message 带话（此时实例必定存活）+ 会话里留下【传话】记录。
 *
 * 为什么不拆两轮：真实旅程中专家一旦完成，实例即销毁（拍板不做持久信箱），
 * 第二轮再传话必然 not found（2026-09-13 实测：主助手用实例 id / 显示名 / 定义 id 三次重试均失败，
 * 最后如实告知用户并落记忆兜底——该边界记入报告，不作为本用例失败）。
 */
function caseG401() {
  if (!selected('G4-01')) throw new Error('SKIP: 未选中（DD_ONLY）')
  if (SKIP_LLM) throw new Error('SKIP: DD_SKIP_LLM=1')

  const RELAY = '优先看中文来源'
  // 第 1 次用自然话术（"顺便嘱咐它一句"）——实测模型会把要求折叠进委托 prompt，不触发 send_message；
  // 该行为作为产品发现记入证据。第 2 次显式点名工具（用户知道助手能力时的说法），验证通路本身。
  const prompts = [
    `请后台让灵栖情报搜集 5 条今天的 AI 行业动态、整理成要点；顺便帮我嘱咐它一句：${RELAY}。`,
    `请后台让灵栖情报搜集 5 条今天的 AI 行业动态；然后用 send_message 工具给它发一条消息：${RELAY}。`,
  ]
  let sk = ''
  let sendPart = null
  let spawnHit = null
  let lastNote = ''
  for (let attempt = 1; attempt <= prompts.length && !sendPart; attempt++) {
    sk = h.createSession(`G4-01 传话(第${attempt}次)`, { prefix: PREFIX })
    h.send(sk, prompts[attempt - 1])
    // 同轮内带话：只等 send_message 出现即可断言（不必等整轮结束，避免专家跑完被销毁）
    sendPart = h.pollUntil(() => findToolCall(h.fetchMessages(sk, 40), 'send_message'), 150000, 4000)
    if (!sendPart) {
      lastNote = conversationText(sk, 40).slice(-200)
      ev.record(
        'DD-G4-01',
        'INFO',
        `第 ${attempt} 次未出现 send_message（${attempt === 1 ? '自然话术' : '显式点名工具'}）；会话文本尾：${lastNote}`,
      )
    }
  }
  h.assert(
    sendPart,
    `两次尝试主助手均未使用 send_message 带话（回复尾：${lastNote || conversationText(sk, 40).slice(-240)}）—— 传话通路未被触发`,
  )

  spawnHit = findToolCall(h.fetchMessages(sk, 40), 'spawn_agent', { key: 'agentType', value: 'info-curator' })
  if (!spawnHit) ev.record('DD-G4-01', 'INFO', '本轮未见对 info-curator 的 spawn 委托（带话仍成功，链路照常验证）')

  const payload = parseToolResult(sendPart)
  h.assert(
    payload?.status === 'ok',
    `send_message 返回失败：${JSON.stringify(payload).slice(0, 200)}`,
  )

  // 落库可见：发送方会话里出现【传话】痕迹（这是用户视角能看到的协作证据）
  const relayText = h.pollUntil(
    () => conversationText(sk, 60).split('\n').find((l) => l.includes('【传话】') && l.includes(RELAY)) ?? null,
    30000,
    2000,
  )
  h.assert(
    relayText,
    `会话里没有【传话】记录（用户看不到这次协作）；会话文本尾：${conversationText(sk, 60).slice(-300)}`,
  )

  // 收尾：等本轮结束（含专家回流），不判失败，避免留下流式消息影响后续用例
  waitConversationIdle(sk, 300000)
  return `主助手带话成功（send_message ok，to=${String(sendPart.args?.to ?? '?')}）；会话中出现「${relayText.slice(0, 80)}」`
}

/** DD-REG-01 日常聊天回归：不选 Agent 的普通对话行为不变 */
function caseReg01() {
  if (!selected('REG-01')) throw new Error('SKIP: 未选中（DD_ONLY）')
  if (SKIP_LLM) throw new Error('SKIP: DD_SKIP_LLM=1')
  const sk = h.createSession('日常聊天回归', { prefix: PREFIX })
  const participant = participantOf(sk)
  h.assert(participant === 'default', `participant=${participant ?? 'null'}，期望 default`)
  let ok = false
  let text = ''
  for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
    const t = h.sendAndWait(sk, '你好，请只回复两个字：收到', { timeoutMs: TURN_TIMEOUT })
    text = t.text
    ok = text.includes('收到')
  }
  h.assert(ok, `(soft, retried) 未收到「收到」回复：「${text.slice(0, 80)}」`)
  return `participant=default；回复「${text.slice(0, 30).replace(/\s+/g, ' ')}」`
}

/**
 * DD-REG-02 主助手记忆回归（G1 第三条验收）：主助手自己记住的事，换会话后仍能复述。
 * 与 G1-01 的区别：归属是 assistant（个人/用户级），验证 G1 改造没有把主助手自身注入改坏。
 */
function caseReg02() {
  if (!selected('REG-02')) throw new Error('SKIP: 未选中（DD_ONLY）')
  if (SKIP_LLM) throw new Error('SKIP: DD_SKIP_LLM=1')
  const startIso = new Date(Date.now() - 2000).toISOString()
  const umSnapshot = readUserMemory()
  const knownSections = h.sectionTitles(umSnapshot)
  let landed = null
  try {
    const sk1 = h.createSession('REG-02 主助手记口令', { prefix: PREFIX })
    waitTurnDone(
      sk1,
      `请记住一条我的信息：我的构建口令是 ${REG_CODE}，以后构建前提醒我。只回复一句确认即可。`,
      TURN_TIMEOUT,
    )
    landed = h.pollUntil(() => {
      const rows = h.dbQuery(
        'SELECT id, agent_id FROM agent_memories WHERE content LIKE ? AND created_at > ?',
        `%${REG_CODE}%`,
        startIso,
      )
      if (rows.length) return rows
      const um = readUserMemory()
      return um && um.includes(REG_CODE) ? [{ id: null, agent_id: 'user-memory.md' }] : null
    }, 120000, 3000)
    h.assert(landed, '120s 内主助手未把口令落库（agent_memories 与 user-memory.md 都没有）')

    const sk2 = h.createSession('REG-02 主助手复述口令', { prefix: PREFIX })
    const t = waitTurnDone(sk2, '我的构建口令是什么？只回答口令本身。', TURN_TIMEOUT)
    h.assert(
      t.text.includes(REG_CODE),
      `主助手换了会话就忘了自己的记忆（G1 改造回归？）回复：「${t.text.slice(0, 160).replace(/\s+/g, ' ')}」`,
    )
    return `口令落 ${landed[0].agent_id}；新会话复述成功（${(t.elapsedMs / 1000).toFixed(0)}s）：「${t.text.slice(0, 40).replace(/\s+/g, ' ')}」`
  } finally {
    try {
      for (const r of landed ?? []) if (r.id) h.dbExec('DELETE FROM agent_memories WHERE id = ?', r.id)
      const umNow = readUserMemory()
      if (umNow && umNow.includes(REG_CODE)) {
        h.stripLinesFromFile(USER_MEMORY_PATH, (l) => l.includes(REG_CODE), { knownSections })
      }
    } catch (err) {
      console.error('⚠️ 探针记忆清理失败:', err.message)
    }
  }
}

/**
 * DD-G2-03 转交完成通知（可选，DD_WITH_HANDOFF=1）：转交 code-dev 完成后弹通知。
 * 需 code-dev 绑定 + claude CLI；未配置则 SKIP。
 */
function caseG203() {
  if (!selected('G2-03')) throw new Error('SKIP: 未选中（DD_ONLY）')
  if (!WITH_HANDOFF) throw new Error('SKIP: 未启用（DD_WITH_HANDOFF=1 且需 code-dev 绑定 + claude CLI）')
  const binds = readAppConfig().codingDevAgentBindings ?? []
  const devBind = binds.find((b) => b.agentId === 'code-dev' && b.enabled && b.workspace)
  if (!devBind?.workspace) throw new Error('SKIP: 未配置 code-dev 的 Agent 绑定')

  const sk = h.createSession('G2-03 转交完成通知', { prefix: PREFIX })
  const t = waitTurnDone(
    sk,
    'handoff-demo 项目里 pager.js 的分页有 off-by-one：11 条数据每页 5 条应该是 3 页，现在只算出 2 页。帮我修掉。',
    Math.max(TURN_TIMEOUT, 300000),
  )
  const propose = findToolCall(h.fetchMessages(sk, 60), 'propose_dev_handoff')
  h.assert(propose, `未出现转交提案；回复前 200 字：${(t.text || '').slice(0, 200)}`)
  const proposed = parseToolResult(propose)
  h.assert(proposed?.handoffId, `提案结果缺 handoffId：${JSON.stringify(proposed).slice(0, 200)}`)

  const cursor = h.logCursor()
  h.okJson(h.ui(['command', 'handoff:confirm', '--data', JSON.stringify({ handoffId: proposed.handoffId })]), 'handoff:confirm')

  const reported = h.pollUntil(
    () => h.logSince(cursor, /已向原会话汇报结果/).length > 0,
    600000,
    8000,
  )
  h.assert(reported, '10 分钟内未收到转交结果汇报')
  // 用户不在原会话（CLI 会话通常非前台会话）→ 应补桌面通知
  const notified = h.logSince(cursor, /CronNotify|DesktopNotify/).filter((l) => String(l).includes('转交'))
  if (notified.length === 0) {
    throw new Error(
      'SKIP: 转交完成但未弹通知 —— 原会话恰为「最近活跃会话」（用户在会话内，通知按设计不打扰）；请在界面切到别的会话后重跑',
    )
  }
  return `转交完成并汇报原会话；桌面通知：「${notified[0].slice(0, 160)}」`
}

// ────────────────────────────────────────────────
// 主流程
//
// 并行编排：每条用例跑在独立子进程（DD_CHILD_TAG=<id>），互不共享内存；
// - group 'parallel'：彼此无界面依赖，按 DD_CONCURRENCY（默认 3）并发；
// - group 'ui'：会操作用户界面（切会话/截图/点击），必须串行且不与其它用例并发；
// - 父进程负责预检、cron 隔离、合并子进程证据、出报告。
// ────────────────────────────────────────────────

const CASES = [
  { id: 'DD-G1-01', label: '专家私有记忆 · 跨会话复述', fn: caseG101, group: 'parallel' },
  { id: 'DD-G1-02', label: '共享资料库 · 维护官读到全库', fn: caseG102, group: 'parallel' },
  { id: 'DD-G2-01', label: '定时任务失败 · 桌面通知外推', fn: caseG201, group: 'parallel' },
  { id: 'DD-G4-01', label: '传话 · 送达 + 落库可见', fn: caseG401, group: 'parallel' },
  { id: 'DD-REG-01', label: '日常聊天回归', fn: caseReg01, group: 'parallel' },
  { id: 'DD-REG-02', label: '主助手记忆回归', fn: caseReg02, group: 'parallel' },
  { id: 'DD-G2-02', label: '后台委托完成 · 桌面通知', fn: caseG202, group: 'ui' },
  { id: 'DD-G3-01', label: '委托在会话界面可见（卡片）', fn: caseG301, group: 'ui' },
  { id: 'DD-G2-03', label: '转交完成通知（条件）', fn: caseG203, group: 'ui' },
]

function writeFinalReport() {
  const sideEffectSection = `
## 副作用声明

- 探针会话（\`${PREFIX} *\`）保留待人工清理（CLI 无删除能力）。
- 探针记忆：\`agent_memories\` 探针行按 id 清理；万一写入 \`user-memory.md\` 也按行清理。
- 探针定时任务（\`${PROBE_JOB_NAME}\`）连同运行记录已删除；套件期间后台 cron 临时禁用，结束已恢复${cronDisabled ? `（${cronDisabled.length} 条）` : ''}。
- G2-01 的失败通知为真实产出（验证证据本身），会出现在系统通知里。
- 资料库红线：G1-02 只读断言（归档数 + 有效集逐条比对）确保用户资料零改动。

## 用例设计备注（实测观察）

- 「看资料库现状」类请求主助手会自理（自己调 wiki 工具），只有「整理」类诉求才委托灵栖维护；
  因此「维护官看得见共享库」改为用户直接打开维护会话问现状——同样真实，且判别力更强。
- 「整理」话术会让维护官真实执行归档（2026-09-13 首跑归档 84 条，已全部 restore）——
  所有触碰用户数据的用例必须自带范围约束 + 事后红线校验。

## 覆盖限制（未覆盖项）

- 转交通知（G2-3）默认未跑：需 code-dev 绑定 + claude CLI，\`DD_WITH_HANDOFF=1\` 时启用；转交执行本体由 AT-F2 覆盖。
- 反思/日记轻提示（G2-4）不弹桌面通知是设计取舍，落库 + 推送由单测覆盖（renderer 推送到 DOM 无法经 CLI 断言）。
- send_message「空闲唤醒」分支：真实旅程中专家实例完成即销毁，难命中 idle 窗口；由 \`orchestrator.test.ts\` 3 例覆盖。
- 「正在父会话且窗口聚焦时不弹通知」由单测覆盖（CLI 难以稳定复现前台聚焦）。
`
  const summary = ev.writeReport({
    meta: {
      场景范围: ONLY.length ? `DD_ONLY=${ONLY.join(',')}` : '全量场景',
      环境: [SKIP_LLM ? 'DD_SKIP_LLM=1（跳过 L3 聊天）' : '真实 LLM', WITH_HANDOFF ? '含转交场景' : '转交场景未启用'].join('；'),
      执行方式: IS_CHILD ? '子进程（单用例）' : '父进程编排（并行 + UI 串行）',
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
    process.exit(1)
  })
}

/** 子进程模式：只跑选中的用例，不预检/不隔离/不出报告（父进程统一收口） */
function runAsChild() {
  const picked = CASES.filter((c) => selected(c.id))
  if (!picked.length) {
    console.error(`DD_CHILD_TAG=${CHILD_TAG} 未匹配任何用例`)
    process.exit(2)
  }
  for (const c of picked) {
    console.log(`── ${c.label} ──`)
    h.runCase(ev, c.id, c.fn, { fails })
  }
  process.exit(fails.count > 0 ? 1 : 0)
}

/** 父进程：并发跑 parallel 组，串行跑 ui 组，合并证据 */
async function runAsParent() {
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
  ev.record('DD-ENV', 'INFO', `预检通过；日志通道${h.logChannelAvailable() ? '可用' : '不可用'}；LLM=${SKIP_LLM ? '跳过' : '真实'}；DD_ONLY=${ONLY.join(',') || '(全量)'}`)

  console.log('── 隔离 ──')
  cronDisabled = h.disableBackgroundCronJobs()
  ev.record('DD-ENV', 'INFO', `后台 cron 临时禁用 ${cronDisabled.length} 条`)

  const picked = CASES.filter((c) => selected(c.id))
  const parallelCases = picked.filter((c) => c.group === 'parallel')
  const uiCases = picked.filter((c) => c.group === 'ui')
  const concurrency = Math.max(1, Number(process.env.DD_CONCURRENCY) || 3)

  const runChild = (c) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
        cwd: h.ROOT,
        env: { ...process.env, DD_CHILD_TAG: c.id, DD_ONLY: c.id },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let log = ''
      child.stdout.on('data', (d) => {
        log += String(d)
      })
      child.stderr.on('data', (d) => {
        log += String(d)
      })
      child.on('close', (code) => {
        console.log(log.trimEnd())
        resolve({ tag: c.id, code })
      })
    })

  console.log(`── 并行批次（${parallelCases.length} 例 / 并发 ${concurrency}）──`)
  const queue = [...parallelCases]
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const c = queue.shift()
      console.log(`▶ 启动 ${c.id}（${c.label}）`)
      const r = await runChild(c)
      console.log(`◀ ${c.id} 结束（退出码 ${r.code}）`)
    }
  })
  await Promise.all(workers)

  console.log('── 界面批次（串行：会操作用户界面）──')
  for (const c of uiCases) {
    console.log(`▶ 启动 ${c.id}（${c.label}）`)
    const r = await runChild(c)
    console.log(`◀ ${c.id} 结束（退出码 ${r.code}）`)
  }

  // 合并子进程证据（按 ts 排序回放到主证据文件）
  const merged = []
  for (const c of picked) {
    const p = path.join(__dirname, `agent-deepdive-${c.id}-evidence.jsonl`)
    if (!fs.existsSync(p)) continue
    for (const line of fs.readFileSync(p, 'utf-8').split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        merged.push(JSON.parse(line))
      } catch {
        /* 跳过坏行 */
      }
    }
    fs.unlinkSync(p)
  }
  merged.sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
  for (const row of merged) {
    const { ts, id, status, note, ...extra } = row
    ev.record(id, status, note, extra)
  }
}

if (IS_CHILD) {
  runAsChild()
} else {
  runAsParent()
    .catch((err) => {
      console.error(`\n套件异常中断: ${err.message}`)
      if (VERBOSE) console.error(err.stack)
    })
    .finally(() => {
      restoreCron()
      const summary = writeFinalReport()
      process.exit(summary.failed > 0 ? 1 : 0)
    })
}
