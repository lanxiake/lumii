/**
 * 真实用户旅程 + 日志核对（背后逻辑是否按设计跑）
 *
 * 与纯 UL 验收的区别：这里把「用户说的话」和「主进程日志里应有的关键行」对齐，
 * 逐条核对设计里写明的内部动作是否真的发生、顺序对不对。
 *
 * 用法：
 *   node docs/test/lumii-cli/chat/run-user-journey-logcheck.mjs
 *   （可选）带上 Inspector 端口同时做断点追踪：INSPECT_PORT=5860
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../../..')
const CLI = path.join(ROOT, 'apps/windows/resources/app-ui-cli/lumii-ui.mjs')

function findAppLog() {
  const dir = path.join(os.homedir(), '.lumii', 'logs', 'app')
  let best = null
  for (const f of fs.readdirSync(dir)) {
    if (!/^mtbot-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue
    const full = path.join(dir, f)
    const m = fs.statSync(full).mtimeMs
    if (!best || m > best.m) best = { full, m, size: fs.statSync(full).size }
  }
  return best?.full ?? null
}

function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' })
  let json = null
  try { json = JSON.parse((r.stdout || '').trim()) } catch {}
  return { json, out: r.stdout, err: r.stderr }
}

/** 从 fileSize 处开始读日志（只读新增段，避免整文件扫） */
function readLogFrom(file, offset) {
  const stat = fs.statSync(file)
  if (stat.size <= offset) return ''
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(stat.size - offset)
  fs.readSync(fd, buf, 0, buf.length, offset)
  fs.closeSync(fd)
  return buf.toString('utf8')
}

function assert(c, m) {
  if (!c) { console.error(`FAIL: ${m}`); process.exit(1) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 设计里写明的内部动作 → 日志特征 */
const EXPECT = [
  {
    name: '任务后台化判定（背景工具集非空）',
    // 设计：shouldBackground 用 getBackgroundToolNames，含 mcp__comfyui__enqueue_workflow
    check: (ctx) => ctx.mcpStatus.servers?.some(
      (s) => s.name === 'comfyui' && (s.backgroundTools || []).includes('enqueue_workflow'),
    ),
    fix: '检查 shared/mcp-presets.ts 的 PRESET_ALIASES（comfyui → comfyui-remote）',
  },
  {
    name: '子 Agent 运行登记（broker.registerRun）',
    check: (ctx) => /\[SubagentBroker\] registerRun child=/.test(ctx.log),
    fix: 'spawn_agent 未走到 orchestrator.spawnAgent',
  },
  {
    name: '子 Agent 终态收尾（finalizeRun）',
    check: (ctx) => /\[SubagentBroker\] finalizeRun child=/.test(ctx.log),
    fix: '子 Agent 没有正常收场（可能被 abort 或卡住）',
  },
  {
    name: '完成载荷投递（enqueueCompletion / delivered）',
    check: (ctx) => /\[SubagentBroker\] enqueueCompletion|\[subagent\] delivered/.test(ctx.log),
    fix: 'async 子 Agent 完成后没有回投父会话',
  },
  {
    name: '活动快照推送（agent:activity:snapshot）',
    check: (ctx) => /\[AgentRuntime\] event: agent:activity:snapshot/.test(ctx.log),
    fix: '看板数据源没被推动（pushActivitySnapshot 未接线）',
  },
]

async function main() {
  console.log('== 真实用户旅程 + 日志核对 ==')
  const logFile = findAppLog()
  assert(logFile, '找不到应用日志（~/.lumii/logs/app/mtbot-*.log）')
  const startOffset = fs.statSync(logFile).size
  console.log('log:', logFile)
  console.log('offset:', startOffset)

  const mcp = cli(['command', 'mcp:status'])
  console.log('mcp:status ok =', Boolean(mcp.json?.servers))
  cli(['goto', '--view', 'chat'])

  // ── 用户真实的一句话 ─────────────────────────────
  const created = cli(['conversation', 'create', '--title', '[journey] 并行链路核对'])
  const sk = created.json?.sessionKey || created.json?.id
  assert(sk, '建会话失败: ' + created.out)
  console.log('session', sk)

  const prompt = '我需要你同时查两件事，都交给后台子 Agent 跑（mode 用 "async"），' +
    '派完立刻回复我"已派出"，不要等结果：' +
    '①「求个和」：用 bash 算 1 到 800 的整数和；' +
    '②「看目录」：用 bash 列出当前目录前 3 个条目。'
  cli(['command', 'user:send', '--data', JSON.stringify({ type: 'user:send', sessionKey: sk, content: prompt })])

  // 等子 Agent 跑完（最多 3 分钟）
  let sawEnd = false
  for (let i = 0; i < 90; i++) {
    await sleep(2000)
    const msgs = cli(['command', 'conversation:messages', '--data', JSON.stringify({
      type: 'conversation:messages', sessionKey: sk, limit: 20,
    })])
    const items = msgs.json?.items || []
    const hasAssistant = items.some((m) => m.role === 'assistant')
    if (hasAssistant && i > 3) {
      const log = readLogFrom(logFile, startOffset)
      const done = (log.match(/\[SubagentBroker\] finalizeRun/g) || []).length
      if (done >= 2) { sawEnd = true; break }
    }
  }
  // 收尾：等日志刷完
  await sleep(4000)
  const log = readLogFrom(logFile, startOffset)

  console.log(`\n本次新增日志 ${log.split('\n').length} 行，` +
    `其中 subagent 相关 ${(log.match(/\[subagent|\[SubagentBroker/g) || []).length} 行`)
  assert(sawEnd, '两个子 Agent 没有在 3 分钟内各完成一次（finalizeRun < 2）')

  // ── 逐条核对设计 ─────────────────────────────────
  console.log('\n=== 设计核对 ===')
  const ctx = { log, mcpStatus: mcp.json }
  const failures = []
  for (const e of EXPECT) {
    const ok = e.check(ctx)
    console.log(`${ok ? 'OK  ' : 'MISS'} ${e.name}`)
    if (!ok) failures.push(`${e.name}（${e.fix}）`)
  }

  // 顺序核对：登记 → 收尾 → 投递
  const idxReg = log.search(/\[SubagentBroker\] registerRun/)
  const idxFin = log.search(/\[SubagentBroker\] finalizeRun/)
  const idxDel = log.search(/\[subagent\] delivered/)
  console.log(`\n顺序：registerRun@${idxReg} < finalizeRun@${idxFin} < delivered@${idxDel}`)
  if (!(idxReg >= 0 && idxFin > idxReg && idxDel > idxFin)) {
    failures.push('调用顺序不符合设计（应 registerRun → finalizeRun → delivered）')
  }

  // 错误面：本窗口内不该出现后台任务相关 ERROR
  const errLines = log.split('\n').filter((l) => /\[ERROR\]/.test(l) && /subagent|background-task|BackgroundTask/i.test(l))
  if (errLines.length) {
    console.log(`\n注意：本次窗口有 ${errLines.length} 条后台相关 ERROR：`)
    for (const l of errLines.slice(0, 5)) console.log('  ' + l.slice(0, 200))
  }

  if (failures.length) {
    console.error('\nFAIL:')
    for (const f of failures) console.error('  - ' + f)
    process.exit(1)
  }

  console.log('\nPASS 用户旅程背后的逻辑与日志一致')
  console.log(JSON.stringify({ sessionKey: sk, logFile, newLines: log.split('\n').length }, null, 2))
}

main().catch((e) => { console.error(e); process.exit(1) })
