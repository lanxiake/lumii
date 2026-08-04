/**
 * local-companion-handler 单元测试
 *
 * 聚焦 handleTick 的门闩决策顺序：
 *   1. 非宠物模式 → skip
 *   2. 主动联系已关闭 → skip
 *   3. 免打扰时段 → skip
 *   4. gentle 模式非工作日 → skip
 *   5. 正常场景 → 发送并携带称呼
 *
 * mock electron，因为 local-companion-handler 依赖的 pet-mode-store 顶层 import 了
 * electron 的 app（虽然本文件用例不会真正触发文件 IO）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { DatabaseAdapter } from '@mtbot/agent-runtime'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/mtbot-test-userdata' },
}))

import {
  handleLocalCompanionInstruction,
  type LocalCompanionDeps,
} from './local-companion-handler'

/** 构造一个不做任何持久化、所有查询均返回空的假 DatabaseAdapter（满足 handleTick 内 KV 读取的默认路径） */
function createFakeDb(): DatabaseAdapter {
  return {
    exec: vi.fn(),
    prepare: vi.fn(() => ({
      get: vi.fn(() => undefined),
      all: vi.fn(() => []),
      run: vi.fn(() => ({ changes: 0, lastInsertRowid: 0 })),
    })),
    close: vi.fn(),
  } as unknown as DatabaseAdapter
}

/** 构造 LocalCompanionDeps，允许按用例覆盖 isPetMode / getProactiveCare */
function createDeps(overrides: Partial<LocalCompanionDeps> = {}): LocalCompanionDeps & {
  showNotification: ReturnType<typeof vi.fn>
} {
  const showNotification = vi.fn()
  return {
    getDb: () => createFakeDb(),
    showNotification,
    isPetMode: () => true,
    getProactiveCare: () => ({ enabled: true, mode: 'gentle', nickname: '' }),
    ...overrides,
  } as LocalCompanionDeps & { showNotification: ReturnType<typeof vi.fn> }
}

describe('local-companion-handler / handleTick 门闩', () => {
  beforeEach(() => {
    // 固定为周一 15:00（工作日、非免打扰时段），作为大多数用例的基准时间
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 27, 15, 0, 0)) // 2026-07-27 周一
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('非宠物模式 → 跳过，不发送通知', async () => {
    const deps = createDeps({ isPetMode: () => false })
    const result = await handleLocalCompanionInstruction('__companion_tick__', deps)
    expect(result).toBe('skipped: not in pet mode')
    expect(deps.showNotification).not.toHaveBeenCalled()
  })

  it('主动联系已关闭 → 跳过', async () => {
    const deps = createDeps({
      isPetMode: () => true,
      getProactiveCare: () => ({ enabled: false, mode: 'gentle', nickname: '' }),
    })
    const result = await handleLocalCompanionInstruction('__companion_tick__', deps)
    expect(result).toBe('skipped: disabled')
    expect(deps.showNotification).not.toHaveBeenCalled()
  })

  it('免打扰时段（23:00）→ 跳过', async () => {
    vi.setSystemTime(new Date(2026, 6, 27, 23, 0, 0)) // 周一 23:00
    const deps = createDeps()
    const result = await handleLocalCompanionInstruction('__companion_tick__', deps)
    expect(result).toBe('skipped: quiet hours')
    expect(deps.showNotification).not.toHaveBeenCalled()
  })

  it('gentle 模式 + 非工作日（周六）→ 跳过', async () => {
    vi.setSystemTime(new Date(2026, 6, 25, 15, 0, 0)) // 2026-07-25 周六 15:00
    const deps = createDeps({
      getProactiveCare: () => ({ enabled: true, mode: 'gentle', nickname: '' }),
    })
    const result = await handleLocalCompanionInstruction('__companion_tick__', deps)
    expect(result).toBe('skipped: not workday in gentle mode')
    expect(deps.showNotification).not.toHaveBeenCalled()
  })

  it('宠物模式 + 已启用 + 工作日非免打扰时段 → 发送并携带称呼', async () => {
    const deps = createDeps({
      getProactiveCare: () => ({ enabled: true, mode: 'gentle', nickname: '小明' }),
    })
    const result = await handleLocalCompanionInstruction('__companion_tick__', deps)
    expect(result.startsWith('executed:')).toBe(true)
    expect(deps.showNotification).toHaveBeenCalledTimes(1)
    const [title, body] = deps.showNotification.mock.calls[0]!
    expect(title).toBe('宠物消息')
    expect(title).not.toContain('AI 伙伴')
    expect(body).toContain('小明')
  })

  it('active 模式 + 周六 → 不受工作日限制，正常发送', async () => {
    vi.setSystemTime(new Date(2026, 6, 25, 15, 0, 0)) // 周六 15:00
    const deps = createDeps({
      getProactiveCare: () => ({ enabled: true, mode: 'active', nickname: '' }),
    })
    const result = await handleLocalCompanionInstruction('__companion_tick__', deps)
    expect(result.startsWith('executed:')).toBe(true)
  })

  it('memory_fast / memory_deep 指令直接跳过（本地未实现）', async () => {
    const deps = createDeps()
    const fast = await handleLocalCompanionInstruction('__companion_memory_fast__', deps)
    const deep = await handleLocalCompanionInstruction('__companion_memory_deep__', deps)
    expect(fast).toBe('skipped: memory consolidation not implemented locally')
    expect(deep).toBe('skipped: memory consolidation not implemented locally')
  })
})
