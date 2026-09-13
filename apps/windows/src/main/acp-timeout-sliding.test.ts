import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * 超时必须从「固定总时限」改成「滑动窗口」。
 *
 * 旧实现：一个 60 分钟定时器挂在 run 上，到点就杀，收到进度也不重置 →
 *        持续调工具的长任务会在中途被误杀，用户看到「任务还没跑完就超时」。
 * 新实现：每收到一次进度就重置窗口，只有真正长时间零输出才判超时。
 *
 * 判据用 runs 表：run 被 abort 后会在 catch 里 settle 并 delete，
 * 所以「run 仍在表中」== 「没被超时杀掉」。
 */

const promptCalls: Array<{ emitProgress: (p: unknown) => void; abortSignal: AbortSignal }> = []

vi.mock('./coding-dev-backends-stub/run-coding-dev-acp-prompt.js', () => ({
  runCodingDevAcpPrompt: vi.fn(async (params: any) => {
    params.emitProgress({ kind: 'status', text: '' }) // 启动即报一次进度
    promptCalls.push({ emitProgress: params.emitProgress, abortSignal: params.abortSignal })
    // 永不返回：模拟长任务仍在跑，除非被 abort
    await new Promise<void>((_resolve, reject) => {
      if (params.abortSignal?.aborted) return reject(new Error('任务已中止'))
      params.abortSignal?.addEventListener('abort', () => reject(new Error('任务已中止')), {
        once: true,
      })
    })
    return { text: '任务完成' }
  }),
}))

const { AcpRunController } = await import('./coding-dev-acp-run.js')

const TIMEOUT_MS = 200

function makeBridge() {
  return {
    runtimeStateRepo: { get: () => null, set: () => {}, delete: () => {} },
  } as never
}

describe('AcpRunController 超时（滑动窗口）', () => {
  const original = process.env.MTBOT_ACP_TIMEOUT_MS
  let controller: InstanceType<typeof AcpRunController>

  beforeEach(() => {
    promptCalls.length = 0
    vi.useFakeTimers()
    process.env.MTBOT_ACP_TIMEOUT_MS = String(TIMEOUT_MS)
    controller = new AcpRunController()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (original === undefined) delete process.env.MTBOT_ACP_TIMEOUT_MS
    else process.env.MTBOT_ACP_TIMEOUT_MS = original
  })

  function start(runId: string) {
    const done = controller.startRun({
      runId,
      sessionKey: `s-${runId}`,
      backendId: 'claude',
      text: '任务',
      instanceId: 'i1',
      bridge: makeBridge(),
      pushEvent: () => {},
    })
    return done
  }

  it('持续收到进度时，run 存活时间可远超超时窗口', async () => {
    void start('keepalive')
    await vi.advanceTimersByTimeAsync(0) // 让 mock 完成注册
    const emit = promptCalls[0].emitProgress

    // 每 50ms 一次心跳，累计 900ms（超时窗口仅 200ms）
    for (let elapsed = 0; elapsed < 900; elapsed += 50) {
      emit({ kind: 'status', text: '' }) // 心跳 → 应重置窗口
      await vi.advanceTimersByTimeAsync(50)
    }

    // 旧实现：200ms 时就已 abortRun(timeout)，run 早已 settle 移除 → 返回 false
    // 新实现：每次心跳都续命，run 仍在表中 → 返回 true
    expect(controller.abortRun('keepalive', 'user_cancel')).toBe(true)
  })

  it('零进度时窗口到点即中止', async () => {
    void start('silent')
    await vi.advanceTimersByTimeAsync(0)
    // 此后再不喂进度，静默超过窗口
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 50)

    // 已被超时杀掉并移除 → abortRun 找不到 run，返回 false
    expect(controller.abortRun('silent', 'user_cancel')).toBe(false)
  })
})
