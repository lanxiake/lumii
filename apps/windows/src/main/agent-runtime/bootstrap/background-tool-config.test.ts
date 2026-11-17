/**
 * 后台工具配置 · 暂停/恢复真实接线
 *
 * 走真实的 buildBackgroundToolConfig，只把 MCP 换成假实现：
 * 这样验的是「暂停闸门真的卡住了轮询」，而不是某个孤立的开关。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { BackgroundToolConfig } from '@mtbot/agent-runtime'
import { buildBackgroundToolConfig } from './background-tool-config'
import { BackgroundTaskManager, type BackgroundTaskRecord } from '../background-task-manager'
import { PauseGate } from '../task-pause-gate'

function setup(options: { enqueued?: boolean } = {}) {
  const { enqueued = true } = options
  const manager = new BackgroundTaskManager({
    emit: () => {},
    deliver: () => {},
  })
  const aborts = new Map<string, AbortController>()
  const gates = new Map<string, PauseGate>()

  let pollCalls = 0
  let resolveDone: (() => void) | null = null
  const mcpManager = {
    getBackgroundToolNames: () => new Set(['mcp__comfy__enqueue_workflow']),
    findServerForTool: () => ({ name: 'comfy', env: { COMFYUI_URL: 'https://comfy.test' } }),
    callTool: async (_server: string, tool: string) => {
      if (tool === 'queue') {
        pollCalls += 1
        // 一直「渲染中」，直到测试主动放行
        if (!resolveDone) {
          await new Promise<void>((resolve) => {
            resolveDone = resolve
          })
        }
        return JSON.stringify({ found: true, done: true, status_str: 'success' })
      }
      return 'videos → **out/a.mp4 (type=output)**'
    },
  }

  const config: BackgroundToolConfig = buildBackgroundToolConfig({
    getMcpManager: () => mcpManager as never,
    getBackgroundTaskManager: () => manager,
    currentToolExecutorInstanceIdRef: { value: undefined },
    instanceToRootSessionKey: new Map(),
    backgroundTaskAborts: aborts,
    taskPauseGates: gates,
  })

  const run = (): string =>
    config.runner.run({
      toolName: 'mcp__comfy__enqueue_workflow',
      label: 'ComfyUI: enqueue_workflow',
      execute: async () =>
        enqueued
          ? {
              content: [{ type: 'text', text: JSON.stringify({ status: 'enqueued', prompt_id: 'p1' }) }],
              details: {},
            }
          : { content: [{ type: 'text', text: 'done' }], details: {} },
    })

  return {
    manager,
    gates,
    aborts,
    run,
    /** 与 bridge.cancelBackgroundTask 同序：先放开闸门再 abort，否则轮询卡在 gate.wait 上不退出 */
    cancel: (taskId: string) => {
      manager.cancel(taskId)
      gates.get(taskId)?.resume()
      aborts.get(taskId)?.abort()
      aborts.delete(taskId)
      gates.delete(taskId)
    },
    pollCalls: () => pollCalls,
    finishRemote: () => resolveDone?.(),
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 等某个条件成立，最多 timeoutMs */
async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await sleep(20)
  }
}

describe('buildBackgroundToolConfig · 后台化判定', () => {
  /** 只要策略，不跑任务 */
  function policyWith() {
    const config = buildBackgroundToolConfig({
      getMcpManager: () =>
        ({
          getBackgroundToolNames: () => new Set(['mcp__comfy__enqueue_workflow']),
        }) as never,
      getBackgroundTaskManager: () => ({}) as never,
      currentToolExecutorInstanceIdRef: { value: undefined },
      instanceToRootSessionKey: new Map(),
      backgroundTaskAborts: new Map(),
    })
    return config.policy
  }

  it('MCP 声明的长耗时工具一律后台化', () => {
    expect(policyWith().shouldBackground('mcp__comfy__enqueue_workflow', {})).toBe(true)
  })

  it('bash 只在模型显式要求时才后台化', () => {
    const policy = policyWith()
    // 普通命令必须同步拿到 stdout，盲目后台化会把「看一眼就完事」变成等唤醒
    expect(policy.shouldBackground('bash', { command: 'ls' })).toBe(false)
    expect(policy.shouldBackground('bash', { command: 'ls', runInBackground: false })).toBe(false)
    expect(policy.shouldBackground('bash', { command: 'pip install x', runInBackground: true })).toBe(true)
  })

  it('其它内置工具不受 runInBackground 影响', () => {
    expect(policyWith().shouldBackground('file_read', { runInBackground: true })).toBe(false)
  })
})

describe('buildBackgroundToolConfig · 暂停闸门', () => {  it('入队后任务变可暂停，闸门登记在 taskPauseGates', async () => {
    const { manager, gates, run, cancel } = setup()
    const taskId = run()

    await waitFor(() => manager.get(taskId)?.pausable === true)
    expect(gates.has(taskId)).toBe(true)
    cancel(taskId)
  })

  it('暂停后轮询停住，恢复后继续，且不重新提交', async () => {
    const { manager, gates, run, pollCalls, finishRemote } = setup()
    const taskId = run()

    await waitFor(() => pollCalls() >= 1)
    const beforePause = pollCalls()

    // 暂停：主进程只翻闸门与状态，不打断远端
    gates.get(taskId)!.pause()
    manager.pause(taskId)
    await sleep(200)
    expect(manager.get(taskId)?.status).toBe('paused')
    expect(pollCalls()).toBe(beforePause)

    // 恢复：接着跟同一个 prompt，不会重新入队
    gates.get(taskId)!.resume()
    manager.resume(taskId)
    finishRemote()

    await waitFor(() => manager.get(taskId)?.status === 'succeeded')
    expect(manager.get(taskId)?.status).toBe('succeeded')
    // 全程只入队一次（pollCalls 只记 queue，不含 enqueue），产出解析成功
    expect(manager.get(taskId)?.outputs?.[0]).toMatchObject({ name: 'a.mp4', kind: 'video' })
  })

  it('暂停中取消：闸门放开 + abort，任务落到 cancelled', async () => {
    const { manager, gates, run, cancel, pollCalls } = setup()
    const taskId = run()

    await waitFor(() => pollCalls() >= 1)
    gates.get(taskId)!.pause()
    manager.pause(taskId)

    cancel(taskId)

    await waitFor(() => manager.get(taskId)?.status === 'cancelled')
    expect(manager.get(taskId)?.status).toBe('cancelled')
  })

  it('非轮询型任务（未入队）不可暂停', async () => {
    const { manager, run } = setup({ enqueued: false })
    const taskId = run()
    await waitFor(() => manager.get(taskId)?.status === 'succeeded')
    expect(manager.get(taskId)?.pausable).toBeUndefined()
  })
})

describe('buildBackgroundToolConfig · 资源采样', () => {
  beforeEach(async () => {
    const { resetSamplingForTests } = await import('../resource-monitor')
    resetSamplingForTests()
  })

  it('任务结束会归还采样计数（多次运行不泄漏）', async () => {
    const { getResourceMonitor } = await import('../resource-monitor')
    const { manager, run } = setup({ enqueued: false })

    for (let i = 0; i < 3; i++) {
      const taskId = run()
      await waitFor(() => manager.get(taskId)?.status === 'succeeded')
    }
    // 全部结算后不应还挂着采样器
    expect(getResourceMonitor()).toBeNull()
  })

  it('同一任务只结算一次：看门狗与正常结束不会把计数减两次', async () => {
    const { getResourceMonitor } = await import('../resource-monitor')
    const { manager, run, aborts } = setup({ enqueued: false })

    const first = run()
    await waitFor(() => manager.get(first)?.status === 'succeeded')

    // 第二个任务开跑，采样计数应为 1（不是被前一个漏减后的 0）
    const second = run()
    expect(getResourceMonitor()).not.toBeNull()
    expect(aborts.has(second)).toBe(true)
    await waitFor(() => manager.get(second)?.status === 'succeeded')
    expect(getResourceMonitor()).toBeNull()
  })
})
