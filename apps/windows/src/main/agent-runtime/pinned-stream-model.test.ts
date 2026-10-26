import { describe, expect, it } from 'vitest'
import { resolvePinnedStreamModelRef } from './pinned-stream-model.js'

describe('resolvePinnedStreamModelRef', () => {
  /** 开轮无锁定时用会话偏好，并写出锁定值 */
  it('首次无锁定：用 preferred，并返回 nextPinnedRef', () => {
    const r = resolvePinnedStreamModelRef(undefined, 'Qwen3.8-Flash-Next', 'default-model')
    expect(r.targetRef).toBe('Qwen3.8-Flash-Next')
    expect(r.nextPinnedRef).toBe('Qwen3.8-Flash-Next')
  })

  /** 无偏好时回退默认模型 */
  it('首次无偏好：回退 defaultModelId', () => {
    const r = resolvePinnedStreamModelRef(undefined, undefined, 'Qwen3.8-Flash-Next')
    expect(r.targetRef).toBe('Qwen3.8-Flash-Next')
    expect(r.nextPinnedRef).toBe('Qwen3.8-Flash-Next')
  })

  /** 工具间隙 Map 被改成 deepseek 时，仍用开轮锁定模型 */
  it('已锁定后忽略 preferred 变更（防中途错切到 deepseek）', () => {
    const r = resolvePinnedStreamModelRef(
      'Qwen3.8-Flash-Next',
      'deepseek-v4-flash',
      'Qwen3.8-Flash-Next',
    )
    expect(r.targetRef).toBe('Qwen3.8-Flash-Next')
    expect(r.nextPinnedRef).toBe('Qwen3.8-Flash-Next')
  })
})
