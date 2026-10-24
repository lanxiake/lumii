/**
 * 并行子 Agent 链路 · 主进程断点追踪（真实业务流程）
 *
 * 前置：powershell -File scripts/start-dev.ps1 -Force -Inspect 5860 -RemoteDebug 9222
 *
 * 验的是「设计里的调用顺序在真实运行时真的成立」，而日志只能看到打了 log 的那几步：
 *   1. spawn_agent → broker.registerRun（子运行登记）
 *   2. 实例状态跃迁 → pushActivitySnapshot（看板数据源真的被推动）
 *   3. 取消 → cancelBackgroundTask（真实任务返回 true / 未知返回 false）
 *
 * 断点命中即读调用栈 + 局部变量，随后立刻继续；不改行为、不加生产钩子。
 */
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { connectMain, traceFlow } from '../lib/main-trace.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../../..')
const CLI = path.join(ROOT, 'apps/windows/resources/app-ui-cli/lumii-ui.mjs')

function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' })
  let json = null
  try { json = JSON.parse((r.stdout || '').trim()) } catch {}
  return { json, out: r.stdout, err: r.stderr }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function assert(c, m) {
  if (!c) { console.error(`FAIL: ${m}`); process.exit(1) }
}

async function main() {
  console.log('== 并行子 Agent 链路 · 主进程断点追踪 ==')
  let main
  try {
    main = await connectMain()
  } catch (e) {
    console.error(`SKIP Inspector 不可用：${e.message}`)
    process.exit(2)
  }
  console.log('OK inspector connected')

  const created = cli(['conversation', 'create', '--title', '[trace] 并行链路'])
  const sk = created.json?.sessionKey || created.json?.id
  assert(sk, '建会话失败: ' + created.out)
  console.log('session', sk)

  // ── 追踪：spawn 登记 + 快照推送 ──────────────────
  const { events, unresolved } = await traceFlow(
    main,
    [
      {
        label: 'broker.registerRun',
        needle: 'this.broker.registerRun({',
        expr: '({ childId: childInstanceId, name: params.name, mode })',
      },
      {
        label: 'pushActivitySnapshot',
        needle: 'pushActivitySnapshot(rootSessionKey) {',
        expr: '({ root: rootSessionKey, agents: this.deps.agentRegistry.getAll().map(i => ({ id: i.id, state: i.state })) })',
      },
      {
        label: 'cancelBackgroundTask',
        needle: 'cancelBackgroundTask(taskId) {',
        expr: '({ taskId })',
      },
    ],
    async () => {
      cli(['command', 'user:send', '--data', JSON.stringify({
        type: 'user:send',
        sessionKey: sk,
        content: '请并行派两个后台子 Agent（mode 必须是 "async"）：①「甲」用 bash 算 1..500 的和；' +
          '②「乙」用 bash 列出当前目录前 3 个文件。派完立刻回复"已派出"，不要等结果。',
      })])
      // 再取消一个不存在的任务，验证 cancel 断点能命中并读到 taskId
      await sleep(4000)
      cli(['command', 'background-task:cancel', '--data', JSON.stringify({
        type: 'background-task:cancel', taskId: 'trace-unknown-task',
      })])
    },
    45_000,
  )

  main.close()

  console.log(`\n未命中的探针：${unresolved.length ? unresolved.join(', ') : '（无）'}`)
  console.log('\n=== 按时间顺序的命中 ===')
  let lastAt = 0
  for (const e of events) {
    const dt = lastAt ? `+${((e.at - lastAt) / 1000).toFixed(2)}s` : 'T0'
    lastAt = e.at
    const stack = e.stack.slice(0, 4).map((f) => f.fn).join(' ← ')
    console.log(`${dt.padEnd(8)} ${e.label.padEnd(24)} ${JSON.stringify(e.value)}`)
    console.log(`         ${stack}`)
  }

  const labels = events.map((e) => e.label)
  const reg = events.filter((e) => e.label === 'broker.registerRun')
  const snaps = events.filter((e) => e.label === 'pushActivitySnapshot')
  const cancels = events.filter((e) => e.label === 'cancelBackgroundTask')

  console.log('\n=== 断言 ===')
  assert(reg.length >= 2, `应看到至少 2 次 registerRun（两个子 Agent），实际 ${reg.length}`)
  const names = reg.map((e) => e.value?.name).filter(Boolean)
  assert(names.includes('甲') && names.includes('乙'), `registerRun 的 name 应为委托名「甲/乙」，实际 ${JSON.stringify(names)}`)
  console.log(`OK registerRun × ${reg.length} → ${JSON.stringify(names)}`)

  assert(snaps.length >= 2, `应看到多次 pushActivitySnapshot（创建 + 状态跃迁），实际 ${snaps.length}`)
  const withRunning = snaps.filter((e) => (e.value?.agents || []).some((a) => a.state === 'running'))
  assert(withRunning.length > 0, 'pushActivitySnapshot 里应至少有一次能看到 running 实例（看板依赖这一拍）')
  console.log(`OK pushActivitySnapshot × ${snaps.length}，其中 ${withRunning.length} 次含 running 实例`)
  console.log(`   顺序：${labels.filter((l) => l !== 'cancelBackgroundTask').join(' → ')}`)

  assert(cancels.length >= 1, 'cancelBackgroundTask 断点未命中')
  assert(cancels.every((e) => e.value?.taskId === 'trace-unknown-task'),
    `cancel 读到的 taskId 应是我们发的那个，实际 ${JSON.stringify(cancels.map((e) => e.value))}`)
  console.log(`OK cancelBackgroundTask × ${cancels.length} → ${JSON.stringify(cancels[0].value)}`)

  console.log('\nPASS 主进程调用顺序符合设计')
}

main().catch((e) => { console.error(e); process.exit(1) })
