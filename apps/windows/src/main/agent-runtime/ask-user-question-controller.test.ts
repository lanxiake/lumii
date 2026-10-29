/**
 * AskUserQuestionController 单元测试
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { AskUserQuestionController } from './ask-user-question-controller'

describe('AskUserQuestionController', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('clearAll 取消全部挂起并返回 requestId 列表', async () => {
    const controller = new AskUserQuestionController()
    const p1 = controller.waitForAnswer('a1', 60_000)
    const p2 = controller.waitForAnswer('a2', 60_000)
    expect(controller.pendingCount).toBe(2)

    const ids = controller.clearAll()
    expect(ids.sort()).toEqual(['a1', 'a2'])
    expect(controller.pendingCount).toBe(0)

    await expect(p1).resolves.toMatchObject({ cancelled: true })
    await expect(p2).resolves.toMatchObject({ cancelled: true })
  })

  it('超时后 resolve cancelled，不再出现在 clearAll', async () => {
    const controller = new AskUserQuestionController()
    const pending = controller.waitForAnswer('t1', 1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(pending).resolves.toMatchObject({ cancelled: true })
    expect(controller.clearAll()).toEqual([])
  })
})
