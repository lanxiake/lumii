/**
 * 工具面治理验证（TC）—— CLI 场景化验收
 *
 * 规范：../CLI-TEST-SPEC.md；用例文档：tool-contract-test-cases.md
 *
 * 本套件验证 2026-09-18 工具面治理的已实施改动在**真实客户端**上的效果：
 *   ① 工具文本里的失效引用被修（`old_string` / `read_file` / `skill_list`）
 *      → 行为面用例 TC-CONTRACT-02 / 03；静态面由单测 tool-name-references.test.ts 守
 *   ② 工具失败审计回填 duration_ms
 *      → 数据面用例 TC-CONTRACT-01
 *   ③ 批次 1：统一 `isError` 契约（工具失败必须产顶层 isError:true）
 *      → 行为面用例 TC-CONTRACT-06（bash 非零退出 / 反向：成功不标）
 *        与 TC-CONTRACT-07（file_edit 前置条件失败）；数据面由 TC-06 顺带交叉验证
 *      → 宿主侧延伸由 TC-CONTRACT-08 验（宿主工具的两套载荷约定 ok:false / status:'error'）
 *   ④ 失败的大输出落盘（两套 hook 并存的既有行为，不是本轮的改动）
 *      → TC-CONTRACT-09：守批次 2「合并两套落盘 hook」时的回归——
 *        两套都跳过才不落盘，合并时若保留"错误结果不落盘"就会让 1MB 直接进上下文
 *
 * 另记两条**基线观察**（TC-04/05），跟踪提示词分组的覆盖面。
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

/** 原始档位。**注意是 `let`**：下面的启动自愈会重读它，见那里的顺序说明 */
let originalStyle = (() => {
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
 * 恢复现场。**三重保险**，因为「恢复」这件事已经翻车过两次：
 *
 * - 第一次（2026-09-18 上午）：恢复代码写在主流程末尾，而主流程在
 *   「连续 3 个用例失败」时会 `process.exit(1)` —— 那会跳过恢复，
 *   把用户的 `promptStyle` 停在测试用的 `detailed` 上。
 *   → 改成注册在 `process.on('exit')`。
 * - 第二次（2026-09-18 下午）：`process.on('exit')` **对信号强杀无效**——
 *   套件被 `SIGTERM` 中断时它同样不执行，`promptStyle` 又一次停在 `detailed`。
 *   → 现在加 `SIGINT`/`SIGTERM` 处理器，并把"原始值"**落盘**：
 *     即使进程被 `SIGKILL`（连信号处理器都跑不了），下次启动也会先自愈。
 *
 * `process.on('exit')` 与信号处理器里都只能做同步操作——`ui()` 是 execFileSync，满足条件。
 */
const STATE_FILE = path.join(PROBE_DIR, '.tc-suite-original-style.json')

/** 启动自愈：上次没恢复干净的话，先把用户的原始值还回去 */
function healFromPreviousRun() {
  try {
    if (!fs.existsSync(STATE_FILE)) return
    const { style } = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (typeof style === 'string' && style) {
      setStyle(style)
      console.log(`🩹 检测到上次运行未恢复干净，已把 promptStyle 还原为 ${style}`)
    }
    fs.rmSync(STATE_FILE, { force: true })
  } catch (err) {
    console.error('⚠️  启动自愈失败（不影响本次运行，但请手动检查 promptStyle）：', String(err))
  }
}

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
  try {
    fs.rmSync(STATE_FILE, { force: true })
  } catch {
    /* 删不掉也不影响：下次启动自愈后会再删一次 */
  }
}
process.on('exit', restoreAll)
process.on('SIGINT', () => {
  restoreAll()
  process.exit(130)
})
process.on('SIGTERM', () => {
  restoreAll()
  process.exit(143)
})

// ────────────────────────────────────────────────
// 启动自愈 + 记录本次原始值
// ────────────────────────────────────────────────

// 顺序要紧：上面读 `originalStyle` 时，若上次被强杀留下了 `detailed`，
// 读到的会是那个残留值。所以**先自愈（还回真实值）、再重读**。
healFromPreviousRun()
try {
  originalStyle = getStyle()
} catch {
  /* 读不到就沿用上面那次的值 */
}

// 记下本次原始值：万一进程被 SIGKILL（连信号处理器都不跑），下次启动靠它自愈
if (!NO_RESTORE && originalStyle) {
  try {
    fs.mkdirSync(PROBE_DIR, { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify({ style: originalStyle }))
  } catch (err) {
    console.warn('⚠️  原始 promptStyle 落盘失败（仍会在正常退出时恢复）：', String(err))
  }
}

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
// TC-CONTRACT-06：失败必须被标记（批次 1 契约）——bash 非零退出
// ────────────────────────────────────────────────

/**
 * 批次 1 把 `isError` 契约统一到顶层，本用例验它的**行为面**：
 * 非零退出要标失败、零退出不得标失败。
 *
 * 为什么要成对验：只验"非零变红"的话，一个「无脑全部标 isError」的实现也能通过。
 * 反面同样要守——契约第 3 条明确「非理想结局不等于失败」，
 * 过度标记会让失败率失去诊断价值（这正是批次 1 要修的问题的另一面）。
 */
function tc06() {
  if (!logChannelAvailable()) throw new Error('SKIP: 日志通道不可用（本用例依赖 tool:end 事件）')

  const since = new Date().toISOString()

  // 6a：必然非零退出的命令
  const skFail = createSession('bash 失败标记', { prefix: SESSION_PREFIX })
  const cursorFail = logCursor()
  sendAndWait(
    skFail,
    '请用 bash 工具**原样**执行下面这条命令，不要改动它、不要加任何兜底' +
      '（不要加 `|| true`、不要加 `2>/dev/null`、不要换别的命令）：\n\n' +
      '    exit 3\n\n' +
      '我知道它会失败——我在验证失败场景的记录是否正确，这是预期行为。执行完把退出码告诉我。',
    { timeoutMs: TURN_TIMEOUT_MS },
  )
  const failEnds = toolEnds(logLinesSince(cursorFail)).filter((e) => e.tool === 'bash')

  // 6b：必然成功的命令（反向断言）
  const skOk = createSession('bash 成功不标失败', { prefix: SESSION_PREFIX })
  const cursorOk = logCursor()
  sendAndWait(skOk, '请用 bash 工具**原样**执行下面这条命令，不要改动它：\n\n    echo batch1-ok\n\n把输出告诉我。', {
    timeoutMs: TURN_TIMEOUT_MS,
  })
  const okEnds = toolEnds(logLinesSince(cursorOk)).filter((e) => e.tool === 'bash')

  metrics.push({
    case: 'TC-06',
    toolSeq: `fail:${failEnds.map((e) => (e.isError ? '!' : '.')).join('')} ok:${okEnds
      .map((e) => (e.isError ? '!' : '.'))
      .join('')}`,
  })

  assert(
    failEnds.length > 0,
    '6a 未观察到 bash 调用——模型可能没用工具而是直接回答了（序列为空）',
  )
  assert(
    failEnds.some((e) => e.isError),
    `6a 非零退出未被标记为失败（${failEnds.length} 次 bash 调用，isError 全为 false）。` +
      `契约要求顶层 isError:true——检查 bash-tool.ts 的 isError 赋值是否还在`,
  )
  assert(
    okEnds.length > 0,
    '6b 未观察到 bash 调用——模型可能没用工具而是直接回答了（序列为空）',
  )
  assert(
    !okEnds.some((e) => e.isError),
    `6b 成功的 bash 被误标为失败（${okEnds.length} 次调用里有 isError=true）。` +
      `过度标记与漏标同样是契约违反——检查 exitCode 判定条件是否被写反`,
  )

  // 数据面交叉验证：日志说标了，审计表里也应能查到（计划 A6 要求的"两个口径互证"）
  const auditRows = dbQuery(
    `SELECT is_error, COUNT(*) AS n FROM tool_audit_log
      WHERE tool_name = 'bash' AND timestamp >= ? GROUP BY is_error`,
    since,
  )
  const errRows = auditRows.find((r) => Number(r.is_error) === 1)
  metrics.push({ case: 'TC-06(DB)', rows: auditRows.map((r) => `${r.is_error}:${r.n}`).join(' ') })
  assert(
    errRows && Number(errRows.n) > 0,
    `6a 日志层标了失败，但 tool_audit_log 里查不到 is_error=1 的 bash 记录（${JSON.stringify(auditRows)}）——` +
      `两个口径不一致，说明审计出口没拿到同一个 isError（检查 tool-runner 到 audit hook 的接线）`,
  )

  const failMarked = failEnds.filter((e) => e.isError).length
  return (
    `6a 的 ${failEnds.length} 次 bash 调用中有 ${failMarked} 次被标为失败` +
    `（模型执行 exit 3 后又自己跑了一次探测，那次成功、未标）；` +
    `6b 的 ${okEnds.length} 次调用未被误标；` +
    `审计表同步记录 is_error=1 × ${errRows.n}（日志与 DB 两个口径一致）`
  )
}

// ────────────────────────────────────────────────
// TC-CONTRACT-07：失败必须被标记——file_edit 的 oldString 未找到
// ────────────────────────────────────────────────

/**
 * 与 TC-06 同属批次 1，但走的是**另一类**失败：工具自己判定的前置条件不满足
 * （不是宿主抛异常、也不是非零退出码）。这类失败在批次 1 之前完全不被标记——
 * 模型只看到一段说 "Error: ..." 的普通文本，得自己判断这是不是失败。
 *
 * ⚠️ 本用例第一版是**假阳性**（2026-09-18 实测发现）：探针文件由套件刚写出来、
 * agent 没读过它，于是 `read-before-write` hook 在 beforeExecute 就把它拒了
 * （`[file_edit 被拒绝] 文件存在但未被 file_read 读取过`）。
 * 那次 `isError=true` 验的是 **hook 短路**，不是「file-edit-tool 的失败分支」。
 * 所以现在做两件事：① 提示词要求先 file_read；② 断言**失败的来源**。
 */
function tc07() {
  if (!logChannelAvailable()) throw new Error('SKIP: 日志通道不可用（本用例依赖 tool:end 事件）')

  const probe = writeProbe('tc-edit-fail-probe.md', '# 探针\n\n这里只有原始内容 A\n')
  const sk = createSession('file_edit 失败标记', { prefix: SESSION_PREFIX })
  const cursor = logCursor()

  sendAndWait(
    sk,
    `请按顺序做两步，不要跳步、不要合并：\n` +
      `1. 先用 file_read 读取文件 ${toAgentPath(probe)}\n` +
      `2. 再用 file_edit 把文件里的「绝不存在的字符串-XYZ」替换成「替换后」\n\n` +
      '我知道第 2 步的字符串不存在——我在验证失败场景的记录是否正确，请照做一次即可，' +
      '不要改用 file_write 绕过、也不要换成一个存在的字符串。',
    { timeoutMs: TURN_TIMEOUT_MS },
  )

  const lines = logLinesSince(cursor)
  const ends = toolEnds(lines)
  const editEnds = ends.filter((e) => e.tool === 'file_edit')

  metrics.push({ case: 'TC-07', toolSeq: ends.map((e) => `${e.tool}${e.isError ? '!' : ''}`).join('>') })

  assert(editEnds.length > 0, `未观察到 file_edit 调用（序列：${ends.map((e) => e.tool).join('>') || '空'}）`)
  assert(
    editEnds.some((e) => e.isError),
    `oldString 未找到未被标记为失败（${editEnds.length} 次 file_edit 调用）。` +
      `契约要求顶层 isError:true——检查 file-edit-tool.ts 的两处失败分支`,
  )

  // 断言失败的**来源**：hook 短路也会产 isError，但那条路径验的不是工具自身的失败分支。
  //
  // ⚠️ 注意 resultPreview **会被日志截断**（实测约 400 字符，长错误文案没有闭合的 `}`），
  // 所以只能取 "resultPreview=" 之后的整段做**子串**判断，不能要求它解析成完整 JSON。
  const failLine = lines.find((l) => /tool:end toolName=file_edit isError=true/.test(l))
  const marked = failLine?.slice(failLine.indexOf("resultPreview=")) ?? ""
  assert(
    !marked.includes("被拒绝"),
    `file_edit 标了失败，但它是被 read-before-write hook 拦下的，` +
      `不是工具自身的 oldString 未找到分支——本用例要验的是后者。` +
      `多半是 agent 没先 file_read（hook 要求"编辑前必须先读"），重跑即可`,
  )
  assert(
    marked.includes("not found in"),
    `file_edit 的失败来源不是 oldString 未找到（实际：${marked.slice(0, 160)}）——` +
      `本用例假定模型会照提示去替换一个不存在的字符串，实际走了别的失败路径`,
  )

  const after = fs.readFileSync(probe, 'utf8')
  assert(after.includes('原始内容 A'), '文件被改动了——本用例要求替换失败、文件保持原样')

  return `file_edit 的 oldString 未找到已标失败（${editEnds.filter((e) => e.isError).length}/${editEnds.length}），失败来源已确认为工具自身分支，文件未被改动`
}

// ────────────────────────────────────────────────
// TC-CONTRACT-08：宿主工具的失败也必须被标记（批次 1 宿主侧）
// ────────────────────────────────────────────────

/**
 * 批次 1 先覆盖了 packages 的**内置工具**。宿主工具（`apps/windows`）是另一套载荷约定：
 * `{ ok: false }`（102 处）与 `{ status: 'error' | 'not_found' | 'partial' }`（94 处），
 * 由 `bridge-utils.ts` 的 `jsonToolResult` 统一提到顶层 isError。
 *
 * 这条链路值得单独验，因为它横跨两个包：宿主工具经
 * `bridge-instance-factory → assembleAgent → assembleTools` 装配，
 * **与内置工具走同一个 ToolRunner**——所以模型看到的应该是同一套失败语义。
 * 单测只能证明 `jsonToolResult` 返回了 isError，证明不了它在真实链路上被转成 is_error。
 */
function tc08() {
  if (!logChannelAvailable()) throw new Error('SKIP: 日志通道不可用（本用例依赖 tool:end 事件）')

  // 8a：必然失败的宿主工具调用（session_resume 传一个不存在的会话）
  const skFail = createSession('宿主工具失败标记', { prefix: SESSION_PREFIX })
  const cursorFail = logCursor()
  sendAndWait(
    skFail,
    '请调用 session_resume 工具，把 sessionKey 参数设为 "nonexistent-session-key-for-tc08"。\n' +
      '我知道这个会话不存在——我在验证失败场景的记录是否正确，请照做一次即可，不要改用别的工具。',
    { timeoutMs: TURN_TIMEOUT_MS },
  )
  const failEnds = toolEnds(logLinesSince(cursorFail)).filter((e) => e.tool === 'session_resume')

  // 8b：必然成功的宿主工具调用（反向断言——防"宿主工具一律标失败"）
  const skOk = createSession('宿主工具成功不标失败', { prefix: SESSION_PREFIX })
  const cursorOk = logCursor()
  sendAndWait(skOk, '请调用 session_list 工具列出当前会话，告诉我一共多少个。', {
    timeoutMs: TURN_TIMEOUT_MS,
  })
  const okEnds = toolEnds(logLinesSince(cursorOk)).filter((e) => e.tool === 'session_list')

  metrics.push({
    case: 'TC-08',
    toolSeq: `fail:${failEnds.map((e) => (e.isError ? '!' : '.')).join('')} ok:${okEnds
      .map((e) => (e.isError ? '!' : '.'))
      .join('')}`,
  })

  assert(
    failEnds.length > 0,
    '8a 未观察到 session_resume 调用——模型可能没用工具而是直接回答了',
  )
  assert(
    failEnds.some((e) => e.isError),
    `8a 宿主工具的失败载荷（{ok:false, message:'会话不存在'}）未被标为 isError。` +
      `检查 bridge-utils.ts 的 jsonToolResult 是否仍把 ok:false / status:'error' 提到顶层`,
  )
  assert(okEnds.length > 0, '8b 未观察到 session_list 调用')
  assert(
    !okEnds.some((e) => e.isError),
    `8b 成功的宿主工具被误标为失败（${okEnds.length} 次调用）。` +
      `过度标记与漏标同样是契约违反——检查 payloadIsFailure 的判定条件`,
  )

  return (
    `宿主工具失败载荷已标 isError（session_resume ${failEnds.filter((e) => e.isError).length}/${failEnds.length}）；` +
    `成功的 session_list ${okEnds.length} 次未被误标`
  )
}

// ────────────────────────────────────────────────
// TC-CONTRACT-09：失败的大输出必须落盘，不直接进上下文
// ────────────────────────────────────────────────

/**
 * 2026-09-18 复核批次 1 的连带影响时实测确认：**失败的大输出照常落盘**。
 * 原因是宿主侧还有第二套落盘 hook（`permission-tool-wrap.ts` 的
 * `createLargeToolResultHook`，30K 阈值，**没有** isError 判断），
 * 而 packages 侧那套（50K，有 isError 判断）在失败时会跳过——两套并存让这件事成了。
 *
 * 这条链路此前**没有任何用例守着**。它是批次 2 的清理项（两套应合并），
 * 一旦合并时改错（比如保留了"错误结果不落盘"那条策略），
 * `local-bash.ts` 的 1MB `OUTPUT_CAP` 就会直接灌进上下文。
 */
function tc09() {
  if (!logChannelAvailable()) throw new Error('SKIP: 日志通道不可用（本用例依赖 tool:end 事件）')

  const sk = createSession('失败大输出落盘', { prefix: SESSION_PREFIX })
  const cursor = logCursor()

  // 输出约 20 万字符（2000 行 × ~100 字符），远超 30K 阈值，且必然非零退出
  sendAndWait(
    sk,
    '请用 bash 工具**原样**执行下面这条命令（它必然失败，我在验证失败场景的处理方式）：\n\n' +
      '    for i in $(seq 1 2000); do echo "ERROR line $i of 2000: connection refused while talking to backend service foo.bar.baz"; done; exit 1\n\n' +
      '执行完告诉我：结果里说原始有多少字符、完整内容存在哪个路径。',
    { timeoutMs: TURN_TIMEOUT_MS },
  )

  const lines = logLinesSince(cursor)
  const ends = toolEnds(lines)
  const bashEnds = ends.filter((e) => e.tool === 'bash')
  const failEnds = bashEnds.filter((e) => e.isError)

  metrics.push({ case: 'TC-09', toolSeq: bashEnds.map((e) => (e.isError ? '!' : '.')).join('') })

  assert(failEnds.length > 0, `未观察到失败的 bash 调用（序列：${bashEnds.map((e) => (e.isError ? '!' : '.')).join('') || '空'}）`)

  // 关键断言：失败调用的结果**不是原文**，而是"已落盘 + 路径"的提示
  const failLine = lines.find((l) => /tool:end toolName=bash isError=true/.test(l))
  const marked = failLine?.slice(failLine.indexOf('resultPreview=')) ?? ''
  assert(
    marked.includes('已落盘') || marked.includes('.tool-results'),
    `失败的大输出没有落盘——模型看到的是原文（preview 前 200 字符：${marked.slice(0, 200)}）。` +
      `这会让 local-bash.ts 的 1MB OUTPUT_CAP 直接灌进上下文。` +
      `检查两套落盘 hook（packages 侧 tool-result-persist-hook / 宿主侧 large-tool-result）里` +
      `是否有一处按长度照常处理——**两套都跳过才是不落盘**`,
  )

  return `失败的 bash 调用 ${failEnds.length} 次，其大输出已落盘（模型收到路径提示而非原文）`
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
    (otherCount > 0
      ? `未归类的是**运行时动态注册**的工具（静态守卫扫不到）——查日志里的 [tooling] 告警看具体是哪些`
      : '无未归类工具')
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

  // 守卫射程（2026-09-18 扩射程后）：
  //   packages 侧 tooling-section.test.ts —— 54 内置 + 13 客户端名 + execute_skill
  //   apps/windows 侧 host-tool-prompt-coverage.test.ts —— 源码扫宿主注册器，37 个
  //   并集 = 54 + 37 = 91（13 个 guide/browser 只在宿主侧出现，不重复计）
  // 剩下的是**运行时动态注册**的工具（工具进化产物，名字编译期不可知），
  // 由 tooling-section.ts 的 partitionToolNames 运行时告警兜底——它不在测试里，
  // 但在生产路径上，落进 Other Tools 就会进日志。
  const GUARD_REACH_STATIC = 91
  const denominator = nonMcp ?? req.total
  const covered = Math.min(denominator, GUARD_REACH_STATIC)
  const pct = ((covered / denominator) * 100).toFixed(1)

  // 运行时告警抓到的那几个（用于报告里说明"为什么还剩几个"）
  const warnLine = lastMatching(lines, /\[tooling\] (\d+) 个工具未归入任何提示词分组: (.+)/)
  const runtimeOrphans = warnLine ? { count: Number(warnLine[1]), names: warnLine[2] } : null

  metrics.push({
    case: 'TC-05',
    ...req,
    nonMcp,
    guardReach: GUARD_REACH_STATIC,
    coverage: pct,
    runtimeOrphans: runtimeOrphans ? `${runtimeOrphans.count}（${runtimeOrphans.names}）` : '无告警',
  })
  return (
    `本次请求工具面 ${req.enabled}/${req.total}（含 MCP）；非 MCP 工具 ${denominator} 个，` +
    `静态守卫射程 ${GUARD_REACH_STATIC} → 覆盖 ${pct}%；` +
    `运行时告警兜底 ${runtimeOrphans ? runtimeOrphans.count : 0} 个动态注册工具` +
    `${runtimeOrphans ? `（${runtimeOrphans.names}）` : ''}`
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
// TC-06/07 验批次 1 的 isError 契约（真实回合，与档位无关）
if (!maybe('TC-CONTRACT-06', tc06)) process.exit(1)
if (!maybe('TC-CONTRACT-07', tc07)) process.exit(1)
// TC-08 验批次 1 的**宿主侧**延伸（宿主工具的两套载荷约定 → 同一个 ToolRunner）
if (!maybe('TC-CONTRACT-08', tc08)) process.exit(1)
// TC-09 守"失败的大输出必须落盘"（两套 hook 合并时的回归防线）
if (!maybe('TC-CONTRACT-09', tc09)) process.exit(1)
// TC-04 是 INFO 观察项（不进统计），必须在真实回合之后——它读的是刚产生的转储
if (!ONLY || 'TC-CONTRACT-04'.startsWith(ONLY)) {
  ev.record('TC-CONTRACT-04', 'INFO', tc04Note())
}
// TC-05 是真断言：工具面规模与守卫射程的覆盖关系
if (!maybe('TC-CONTRACT-05', tc05)) process.exit(1)

// 正常路径主动恢复一次；restoreAll 内部有去重标志，进程退出时不会再跑一遍
restoreAll()

const metricRows = metrics
  .map(
    (m) =>
      `| ${m.case} | ${m.toolSeq ?? '-'} | ${m.rows ?? '-'} | ${m.nullDuration ?? '-'} | ${m.otherCount ?? '-'} | ${m.coverage ?? '-'} | ${m.runtimeOrphans ?? '-'} |`,
  )
  .join('\n')

ev.writeReport({
  meta: {
    探针会话前缀: SESSION_PREFIX,
    探针文件目录: PROBE_DIR,
    验证范围: '改动 ①（失效引用修复）行为面 + 改动 ②（duration_ms 回填）数据面 + 0.3 扩守卫射程',
  },
  extraSections: `## 指标对照

| 用例 | 工具序列 | 审计行数 | duration 为空 | Other Tools | 守卫覆盖率 | 运行时告警（动态注册） |
|---|---|---|---|---|---|---|
${metricRows || '| - | - | - | - | - | - | - |'}

## 两层守卫的分工（2026-09-18 扩射程后）

| 层 | 位置 | 覆盖 | 触发时机 |
|---|---|---|---|
| 静态 | \`packages/.../tooling-section.test.ts\` | 54 内置 + 13 客户端名 + execute_skill | CI（批次 0.4 已接入） |
| 静态 | \`apps/windows/.../host-tool-prompt-coverage.test.ts\` | 源码扫宿主注册器，37 个 | 本地 \`pnpm verify\`（apps/windows 套件有摆动用例，刻意不进 CI） |
| **运行时** | \`tooling-section.ts\` 的 \`partitionToolNames\` | **动态注册的工具**（工具进化产物） | 每次渲染系统提示词 |

**为什么第三层不可省**：实测这道告警抓到了 3 个静态守卫永远扫不到的工具——
\`file-term-replace\` / \`node-read-file-script\` / \`replace-js-terms\`。
它们是 \`bridge.ts\` 的 \`registerEvolvedTool\` 在运行时注册的（bash-evolution 挖掘产物，
名字编译期不可知，所以**只能靠运行时兜底**）。

> TC-CONTRACT-04 是 INFO 而非 PASS：0.3 实施后 \`Other Tools\` 从 9 降到 3，
> 剩下 3 个是**已知的动态注册工具**而非漏配。把它算成失败会掩盖这个区别。

## 文本面的对应守卫

本套件只覆盖**行为面与数据面**。schema 描述与错误文案里的工具名引用由
\`packages/agent-runtime/src/tools/__tests__/tool-name-references.test.ts\` 守——
它能精确到"哪个文件的哪段文本引用了谁"，且做过变红验证（注入失效名即 2 条失败）。
**单测守文本，CLI 守行为与数据。**`,
})
