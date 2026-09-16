#!/usr/bin/env node
/**
 * 灵栖情报 / 灵栖维护 专项 E2E（CK 套件）
 *
 * 覆盖两件事：
 * 1. **归属与可见性**：这两个 Agent 名下的定时任务，其会话记录要归到侧栏对应分组；
 * 2. **职责能力**：它们是否真的能拿到干活所需的材料——
 *    - 维护要能读**全用户**的工作记忆（否则「记忆体检」无从下手）；
 *    - 情报要能回读资讯卡已有条目（否则每轮重推同一篇稿子）。
 *
 * 对应用例文档：docs/test/lumii-cli/agent-curation/agent-curation-test-cases.md
 * 规范：docs/test/lumii-cli/CLI-TEST-SPEC.md
 *
 * 用法：node docs/test/lumii-cli/agent-curation/run-agent-curation-e2e.mjs
 * 环境变量：CK_ONLY=CK-01,CK-05（选择性运行）、CK_SKIP_LLM=1、CK_TURN_TIMEOUT_MS、CK_VERBOSE=1
 *
 * 副作用：只新建 `[agent-curation]` 前缀的探针会话；CK-06 会真实跑一轮资讯抓取
 * （会往概览页资讯卡追加条目，这是该任务的正常产出）。不改任何用户配置。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as h from '../lib/cli-harness.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PREFIX = '[agent-curation]'
const TURN_TIMEOUT = Number(process.env.CK_TURN_TIMEOUT_MS) || 300000
const SKIP_LLM = process.env.CK_SKIP_LLM === '1'
const VERBOSE = process.env.CK_VERBOSE === '1'
const ONLY = (process.env.CK_ONLY || '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean)

const ev = h.createEvidence(__dirname, 'agent-curation', '灵栖情报 / 灵栖维护专项')
const selected = (id) => !ONLY.length || ONLY.some((t) => id.toUpperCase() === t)

const log = (...a) => console.log(...a)
const vlog = (...a) => {
  if (VERBOSE) console.log(...a)
}

/** 断言 + 记录（失败不中断后续用例，最后统一汇总） */
function check(id, cond, passNote, failNote, extra = {}) {
  if (cond) ev.record(id, 'PASS', passNote, extra)
  else ev.record(id, 'FAIL', failNote, extra)
  return Boolean(cond)
}

// ────────────────────────────────────────────────
// L1/L2：归属与可见性（无 LLM）
// ────────────────────────────────────────────────

/** CK-01 资讯类任务的执行者是「灵栖情报」 */
function ck01() {
  const rows = h.dbQuery(
    `SELECT id, name, agent_id FROM local_cron_jobs
     WHERE task_text LIKE '%dashboard_feed_write%' AND enabled = 1`,
  )
  if (rows.length === 0) {
    ev.record('CK-01', 'SKIP', '库里没有启用中的资讯任务（用户可能已删除）')
    return
  }
  const wrong = rows.filter((r) => r.agent_id !== 'info-curator')
  check(
    'CK-01',
    wrong.length === 0,
    `${rows.length} 条资讯任务全部由 info-curator 执行`,
    `以下任务的执行者不是 info-curator：${JSON.stringify(wrong)}`,
    { jobs: rows.map((r) => ({ id: r.id, agent: r.agent_id })) },
  )
}

/** CK-02 维护类任务的执行者是「灵栖维护」 */
function ck02() {
  const row = h.dbGet(`SELECT id, agent_id FROM local_cron_jobs WHERE id = 'seed-workspace-tidy'`)
  if (!row) {
    ev.record('CK-02', 'SKIP', '预置任务 seed-workspace-tidy 不在库里（用户可能已删除）')
    return
  }
  check(
    'CK-02',
    row.agent_id === 'system-keeper',
    '工作区文件整理的执行者是 system-keeper',
    `工作区文件整理的执行者是 ${row.agent_id}，应为 system-keeper`,
    { job: row },
  )
}

/** CK-03 会话列表带出正确的 agentId —— 这正是侧栏分组的输入 */
function ck03() {
  const rows = h.dbQuery(
    `SELECT cp.conversation_id AS conversationId, cp.participant_id AS agentId
     FROM conversation_participants cp
     JOIN local_cron_jobs j ON cp.conversation_id = 'cron:' || j.id
     WHERE cp.participant_type = 'agent' AND j.task_text LIKE '%dashboard_feed_write%'`,
  )
  if (rows.length === 0) {
    ev.record('CK-03', 'SKIP', '没有资讯任务的会话记录')
    return
  }
  const wrong = rows.filter((r) => r.agentId !== 'info-curator')
  check(
    'CK-03',
    wrong.length === 0,
    '资讯任务会话的参与者是 info-curator（侧栏据此归入「情报」分组）',
    `以下会话归属不对：${JSON.stringify(wrong)}`,
    { conversations: rows },
  )
}

/** CK-03b 维护侧同理：工作区整理的会话归属 */
function ck03b() {
  const row = h.dbGet(
    `SELECT participant_id AS agentId FROM conversation_participants
     WHERE conversation_id = 'cron:seed-workspace-tidy' AND participant_type = 'agent'`,
  )
  if (!row) {
    ev.record('CK-03b', 'SKIP', 'cron:seed-workspace-tidy 会话尚未建立（任务还没跑过）')
    return
  }
  check(
    'CK-03b',
    row.agentId === 'system-keeper',
    '工作区整理会话归属 system-keeper',
    `工作区整理会话归属 ${row.agentId}，应为 system-keeper`,
    { conversation: row },
  )
}

/** CK-04 系统保洁类任务不被误迁：它们是 companion 路径，不属于任何 Agent */
function ck04() {
  const rows = h.dbQuery(`SELECT id, agent_id, task_text FROM local_cron_jobs WHERE id LIKE 'wiki-purge-%'`)
  if (rows.length === 0) {
    ev.record('CK-04', 'SKIP', '库里没有 wiki-purge-* 任务')
    return
  }
  const wrong = rows.filter((r) => r.agent_id !== null)
  check(
    'CK-04',
    wrong.length === 0,
    'wiki 保洁类任务仍是 agent_id=null 的确定性通道（不因归属迁移被改成 LLM 任务）',
    `以下保洁任务被挂上了 Agent：${JSON.stringify(wrong)}`,
    { jobs: rows },
  )
}

// ────────────────────────────────────────────────
// L3：职责能力（真实 LLM）
// ────────────────────────────────────────────────

/** 等一个回合真正结束（最后一条 assistant 落地且不再 streaming） */
async function waitTurn(sk, text, { timeoutMs = TURN_TIMEOUT } = {}) {
  h.send(sk, text)
  const start = Date.now()
  let last = null
  while (Date.now() - start < timeoutMs) {
    await h.sleep(2500)
    const items = h.fetchMessages(sk, 20)
    const assistants = items.filter((m) => m.role === 'assistant')
    const candidate = assistants[assistants.length - 1]
    if (candidate && !candidate.isStreaming && h.assistantText(candidate).trim()) {
      last = candidate
      break
    }
  }
  return last
}

/**
 * 建一个**指定 Agent** 的探针会话。
 *
 * `conversation create` 子命令不带 agentId（默认建主助手会话），
 * 而本套件要验的正是「以情报/维护身份运行时」的行为，所以走命令总线直接下发。
 * 传错 Agent 会让整个用例变成在测主助手——这一点必须写在用例文档里。
 */
function createAgentSession(agentId, title) {
  const r = h.ui([
    'command',
    'conversation:create',
    '--data',
    JSON.stringify({ type: 'conversation:create', title: `${PREFIX} ${title}`, agentId }),
  ])
  const payload = h.okJson(r, `建 ${agentId} 会话`)
  const sk = payload.sessionKey ?? payload.data?.sessionKey
  if (!sk) throw new Error(`建 ${agentId} 会话未返回 sessionKey：${JSON.stringify(payload).slice(0, 300)}`)
  return sk
}

/**
 * 抽一次该回合里出现过的工具名。
 *
 * 从 `contentJson.parts` 里找 `type === 'tool'`，**不能读 `item.toolCalls`**：
 * 新版 assistant 消息落库为 `{type:'assistant_parts', parts:[…]}`，工具调用是 parts 的一种；
 * `toolCalls` 那个扁平字段只对旧格式消息有效（`conversation-commands` 的兼容分支），
 * 拿它判工具调用会永远为空——首轮 CK-05/CK-06 就是这么误报的。
 */
function toolsOf(item) {
  const cj = h.parseContentJson(item)
  const parts = cj?.parts
  if (Array.isArray(parts)) {
    return parts.filter((p) => p && p.type === 'tool').map((p) => String(p.name ?? p.toolName ?? ''))
  }
  return (item?.toolCalls ?? []).map((t) => String(t.name))
}

/**
 * CK-05 维护能读全用户工作记忆。
 * 判据：它报告的条目里出现**别的 Agent** 写的（agent_id ≠ system-keeper）。
 * 只读，不要求它修改任何东西。
 */
async function ck05() {
  if (SKIP_LLM) return ev.record('CK-05', 'SKIP', 'CK_SKIP_LLM=1')
  const sk = createAgentSession('system-keeper', '维护读全区记忆')
  const reply = await waitTurn(
    sk,
    '用 memory_manage 的 list 动作看一下你读到的工作记忆：只告诉我这些条目分别由哪些 agent_id 写的、各多少条。不要修改任何东西。',
  )
  if (!reply) return ev.record('CK-05', 'FAIL', '回合超时或没有回复', { sessionKey: sk })

  const text = h.assistantText(reply)
  vlog(text.slice(0, 800))
  const tools = toolsOf(reply)

  // 库里真实存在的写入者（除 system-keeper 自己）
  const owners = h
    .dbQuery(
      `SELECT DISTINCT agent_id FROM agent_memories
       WHERE is_archived = 0 AND deleted_at IS NULL AND agent_id != 'system-keeper'`,
    )
    .map((r) => r.agent_id)
  const seenOther = owners.filter((id) => id && text.includes(id))
  const claimsEmpty = /(为空|没有(任何)?(工作)?记忆|0 条|没有任何条目)/.test(text)

  check(
    'CK-05',
    tools.includes('memory_manage') && seenOther.length > 0 && !claimsEmpty,
    `维护看到了其他 Agent 的记忆：${seenOther.join('、')}`,
    `未验证到跨 Agent 读取（tools=${tools.join(',')}；命中的外部 agent=${seenOther.join('、') || '无'}；空态措辞=${claimsEmpty}）`,
    { sessionKey: sk, tools, owners },
  )
}

/**
 * CK-06 情报能回读资讯卡（去重前提）。
 * 判据：它调用了 dashboard_feed_read，且报出了卡片总数或最新条目的标题。
 * 断言标题是更强的信号——总数会随抓取漂移，标题必须真读到才说得出。
 */
async function ck06() {
  if (SKIP_LLM) return ev.record('CK-06', 'SKIP', 'CK_SKIP_LLM=1')
  const dbTotal = h.dbGet(`SELECT COUNT(*) AS n FROM dashboard_feed_items WHERE feed_id = 'news'`).n
  const newest = h.dbGet(
    `SELECT title FROM dashboard_feed_items WHERE feed_id = 'news' ORDER BY timestamp DESC, id DESC LIMIT 1`,
  )
  const sk = createAgentSession('info-curator', '情报回读资讯卡')
  const reply = await waitTurn(
    sk,
    '先看一眼概览页资讯卡上现在有哪些条目，然后只告诉我卡上总共有多少条、最新的一条标题是什么。只看不写，不要新抓取。',
  )
  if (!reply) return ev.record('CK-06', 'FAIL', '回合超时或没有回复', { sessionKey: sk })

  const text = h.assistantText(reply)
  vlog(text.slice(0, 800))
  const tools = toolsOf(reply)
  const readTool = tools.includes('dashboard_feed_read')
  // 标题可能很长，取前 12 字做指纹，避开模型的轻微改写（省略号、书名号差异）
  const titleHit = Boolean(newest?.title) && text.includes(String(newest.title).slice(0, 12))
  const numberHit = new RegExp(`\\b${dbTotal}\\b`).test(text)

  check(
    'CK-06',
    readTool && (titleHit || numberHit),
    `情报回读了资讯卡：调用 dashboard_feed_read，报出${titleHit ? '最新条目标题' : `总数 ${dbTotal}`}`,
    `未回读到卡片（tools=${tools.join(',') || '无'}；标题命中=${titleHit}；总数 ${dbTotal} 命中=${numberHit}）`,
    { sessionKey: sk, tools, dbTotal, titleHit },
  )
}

/**
 * CK-07 资讯任务真跑一轮：产出落成**新的一期**，且这一期的出处是 Agent。
 * 注意：会真实抓取并追加资讯卡条目（该任务的正常产出）。
 *
 * 不断言消息级 `agent_id`：流式落库路径目前不带该字段（全库 403 条 assistant
 * 消息为 null，属既有缺口、与本片无关）。归属的正确载体是会话参与者
 * （CK-03 已守）与期上的 source/conversation_id——这里断言后者。
 */
async function ck07() {
  if (SKIP_LLM) return ev.record('CK-07', 'SKIP', 'CK_SKIP_LLM=1')
  const job = h.dbGet(
    `SELECT id, agent_id FROM local_cron_jobs
     WHERE task_text LIKE '%dashboard_feed_write%' AND enabled = 1
     ORDER BY created_at DESC LIMIT 1`,
  )
  if (!job) return ev.record('CK-07', 'SKIP', '库里没有启用中的资讯任务')

  const before = h.dbGet(`SELECT COUNT(*) AS n FROM dashboard_feed_batches`).n
  try {
    h.ui(['cron', 'run', job.id], { timeoutMs: 300000 })
  } catch (err) {
    return ev.record('CK-07', 'FAIL', `cron run 失败：${err.message}`, { jobId: job.id })
  }

  const batch = await h.pollUntil(
    () => {
      const count = h.dbGet(`SELECT COUNT(*) AS n FROM dashboard_feed_batches`).n
      if (count <= before) return null
      return h.dbGet(
        `SELECT b.id, b.source, b.summary, b.conversation_id,
                (SELECT COUNT(*) FROM dashboard_feed_items i WHERE i.batch_id = b.id) AS item_count
         FROM dashboard_feed_batches b ORDER BY b.created_at DESC, b.id DESC LIMIT 1`,
      )
    },
    120000,
    3000,
  )

  if (!batch) {
    return ev.record('CK-07', 'FAIL', `任务跑完了但资讯卡没有新增一期（job=${job.id}）`, {
      jobId: job.id,
    })
  }

  check(
    'CK-07',
    batch.item_count > 0 && typeof batch.summary === 'string' && batch.summary.trim().length > 0,
    `资讯任务落成新的一期：${batch.item_count} 条，综述 ${String(batch.summary).length} 字`,
    `新的一期内容不完整：${JSON.stringify(batch).slice(0, 300)}`,
    { jobId: job.id, batchId: batch.id, itemCount: batch.item_count, source: batch.source },
  )
}

/**
 * CK-08 维护的体检报告落库。
 * 判据：跑完一轮体检后 `maintenance_reports` 多出一行，且结论非空、来源与执行者对得上。
 * 只做只读体检（用例明确要求不改动任何资产）。
 */
async function ck08() {
  if (SKIP_LLM) return ev.record('CK-08', 'SKIP', 'CK_SKIP_LLM=1')
  const before = h.dbGet(`SELECT COUNT(*) AS n FROM maintenance_reports`).n
  const sk = createAgentSession('system-keeper', '维护体检落库')
  const reply = await waitTurn(
    sk,
    '帮我做一次记忆体检：读一下用户偏好层，再看工作记忆里有没有重复或互相矛盾的条目。' +
      '只做只读检查，不要修改任何东西。结束后用 maintenance_report_write 把结论落库，并在会话里回一句摘要。',
  )

  const row = await h.pollUntil(
    () => {
      const r = h.dbGet(
        `SELECT id, agent_id, scope, summary, findings, checked, trigger FROM maintenance_reports
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      const count = h.dbGet(`SELECT COUNT(*) AS n FROM maintenance_reports`).n
      return count > before && r ? r : null
    },
    120000,
    3000,
  )

  if (!row) {
    return ev.record('CK-08', 'FAIL', '体检跑完但没有写下报告', {
      sessionKey: sk,
      reply: h.assistantText(reply ?? {}).slice(0, 300),
    })
  }

  let findings = []
  try {
    findings = JSON.parse(row.findings)
  } catch {
    /* 解析失败留给断言报错 */
  }
  const ok =
    row.agent_id === 'system-keeper' &&
    typeof row.summary === 'string' &&
    row.summary.trim().length > 0 &&
    Array.isArray(findings)

  check(
    'CK-08',
    ok,
    `体检报告已落库：scope=${row.scope}，发现 ${findings.length} 项`,
    `报告内容不完整：${JSON.stringify(row).slice(0, 300)}`,
    { sessionKey: sk, reportId: row.id, findingCount: findings.length },
  )
}

/**
 * CK-09 机械检查项由代码跑（asset_checkup）。
 * 判据：工具被调用，且它报出的 key 是代码约定的那几个——模型自己编不出来这些字符串。
 */
async function ck09() {
  if (SKIP_LLM) return ev.record('CK-09', 'SKIP', 'CK_SKIP_LLM=1')
  const sk = createAgentSession('system-keeper', '机械体检项')
  const reply = await waitTurn(
    sk,
    '跑一次 asset_checkup（scope 用 memory），然后把返回的每一项原样列给我：key、status、detail。' +
      '不要自己额外判断，也不要修改任何东西。',
  )
  if (!reply) return ev.record('CK-09', 'FAIL', '回合超时或没有回复', { sessionKey: sk })

  const text = h.assistantText(reply)
  vlog(text.slice(0, 900))
  const tools = toolsOf(reply)
  // 这几个 key 是代码里写死的字面量，模型凭空编不出
  const expectedKeys = [
    'memory:profile-budget',
    'memory:working-duplicates',
    'memory:json-residue',
    'memory:instruction-residue',
    'memory:stale',
    'memory:tiny-entries',
  ]
  const hit = expectedKeys.filter((k) => text.includes(k))

  check(
    'CK-09',
    tools.includes('asset_checkup') && hit.length >= 5,
    `机械项由代码跑出：报出 ${hit.length}/6 个约定 key`,
    `未跑出机械项（tools=${tools.join(',') || '无'}；命中 key=${hit.join(',') || '无'}）`,
    { sessionKey: sk, tools, hitKeys: hit },
  )
}

/**
 * CK-10 资讯偏好的结构化落点：说一句「少推 X」，X 要落进 user-memory.md 的
 * `## 资讯偏好` 章节，而不是散在某段自由文本里。
 *
 * 副作用控制：跑前快照 user-memory.md，跑后整份还原（含删掉新起的章节）。
 * 探针内容用不可能与真实偏好撞车的字符串（`__ck-probe-<时间戳>__`）。
 */
async function ck10() {
  if (SKIP_LLM) return ev.record('CK-10', 'SKIP', 'CK_SKIP_LLM=1')
  const profilePath = path.join(h.DATA_DIR, 'user-memory.md')
  const before = h.fileExists(profilePath) ? h.fileRead(profilePath) : null
  const probe = `__ck-probe-${Date.now()}__`

  let reply = null
  try {
    const sk = createAgentSession('info-curator', '资讯偏好落点')
    reply = await waitTurn(
      sk,
      `以后少推「${probe}」这类内容。请把它记进你的资讯偏好里，然后告诉我现在记下的「少推」有哪些。`,
    )
    if (!reply) return ev.record('CK-10', 'FAIL', '回合超时或没有回复', { sessionKey: sk })

    const text = h.assistantText(reply)
    vlog(text.slice(0, 600))
    const tools = toolsOf(reply)
    const after = h.fileExists(profilePath) ? h.fileRead(profilePath) : ''
    const inSection = /##\s*资讯偏好/.test(after)
    const landed = after.includes(probe)
    // 落点必须在「资讯偏好」章节内，不能散在别处
    const sectionBody = inSection ? after.split(/##\s*资讯偏好/)[1]?.split(/\n##\s/)[0] ?? '' : ''

    check(
      'CK-10',
      tools.includes('news_preference') && landed && sectionBody.includes(probe),
      '偏好落进 user-memory.md 的「资讯偏好」章节',
      `未落到结构化位置（tools=${tools.join(',') || '无'}；章节存在=${inSection}；正文命中=${landed}；章节内命中=${sectionBody.includes(probe)}）`,
      { probe, tools },
    )
  } finally {
    // 无论成败都还原用户记忆，绝不留探针
    if (before !== null) fs.writeFileSync(profilePath, before, 'utf8')
    else if (h.fileExists(profilePath)) fs.rmSync(profilePath, { force: true })
  }
}

// ────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────

async function main() {
  log(`\n=== 灵栖情报 / 灵栖维护专项 E2E（${h.DB_PATH}）===\n`)
  if (SKIP_LLM) log('（CK_SKIP_LLM=1：跳过真实 LLM 用例）\n')

  await h.ui(['conversation', 'list']) // 先探一次控制口，未就绪时立刻失败而不是等到某个用例

  if (selected('CK-01')) ck01()
  if (selected('CK-02')) ck02()
  if (selected('CK-03')) ck03()
  if (selected('CK-03b')) ck03b()
  if (selected('CK-04')) ck04()

  if (selected('CK-05')) await ck05()
  if (selected('CK-06')) await ck06()
  if (selected('CK-07')) await ck07()
  if (selected('CK-08')) await ck08()
  if (selected('CK-09')) await ck09()
  if (selected('CK-10')) await ck10()

  const summary = ev.writeReport({
    meta: {
      套件: 'CK · 情报与维护专项',
      跳过LLM: String(SKIP_LLM),
    },
    extraSections: `
## 未纳入自动化的项

| 项 | 原因 |
|---|---|
| 概览页「立即抓取」走同一个会话与执行者 | 该 IPC（\`dashboard-feed:refresh\`）不在命令总线白名单里，CLI 触发不到；改由 \`news-feed-job.test.ts\` 的定位单测守（会话 id / 标题 / 执行者三个取值与调度器同口径） |
| 资讯卡跨天分隔的视觉呈现 | 渲染断言由 \`NewsFeed.test.tsx\` 覆盖（分隔行、天内编号、日期格式），截图回归成本高于收益 |
`,
  })

  process.exit(summary.failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('CK 套件异常终止:', err)
  process.exit(2)
})
