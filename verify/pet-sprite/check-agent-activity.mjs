#!/usr/bin/env node
/**
 * 验 R5/R6：Agent 的真实活动有没有驱动宠物的姿态（L1 表达层）。
 *
 * ## 判据只看日志，不看画面
 *
 * 「宠物看起来更忙了」不是判据（设计文档 §7.2 的修正块第 8 条专门批过这一点：
 * 整个价值都押在微妙感知上的设计，得靠盲测，不能靠"我觉得像"）。
 * 本脚本验的是**链路**，三条都要在：
 *
 *   1. `[pushAgentActivity] idle → thinking (event=turn-start)` —— 事件订阅通了
 *   2. `[pushAgentActivity] thinking → working (event=tool-start)` —— 工具段识别了
 *   3. `[setAgentActivityModulation] 收到首个非恒等调制 …` —— 调制送到了渲染器
 *
 * 三条齐 = 从 agent 事件到渲染器字段的整条链通了。「视觉上是否感觉得到」是另一回事。
 *
 * ## 三个被实测逼出来的选择
 *
 * - **用全新 sessionKey**（借 `scripts/probe-pointer-usage.mjs` 的先例）：既不污染用户的
 *   真实会话，宠物窗口又会**采纳**事件里的 sessionKey（`PetModeShell` 的
 *   `[onEvent] 采纳会话` 分支），于是事件不会被 session 过滤挡掉。
 * - **prompt 明确要求读文件**：随便发一句话，模型可能直接回答——那只有 turn-start，
 *   没有 tool-start，第 2 条判据会假阴性。要求读一个具体文件，工具调用才是确定的。
 * - **msgId 必须唯一**：`Date.now()` 后 12 位在并发时会撞车 → `UNIQUE constraint failed:
 *   messages.id` → 消息根本没落库、Agent 回合从不启动，而探针会一直等到超时，
 *   产出一份"什么都没发生"的**假阴性**。这是 probe 脚本踩过的坑，直接抄它的做法。
 */
import { statSync, openSync, readSync, closeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { makeAppUiPost, readAppUiConfig, sleep } from './lib/pet-frame.mjs'

const LOG = join(
  homedir(),
  '.lumii',
  'logs',
  'app',
  `mtbot-${new Date().toISOString().slice(0, 10)}.log`,
)
const post = makeAppUiPost(readAppUiConfig())

function readFrom(path, from) {
  const size = statSync(path).size
  if (size <= from) return ''
  const fd = openSync(path, 'r')
  const buf = Buffer.alloc(size - from)
  readSync(fd, buf, 0, buf.length, from)
  closeSync(fd)
  return buf.toString('utf-8')
}

/**
 * 宠物窗口**当前绑定**的会话 key。
 *
 * ⚠️ 不能自己造一个新鲜 key —— 第一版就是这么失败的，症状是"日志里一行都没有"，
 * 看着像链路没接上，其实是根本没进来：宠物窗口的 `sessionKeyRef` 一旦非空，
 * `[onEvent] 采纳会话` 分支就不再生效（它只在 ref 为空时采纳），于是
 * `petSessionMatchesEvent` 把所有 `evtSk != localSk` 的事件全挡在
 * `pushAgentActivity` 之前。日志里只有一行 `跳过 type=… localSk=b0fe…`。
 *
 * 控制口是白名单路由（`app-ui-control/server.ts` 的 switch，只有 switchMode /
 * getMode / listModels 三个 pet 路由），没有查询接口，所以从日志尾部抓：
 * `localSk=` 出现在每一次 session 不匹配的 warn 行上。
 */
function petBoundSessionKey(from) {
  const size = statSync(LOG).size
  const text = readFrom(LOG, from ?? Math.max(0, size - 4_000_000))
  const hits = [...text.matchAll(/localSk=([\w-]+)/g)]
  return hits.length ? hits[hits.length - 1][1] : null
}

const ACTIVITY_RE = /\[pushAgentActivity\]|\[pumpAgentActivity\]|\[setAgentActivityModulation\]/

/** 从标记位开始的全部活动链日志 */
function activityLines(from) {
  return readFrom(LOG, from)
    .split('\n')
    .filter((l) => ACTIVITY_RE.test(l))
    .map((l) => '      ' + l.slice(0, 190))
}

// ---- 1. 确保在宠物模式 ----
await post('/ipc/pet/switchMode', { mode: 'pet', modelId: 'demo_shimeji_nekojapan' })
await sleep(2500)

// ---- 2. 发一条必然触发工具调用的消息 ----
//
// 发到**宠物窗口绑定的那个会话**——事件必须真的流经宠物窗口才会走到 `pushAgentActivity`，
// 用一个它不认的 key 会被 session 过滤整个挡掉。
//
// ⚠️ 那个 key 会变（它由主进程持久化，指向"当前活跃会话"，重启后通常就换了），
// 而从日志抓只能抓到**最近一次**跳过事件留下的值——应用刚起来时那还是上一次运行的。
// 所以做成**自愈式**：先按抓到的 key 发；若日志里一条活动链都没有、却冒出了一个新的
// `localSk=`，说明 key 过期了（那条消息进了孤儿会话，不会有人看到），拿新 key 再发一次。
//
// 消息带自解释前缀，免得用户在聊天记录里看到一条来路不明的提问。
const PROBE_TEXT =
  '[宠物活动链路验证] 这是一条自动化探针：请用 Bash 工具执行 node -e "console.log(Date.now())"，' +
  '把输出的数字原样回答给我。那个数字是当前时间戳，你不可能凭记忆得到它——必须真的执行命令。'

async function probe(sessionKey) {
  const mark = statSync(LOG).size
  await post('/command', {
    type: 'user:send',
    sessionKey,
    // 用工作区内的 `echo` 而不是让 agent 读项目文件：agent 的工作目录是
    // `~/.lumii/workspace`（不是项目根），第一版让它读 `apps/windows/package.json`
    // 直接 ENOENT 了——链路照样验得通（工具失败也发 tool:start/end），
    // 但会在会话里留一次没必要的失败调用。
    content: PROBE_TEXT,
    msgId: randomUUID(),
  })

  let lines = []
  let stale = null
  for (let i = 0; i < 25; i++) {
    await sleep(2000)
    lines = activityLines(mark)
    // ⚠️ 要等的是**工具段**，不能"有日志就收工"：`turn-start` 之后第一帧就会有一条
    // `setAgentActivityModulation`（平滑起点），照它退出会永远看不到 working——
    // 第一版就是这么误判的，日志里明明有四条转移，脚本却报"链路有断点"。
    if (lines.some((l) => /→ working/.test(l))) {
      await sleep(4000) // 再收几轮，把段结束的「时间驱动」回落也带回来
      lines = activityLines(mark)
      break
    }
    if (lines.length === 0) {
      const fresh = petBoundSessionKey(mark)
      if (fresh && fresh !== sessionKey) {
        stale = fresh
        break
      }
    }
  }
  return { lines, stale }
}

const firstKey = petBoundSessionKey()
console.log(`首次尝试的会话：${firstKey ?? '(日志里没抓到，退回新建)'}`)
let sessionKey = firstKey ?? `pet-activity-probe-${Date.now()}`
let { lines, stale } = await probe(sessionKey)

if (stale) {
  console.log(`该 key 已过期（宠物窗口实际绑定 ${stale}）——重发一次`)
  sessionKey = stale
  ;({ lines } = await probe(sessionKey))
}
console.log(`实际生效的会话：${sessionKey}`)

// ---- 3. 输出与判定 ----
console.log(`\n--- 活动链日志（共 ${lines.length} 行）---`)
console.log(lines.length ? lines.join('\n') : '      (无)')

const joined = lines.join('\n')
const sawTurn = /idle → thinking/.test(joined)
const sawTool = /→ working/.test(joined)
// 渲染器在「恒等 ⇄ 非恒等」跨越时报，所以每次运行都看得到（不像"只报首次"会假阴性）
const sawMod = /setAgentActivityModulation\].*开始生效/.test(joined)

console.log('\n===== 判定 =====')
console.log(`1. 事件订阅（turn-start 让 idle → thinking）：${sawTurn ? '✓' : '✗'}`)
console.log(`2. 工具段识别（thinking → working）：${sawTool ? '✓' : '✗'}`)
console.log(`3. 调制送达渲染器（非恒等）：${sawMod ? '✓' : '✗'}`)
console.log(
  sawTurn && sawTool && sawMod
    ? '\n✓ Agent 活动感知链路通了'
    : '\n✗ 链路有断点——看上面日志缺哪一段',
)
