/**
 * 工具面治理验证（TC）—— CLI 场景化验收
 *
 * 规范：../CLI-TEST-SPEC.md；用例文档：tool-contract-test-cases.md
 *
 * 本套件验证 2026-09-18 工具面治理的两项已实施改动在**真实客户端**上的效果：
 *   ① 工具文本里的失效引用被修（`old_string` / `read_file` / `skill_list`）
 *      → 行为面用例 TC-CONTRACT-02 / 03；静态面由单测 tool-name-references.test.ts 守
 *   ② 工具失败审计回填 duration_ms
 *      → 数据面用例 TC-CONTRACT-01
 *
 * 另记两条**基线观察**（TC-04/05），为尚未实施的 0.3「扩守卫射程」提供施工前后的对照。
 *
 * 运行：node docs/test/lumii-cli/tool-contract/run-tool-contract-e2e.mjs
 * 环境变量：TC_ONLY=<ID前缀> 只跑部分；TC_NO_RESTORE=1 保留现场；TC_TURN_TIMEOUT_MS 覆盖回合超时
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DATA_ROOT,
  DEV_LOG,
  assert,
  createEvidence,
  createSession,
  dbQuery,
  logChannelAvailable,
  logCursor,
  logLinesSince,
  okJson,
  preflight,
  runCase,
  sendAndWait,
  ui,
} from '../lib/cli-harness.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SESSION_PREFIX = '[tc-suite]'
const TURN_TIMEOUT_MS = Number(process.env.TC_TURN_TIMEOUT_MS || 240000)
const NO_RESTORE = process.env.TC_NO_RESTORE === '1'
const ONLY = process.env.TC_ONLY || ''

/** 探针文件放 temp/——不与用户的 outputs 产物混淆，跑完即删 */
const PROBE_DIR = path.join(DATA_ROOT, 'workspace', 'temp')
const createdProbeFiles = []

const ev = createEvidence(__dirname, 'tool-contract-suite', '工具面治理验证（TC）CLI 场景化验收')
const fails = { count: 0 }
/** 附加指标，写进报告的对照表 */
const metrics = []

function maybe(id, fn) {
  if (ONLY && !id.startsWith(ONLY)) {
    ev.record(id, 'SKIP', `TC_ONLY=${ONLY} 过滤跳过`)
    return true
  }
  return runCase(ev, id, fn, { fails })
}

// ────────────────────────────────────────────────
// 风格切换（TC-02 需要 detailed 档——只有那档 schema 描述才不被裁）
// ────────────────────────────────────────────────

function getStyle() {
  const r = okJson(ui(['settings', 'get', 'promptStyle.style']), 'settings get promptStyle.style')
  return typeof r.value === 'string' && r.value ? r.value : 'minimal'
}

function setStyle(style) {
  okJson(ui(['settings', 'set', 'promptStyle.style', style]), `settings set promptStyle.style=${style}`)
}

const originalStyle = (() => {
  try {
    return getStyle()
  } catch {
    return null
  }
})()

// ────────────────────────────────────────────────
// 探针文件
// ────────────────────────────────────────────────

function writeProbe(name, content) {
  fs.mkdirSync(PROBE_DIR, { recursive: true })
  const p = path.join(PROBE_DIR, name)
  fs.writeFileSync(p, content, 'utf8')
  createdProbeFiles.push(p)
  return p
}

/** agent 侧看到的路径（正斜杠，Git Bash / Windows 都认） */
const toAgentPath = (p) => p.replace(/\\/g, '/')

function cleanupProbes() {
  for (const p of createdProbeFiles) {
    try {
      fs.rmSync(p, { force: true })
    } catch {
      /* 清理失败不影响结论 */
    }
  }
}

/**
 * 恢复现场。**注册在 process exit 上**，任何退出路径都会执行。
 *
 * 踩过的坑（2026-09-18 实测）：原先恢复代码放在主流程末尾，
 * 而主流程在「连续 3 个用例失败」时会 `process.exit(1)` —— 那会**跳过恢复**，
 * 把用户的 `promptStyle` 停在测试用的 `detailed` 上。
 * 当天这个坑真的发生了：一次对照实验的恢复没走到，之后所有运行都把 detailed
 * 当成"原始值"再"恢复"成 detailed，用户设置被静默改掉。
 *
 * `process.on('exit')` 里只能做同步操作——`ui()` 是 execFileSync，满足条件。
 */
let restored = false
function restoreAll() {
  if (restored) return
  restored = true

  if (NO_RESTORE) {
    console.log('ℹ️  TC_NO_RESTORE=1，保留现场（promptStyle 与探针文件均不恢复）')
    if (createdProbeFiles.length) console.log(`   探针文件：\n   ${createdProbeFiles.join('\n   ')}`)
    return
  }

  if (originalStyle) {
    for (let i = 0; i < 3; i++) {
      try {
        setStyle(originalStyle)
        console.log(`↩️  已恢复 promptStyle=${originalStyle}`)
        break
      } catch (err) {
        if (i === 2) console.error(`⚠️  promptStyle 恢复失败（重试 3 次）：`, String(err))
      }
    }
  }
  cleanupProbes()
}
process.on('exit', restoreAll)

// ────────────────────────────────────────────────
// 日志解析
// ────────────────────────────────────────────────

/** 从本轮新增日志里挑出 tool:end 事件 */
function toolEnds(lines) {
  return lines
    .map((l) => l.match(/tool:end toolName=([a-zA-Z_0-9]+) isError=(true|false)/))
    .filter(Boolean)
    .map((m) => ({ tool: m[1], isError: m[2] === 'true' }))
}

/**
 * 当日日志全量行——供"读最近一次转储"用（那行可能出现在游标之前）。
 * 每次调用重新读：TC-04/05 排在真实回合之后，需要看到刚写进去的行。
 */
function allLogLines() {
  if (!logChannelAvailable()) return []
  return fs.readFileSync(DEV_LOG, 'utf8').split(/\r?\n/)
}

/** 从后往前找第一个匹配的行 */
function lastMatching(lines, regex) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(regex)
    if (m) return m
  }
  return null
}

// ────────────────────────────────────────────────
// TC-CONTRACT-01：工具失败审计带 duration_ms（验证改动 ②）
// ────────────────────────────────────────────────

function tc01() {
  const since = new Date().toISOString()
  const missing = toAgentPath(path.join(PROBE_DIR, `tc-missing-${Date.now()}.txt`))

  const sk = createSession('工具失败审计', { prefix: SESSION_PREFIX })
  // file_read 读不存在的路径 → 宿主层抛异常 → onError → 审计落库
  // （file_read 是只读免确认工具，不会产生 permission 记录，所以查这张表查到的都是执行失败）
  sendAndWait(sk, `请用 file_read 读取这个文件：${missing}\n我知道它大概率不存在——我就想看看工具在这种情况下怎么报错，直接把结果告诉我即可。`, {
    timeoutMs: TURN_TIMEOUT_MS,
  })

  const rows = dbQuery(
    `SELECT tool_name, is_error, duration_ms, result_summary
       FROM tool_audit_log
      WHERE tool_name = 'file_read' AND timestamp >= ?
      ORDER BY timestamp DESC`,
    since,
  )
  assert(rows.length > 0, `审计表在 ${since} 之后没有 file_read 记录——回合可能没触发工具调用`)

  const nulls = rows.filter((r) => r.duration_ms === null)
  metrics.push({ case: 'TC-01', rows: rows.length, nullDuration: nulls.length })
  assert(
    nulls.length === 0,
    `新增 ${rows.length} 条 file_read 审计里有 ${nulls.length} 条 duration_ms 为空` +
      `（改动 ② 未生效，或该路径没走 ToolRunner hook——先确认客户端已 dev:restart）`,
  )
  return `新增 ${rows.length} 条工具失败审计，duration_ms 全部有值（样例 ${rows[0].duration_ms}ms）`
}

// ────────────────────────────────────────────────
// TC-CONTRACT-02：file:// 场景不得调用不存在的 read_file（验证改动 ①）
// ────────────────────────────────────────────────

function tc02() {
  if (!logChannelAvailable()) throw new Error('SKIP: 日志通道不可用（本用例依赖 tool:end 事件）')

  // 切到 detailed：只有这一档 web_fetch 的 url 描述才发给模型
  // （minimal 档下简单工具的 schema 描述会被 tool-definition-style.ts 裁掉）
  setStyle('detailed')

  const probe = writeProbe('tc-fileurl-probe.txt', 'PROBE-OK-20260918\n')
  const sk = createSession('file:// 引用验证', { prefix: SESSION_PREFIX })
  const cursor = logCursor()

  sendAndWait(
    sk,
    `请读取这个本地文件并告诉我里面写了什么：file:///${toAgentPath(probe)}\n（用最直接的方式，不要绕弯）`,
    { timeoutMs: TURN_TIMEOUT_MS },
  )

  const ends = toolEnds(logLinesSince(cursor))
  const badCalls = ends.filter((e) => e.tool === 'read_file')
  const goodCalls = ends.filter((e) => e.tool === 'file_read')

  metrics.push({ case: 'TC-02', toolSeq: ends.map((e) => `${e.tool}${e.isError ? '!' : ''}`).join('>') })

  assert(
    badCalls.length === 0,
    `模型调用了不存在的 read_file × ${badCalls.length} —— ` +
      `web-fetch-tool.ts 的 url 描述仍在把模型往旧名上引（工具序列：${ends.map((e) => e.tool).join('>') || '空'}）`,
  )
  // 不硬断言"必须调 file_read"：模型直接说明 file:// 不可用也算合理行为。
  // 真正要守住的是「不去调一个不存在的东西」。
  return `未出现 read_file；file_read 调用 ${goodCalls.length} 次（序列：${ends.map((e) => e.tool).join('>') || '无工具调用'}）`
}

// ────────────────────────────────────────────────
// TC-CONTRACT-03：真实文件编辑一次成功、无参数校验失败（验证改动 ① 的行为面）
// ────────────────────────────────────────────────

function tc03() {
  if (!logChannelAvailable()) throw new Error('SKIP: 日志通道不可用（本用例依赖 tool:end 事件）')

  const probe = writeProbe('tc-edit-probe.md', '# 探针\n\n原始内容 A\n\n结尾行\n')
  const sk = createSession('文件编辑契约', { prefix: SESSION_PREFIX })
  const cursor = logCursor()

  sendAndWait(sk, `请把文件 ${toAgentPath(probe)} 里的「原始内容 A」改成「修改后的内容 B」。改完告诉我一声就行。`, {
    timeoutMs: TURN_TIMEOUT_MS,
  })

  const lines = logLinesSince(cursor)
  const ends = toolEnds(lines)
  const editOk = ends.filter((e) => e.tool === 'file_edit' && !e.isError)

  // 参数校验失败会表现为日志里的 "Validation failed"（它不进 hook 链，只能从事件层看）
  const validationFails = lines.filter((l) => /Validation failed/i.test(l))

  metrics.push({ case: 'TC-03', toolSeq: ends.map((e) => `${e.tool}${e.isError ? '!' : ''}`).join('>') })

  assert(
    validationFails.length === 0,
    `出现 ${validationFails.length} 次参数校验失败——模型可能被写错的参数名（old_string）诱导`,
  )
  assert(editOk.length > 0, `未观察到成功的 file_edit（序列：${ends.map((e) => e.tool).join('>') || '空'}）`)

  const after = fs.readFileSync(probe, 'utf8')
  assert(after.includes('修改后的内容 B'), `文件未被改动，当前内容：${JSON.stringify(after.slice(0, 120))}`)
  assert(!after.includes('原始内容 A'), '旧内容仍在文件里（可能只做了追加而非替换）')

  return `file_edit 成功 ${editOk.length} 次，无参数校验失败，文件内容已按预期替换`
}

// ────────────────────────────────────────────────
// TC-CONTRACT-04/05：基线观察（为尚未实施的 0.3 提供施工前后对照）
// ────────────────────────────────────────────────

/**
 * TC-04 是**观察项，不是断言**：0.3「扩守卫射程」尚未实施，`Other Tools` 非零是已知待办。
 * 把它算成 FAIL 会掩盖"本套件验证的两项改动其实都通过了"；算成 PASS 又是虚报。
 * 所以它记 INFO——`createEvidence` 的统计会排除 INFO，既不进通过率也不进失败数。
 * 因此这里返回 note 由主流程直接 record，**不走 runCase**（否则会同时留下 INFO 与 PASS 两条）。
 */
function tc04Note() {
  if (!logChannelAvailable()) return '日志通道不可用——跳过分组现状观察'

  const m = lastMatching(allLogLines(), /Groups: ([^"\\]+)/)
  if (!m) return '未在应用日志中找到 Groups 行——跳过分组现状观察'
  const groups = m[1]

  const other = groups.match(/Other Tools \((\d+)\)/)
  const desktop = groups.match(/Desktop Control \((\d+)\)/)
  const otherCount = other ? Number(other[1]) : 0
  const desktopCount = desktop ? Number(desktop[1]) : 0

  metrics.push({ case: 'TC-04', groups, otherCount, desktopCount })
  return (
    `提示词分组现状：Other Tools=${otherCount}，Desktop Control=${desktopCount}。` +
    `${otherCount > 0 ? `这 ${otherCount} 个工具在 minimal 档下对模型只显示为一个数字（0.3 待修）` : '无未归类工具'}`
  )
}

function tc05() {
  if (!logChannelAvailable()) throw new Error('SKIP: 日志通道不可用')

  const lines = allLogLines()
  const m = lastMatching(lines, /tools=(\d+)\/(\d+)/)
  assert(m, '未在应用日志中找到 tools=N/M 行')
  const req = { enabled: Number(m[1]), total: Number(m[2]) }

  // 分母口径：`tools=M` 含 MCP 工具，而 MCP **不参与提示词分组**——
  // partitionToolNames() 明确排除 `mcp__` 前缀（它们由各自的 server 自带 schema）。
  // 所以「守卫覆盖率」的分母必须是非 MCP 工具数，否则会算出一个偏低的假数字。
  const gm = lastMatching(lines, /Groups: ([^"\\]+)/)
  const nonMcp = gm
    ? gm[1]
        .split(/,\s*/)
        .map((s) => Number(s.match(/\((\d+)\)/)?.[1] ?? 0))
        .reduce((a, b) => a + b, 0)
    : null

  // 守卫射程 = 54 内置 + 13 硬编码客户端名 + execute_skill = 68（见执行计划 §二 场景 3）
  const GUARD_REACH = 68
  const denominator = nonMcp ?? req.total
  const covered = Math.min(denominator, GUARD_REACH)
  const pct = ((covered / denominator) * 100).toFixed(1)

  metrics.push({ case: 'TC-05', ...req, nonMcp, guardReach: GUARD_REACH, coverage: pct })
  return (
    `本次请求工具面 ${req.enabled}/${req.total}（含 MCP）；非 MCP 工具 ${denominator} 个，` +
    `守卫射程 ${GUARD_REACH} → 覆盖 ${pct}%（缺口 ${denominator - covered} 个，0.3 待补）`
  )
}

// ────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────

console.log(`\n🧪 工具面治理验证（TC）—— 探针前缀 ${SESSION_PREFIX}，回合超时 ${TURN_TIMEOUT_MS}ms`)
console.log(`   原始 promptStyle=${originalStyle}（TC-02 会切 detailed，结束恢复）\n`)

// 环境预检：连不上控制口时每条用例都会以 "connection_failed" 失败，
// 那是环境问题不是产品问题，提前给出可读提示比让三条用例依次报错强。
// （实测踩过：dev:restart 后立刻跑，应用还没起来 → 3 连失败提前终止）
const pf = preflight()
if (!pf.ok) {
  console.error(`❌ 环境不就绪：${pf.problems.join('；')}`)
  console.error('   若刚 dev:restart 过，等约 20 秒再跑；否则先启动客户端。\n')
  process.exit(3)
}
if (pf.warnings.length > 0) console.warn(`⚠️  ${pf.warnings.join('；')}\n`)

// TC-01 先跑：它是纯数据面用例，不依赖档位，也不消耗转储
if (!maybe('TC-CONTRACT-01', tc01)) process.exit(1)
// TC-02/03 是真实回合
if (!maybe('TC-CONTRACT-02', tc02)) process.exit(1)
if (!maybe('TC-CONTRACT-03', tc03)) process.exit(1)
// TC-04 是 INFO 观察项（不进统计），必须在真实回合之后——它读的是刚产生的转储
if (!ONLY || 'TC-CONTRACT-04'.startsWith(ONLY)) {
  ev.record('TC-CONTRACT-04', 'INFO', tc04Note())
}
// TC-05 是真断言：工具面规模与守卫射程的覆盖关系
if (!maybe('TC-CONTRACT-05', tc05)) process.exit(1)

// 正常路径主动恢复一次；restoreAll 内部有去重标志，进程退出时不会再跑一遍
restoreAll()

const metricRows = metrics
  .map((m) => `| ${m.case} | ${m.toolSeq ?? '-'} | ${m.rows ?? '-'} | ${m.nullDuration ?? '-'} | ${m.otherCount ?? '-'} | ${m.coverage ?? '-'} |`)
  .join('\n')

ev.writeReport({
  meta: {
    探针会话前缀: SESSION_PREFIX,
    探针文件目录: PROBE_DIR,
    验证范围: '改动 ①（失效引用修复）行为面 + 改动 ②（duration_ms 回填）数据面；TC-04/05 为 0.3 基线',
  },
  extraSections: `## 指标对照

| 用例 | 工具序列 | 审计行数 | duration 为空 | Other Tools | 守卫覆盖率 |
|---|---|---|---|---|---|
${metricRows || '| - | - | - | - | - | - |'}

> **TC-CONTRACT-04 是 INFO 而非 PASS**：0.3「扩守卫射程」尚未实施，\`Other Tools\` 非零是已知待办，
> 把它算成失败会掩盖"本套件验证的两项改动其实都通过了"这个事实。它的作用是提供施工前后对照。

## 静态面的对应守卫

本套件只覆盖**行为面与数据面**。文本本身（schema 描述 / 错误文案里的工具名引用）
由单测 \`packages/agent-runtime/src/tools/__tests__/tool-name-references.test.ts\` 守——
它能精确到"哪个文件的哪段文本引用了谁"，且已做变红验证（注入失效名即失败）。
两层分工：**单测守文本，CLI 守行为**。`,
})
