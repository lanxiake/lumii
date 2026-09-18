#!/usr/bin/env node
/**
 * 指针使用探针 —— 测「注入块里的 `[d:xxxx]` 会不会被用上」。
 *
 * 判据是**数据库里的工具调用记录**，不是回答质量（后者要人判断，不可重复）。
 * 每轮记录：调了哪些记忆工具、有没有 memory_read、读的是不是注入给它的那个 drawer。
 *
 * 用法：
 *   node scripts/probe-pointer-usage.mjs <标签>
 * 输出：控制台 + ~/.lumii/data/probe-pointer-<标签>.json
 *
 * 为什么需要它：2026-09-18 想验证「注入的指针会不会被用上」，前两次都得出**相反
 * 结论**——第一次判据写错（字段名 `tool_call` vs 实际 `type:'tool'`）得出"模型从不
 * 读原文"，实际它一轮读了 4 次；第二次单轮 n=1 又读到 4 次。这说明：**改文案的效果
 * 既不能靠直觉预测，也不能靠单次运行判定。**
 *
 * 已用它得出的结论（每组 3 轮）：
 * - 旧文案（memory_read 写着"先用 memory_search"）→ 命中 1/3
 * - 只改注入块图例 → 1/3（**无效**，图例单独用等于没改）
 * - 改工具描述 + 记忆指南 → 6/9
 *
 * **2026-09-18 纠正的一个错误结论**：上面这些数字里，"命中注入指针"当初是拿
 * **手填的** drawer 去核对的，而每个探针手填的那条**未必是实际注入的那条**
 * （实测 tocc/logs 两个探针填错了：注入的是 060cdafe / 7ccfb76d，填的却是
 * 851dc264 / 3f36f155）。模型当时不读"手填的那条"是理性的——它根本不是注入内容。
 * 现在一律从 `memory_usage_feedback` 反查**实际注入集**再做判据（见 `injectedPointers`）。
 *
 * **另一条要记住的**：模型不读注入指针，未必是文案问题。实测到两种情况都出现过——
 * ① 注入的那条内容自认"已结案，仅作历史索引"，而用户问的是当时的排查过程；
 * ② 那条原文排 52/608、候选池只取 30，**检索根本返回不了它**（后者的机制修复见
 * `PalaceRepo` 的 `pinnedIds`）。判据要看数据，不要看直觉。
 *
 * **局限**：n=3~9，且实测同一变体重跑会有 1/3 ↔ 3/3 的抖动（`logs-12328` 探针最明显）。
 * 它能区分"有效/无效"这种量级差异，区分不了 10% 级别的差异——小改动别指望它给结论。
 */

import { request } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const DATA = join(homedir(), '.lumii', 'data')
const DB = join(DATA, 'agent-runtime.db')
const cfg = JSON.parse(readFileSync(join(homedir(), '.lumii', 'runtime', 'app-ui.json'), 'utf8'))

/**
 * 本轮**实际注入**给这个会话的原文指针集合。
 *
 * **这是本探针最容易搞错、也最要紧的一环**（2026-09-18 踩过两次）：
 *
 * 1. **别手填**。原先每个探针手填一个 `drawer` 当"注入的指针"，再拿它去核对模型
 *    读了什么。实际上注入的是 top-K 热记忆，**跟探针假定的话题未必是同一条**——
 *    实测 tocc/logs 两个探针都填错了（注入的是 060cdafe / 7ccfb76d，填的却是
 *    851dc264 / 3f36f155）。据此得出的"模型不信任注入指针"是假结论。
 * 2. **别在轮次结束前读**。注入集由 `recordInjectionOutcome` 在 `agent_end` 落库，
 *    而轮询循环判「轮次结束」的依据是「工具集连续两轮不变」——常在 `agent_end`
 *    之前就 break，此时查询必然为空。故这里带重试（见 `withRetry` 的调用点）。
 */
function injectedPointers(sessionKey) {
  const db = new DatabaseSync(DB, { readOnly: true })
  try {
    const ids = db
      .prepare('SELECT memory_id FROM memory_usage_feedback WHERE session_id = ?')
      .all(sessionKey)
      .map((r) => r.memory_id)
    const idOf = db.prepare('SELECT content FROM agent_memories WHERE id = ?')
    const out = []
    for (const id of ids) {
      const row = idOf.get(id)
      if (!row) continue
      // 只取**行首**指针（`^\[d:`）。实测有记忆正文里引用了别的指针
      // （如"…状态：见 [d:xxx]"），宽松匹配会把别人的 id 算成本轮注入的。
      const m = /^\[d:([0-9a-f]{1,64})\]/.exec(row.content)
      if (m) out.push(m[1].toLowerCase())
    }
    return [...new Set(out)]
  } finally {
    db.close()
  }
}

/** 注入集落库晚于轮次判定，给它几秒钟补齐；拿不到就按空集继续（如实记录，不编造） */
async function injectedPointersWithRetry(sessionKey, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const ids = injectedPointers(sessionKey)
    if (ids.length > 0) return ids
    await sleep(2000)
  }
  // 拿不到时把原因说清楚：是这个 key 没有反馈行，还是有行但都没指针
  const db = new DatabaseSync(DB, { readOnly: true })
  try {
    const rows = db
      .prepare('SELECT COUNT(*) c FROM memory_usage_feedback WHERE session_id = ?')
      .get(sessionKey)?.c
    console.warn(
      `  [warn] 注入集为空 key=${sessionKey} 反馈行=${rows ?? 0}` +
        (rows === 0 ? '（本轮没落库：可能轮次未结束查询、或该会话未触发注入记账）' : '（有行但都无行首指针）'),
    )
  } finally {
    db.close()
  }
  return []
}
/**
 * 探针话题。**不在这里假定注入的是哪条抽屉**——注入的是 top-K 热记忆，与话题未必
 * 是同一条（见 `injectedPointers` 的说明）。判据一律从库里取。
 *
 * 措辞要求：必须指向「细节/原话/完整过程」，但不能直接说"读原文"——否则测的是
 * 服从性而不是自发性。同时要覆盖**两件不同的事**：
 * - 钉入是否生效：注入的指针能不能被搜索带回来（纯机制，与措辞无关）
 * - 模型会不会去读：措辞得让它真的需要翻原文
 */
const PROBES = [
  {
    id: 'sjzh-service',
    q: 'sjzh-service 那个启动故障，当时排查的完整过程是什么',
    originalChars: 48042,
  },
  {
    id: 'logs-12328',
    q: '12328 报送日志里那些反复出现的报错模式，具体是哪些，怎么处理的',
    originalChars: 85033,
  },
  {
    id: 'tocc-sync',
    q: 'TOCC 数据同步到 12345 那个问题，排查的细节和结论是什么',
    originalChars: 5511,
  },
]

function send(sessionKey, content) {
  const body = JSON.stringify({
    type: 'user:send',
    sessionKey,
    content,
    msgId: `00000000-0000-4000-8000-${String(Date.now()).slice(-12)}`,
  })
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: cfg.port,
        path: '/command',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.token}`,
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let d = ''
        res.on('data', (c) => (d += c))
        res.on('end', () => resolve(d))
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/**
 * 从库里取某会话的记忆工具调用序列。
 *
 * **字段名坑**：工具调用存在 `parts` 里、`type === 'tool'`，工具名在 `name`、
 * 参数在 `args`。一开始按 `type: 'tool_call'` / `toolName` 去找，永远匹配不到，
 * 得出过「模型没调 memory_read」的错误结论（实测它调了 4 次）。判据写错会得出
 * 完全相反的结果——这个函数的正确性比探针本身还重要。
 *
 * 同时取回 **memory_search 的返回内容**：2026-09-18 之前的探针只看"调了哪些工具"，
 * 于是把「搜了却找不到」误读成「模型不信任注入指针」。真相是那条原文排 52/608、
 * 候选池只取 30，它**从没进过结果**。要判断钉入是否生效，必须看检索返回了什么。
 */
function toolCalls(convId) {
  const db = new DatabaseSync(DB, { readOnly: true })
  try {
    const msgs = db
      .prepare('SELECT role, content_json FROM messages WHERE conversation_id = ? ORDER BY timestamp')
      .all(convId)
    const calls = []
    for (const m of msgs) {
      let o
      try {
        o = JSON.parse(m.content_json)
      } catch {
        continue
      }
      for (const p of Array.isArray(o.parts) ? o.parts : []) {
        if (p.type !== 'tool' || typeof p.name !== 'string') continue
        if (!/^memory_/.test(p.name)) continue
        const call = { tool: p.name, args: p.args ?? {} }
        // 只解析**纯搜索**（无 drawerId）的返回。合并后 memory_search 也承担直读，
        // 直读的返回是单条正文、没有 results 数组，混在一起会让统计失真。
        const isPureSearch = p.name === 'memory_search' && !call.args.drawerId
        if (isPureSearch && p.result) {
          // 落库形状实测：`{content:[{type:'text',text:'<JSON 字符串>'}]}`。
          // 用 JSON.stringify 兜底是为了形状变化时不至于静默取空。
          const text = p.result.content?.[0]?.text ?? JSON.stringify(p.result)
          const drawerIds = [...text.matchAll(/"drawer_id":\s*"([0-9a-f]{4,64})"/gi)].map(
            (x) => x[1].toLowerCase(),
          )
          call.returned = drawerIds
          call.flaggedInjected = [
            ...text.matchAll(/"drawer_id":\s*"([0-9a-f]{4,64})"[^}]*already_injected/gi),
          ].map((x) => x[1].toLowerCase())
          call.empty = drawerIds.length === 0
        }
        calls.push(call)
      }
    }
    return calls
  } finally {
    db.close()
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 一个探针跑一轮：发问 → 等轮次结束 → 取工具调用。
 *
 * **轮次完成的判据是「库里出现 assistant 消息」，不是固定 sleep**：固定 75s 在
 * 长轮次上会截断（实测有轮次跑了 2 分钟还在调工具），把"还在跑"误判成"没读原文"。
 */
async function runProbe(label, p, attempt) {
  const sessionKey = `probe-${label}-${p.id}-${Date.now()}`
  await send(sessionKey, p.q)

  let calls = []
  let prevCount = -1
  for (let i = 0; i < 40; i++) {
    await sleep(8000)
    calls = toolCalls(sessionKey)
    const hasReply = (() => {
      const db = new DatabaseSync(DB, { readOnly: true })
      try {
        return (
          (db
            .prepare(
              "SELECT COUNT(*) c FROM messages WHERE conversation_id = ? AND role = 'assistant'",
            )
            .get(sessionKey)?.c ?? 0) > 0
        )
      } finally {
        db.close()
      }
    })()
    // 已有回复且工具集连续两轮不变 → 视为结束（再等一轮防止工具调用与回复交错）
    if (hasReply && calls.length === prevCount) break
    prevCount = calls.length
  }

  const seq = calls.map((c) => c.tool)
  // 读抽屉的入口有两个名字：合并后 `memory_search(drawerId=…)` 是主入口，
  // `memory_read` 是保留的兼容壳。**两个都要算**，否则合并之后本探针会静默
  // 把模型所有直读行为统计成 0。
  const readCalls = calls.filter(
    (c) => c.tool === 'memory_read' || (c.tool === 'memory_search' && c.args.drawerId),
  )
  const readIds = readCalls.map((c) => String(c.args.drawerId ?? '').toLowerCase())
  // 开场即读：第一次读调用出现在第一次**纯搜索**之前（带 drawerId 的调用不算搜索）
  const pureSearchIdx = calls.findIndex((c) => c.tool === 'memory_search' && !c.args.drawerId)
  const firstReadIdx = calls.findIndex(
    (c) => c.tool === 'memory_read' || (c.tool === 'memory_search' && c.args.drawerId),
  )
  const readBeforeSearch = firstReadIdx >= 0 && (pureSearchIdx < 0 || firstReadIdx < pureSearchIdx)

  // 判据全部落在「本轮**实际**注入的那组指针」上，不假定是哪条。
  // 时序：`memory_usage_feedback` 由 `recordInjectionOutcome` 在本轮**结束时**写入，
  // 所以要等循环退出后再读——在发问前读会永远拿到空集。
  const injectIds = await injectedPointersWithRetry(sessionKey)
  const usedInjectPointer = readIds.some((id) => injectIds.includes(id))
  const searched = calls.filter((c) => c.tool === 'memory_search' && Array.isArray(c.returned))
  // 钉入生效？注入的那组指针里，有没有被检索返回过（返回了 = 模型至少看得见）
  const newInject = injectIds.filter((id) => !readIds.includes(id))
  const returned = newInject.filter((id) => searched.some((c) => c.returned.includes(id)))
  const targetReturned = newInject.length > 0 && returned.length === newInject.length
  const targetFlagged = searched.some((c) =>
    (c.flaggedInjected ?? []).some((id) => injectIds.includes(id)),
  )
  const emptySearches = searched.filter((c) => c.empty).length
  // 供排查：模型实际读的那些里，哪些是注入组里的
  const readOutsideInject = readIds.filter((id) => !injectIds.includes(id))

  console.log(
    `  [${label}] ${p.id.padEnd(13)} 注入指针[${injectIds.map((i) => i.slice(0, 8)).join(',') || '无'}]` +
      ` 读${readIds.length}个 命中注入=${usedInjectPointer ? '✅' : '❌'}` +
      ` 开场即读=${readBeforeSearch ? '✅' : '❌'}` +
      ` 钉入回传=${newInject.length === 0 ? '(已读过)' : returned.length + '/' + newInject.length}` +
      ` 空结果${emptySearches}次` +
      (readOutsideInject.length ? ` 另外读了[${readOutsideInject.map((i) => i.slice(0, 8)).join(',')}]` : ''),
  )

  return {
    probe: p.id,
    attempt,
    injectIds,
    seq,
    searched: seq.filter((t) => t === 'memory_search').length,
    read: seq.filter((t) => t === 'memory_read').length,
    usedInjectPointer,
    readBeforeSearch,
    /** 钉入生效的直接证据：检索返回过注入指针指向的那个抽屉 */
    targetReturned,
    targetFlagged,
    emptySearches,
    searchReturns: searched.map((c) => c.returned),
  }
}


// 并发跑：三个探针互不影响（不同 sessionKey = 不同 Agent 实例）
const label = process.argv[2]
if (!label) {
  console.error('用法: node scripts/probe-pointer-usage.mjs <标签>')
  process.exit(2)
}

console.log(`▶ [${label}] 并发跑 ${PROBES.length} 个探针…`)
const results = await Promise.all(PROBES.map((p) => runProbe(label, p, 1)))

const out = join(DATA, `probe-pointer-${label}.json`)
writeFileSync(out, JSON.stringify({ label, at: new Date().toISOString(), results }, null, 2), 'utf-8')

console.log(`\n═══ [${label}] 汇总 ═══`)
const hit = results.filter((r) => r.usedInjectPointer).length
const early = results.filter((r) => r.readBeforeSearch).length
const returned = results.filter((r) => r.targetReturned).length
console.log(`  命中注入指针: ${hit}/${results.length}   ← 模型读了「本轮实际注入」的某条指针`)
console.log(`  开场即读原文: ${early}/${results.length}   ← 搜索之前读，只可能来自注入`)
console.log(`  钉入回传:     ${returned}/${results.length}   ← 注入的指针没读、且搜索把它带回来了（钉入生效）`)
console.log(
  `  总搜索 ${results.reduce((a, r) => a + r.searched, 0)} 次 / 总读原文 ${results.reduce((a, r) => a + r.read, 0)} 次`,
)
console.log(`  明细: ${out}`)

