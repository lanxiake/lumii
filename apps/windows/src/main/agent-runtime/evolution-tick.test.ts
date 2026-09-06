import { describe, expect, it, vi } from 'vitest'
import { handleEvolutionTick } from './evolution-tick'
import type { EvolutionTickDeps } from './evolution-tick'

function makeDeps(overrides: Partial<EvolutionTickDeps> = {}): EvolutionTickDeps {
  return {
    getDb: () =>
      ({
        prepare: () => ({ all: () => [], get: () => undefined, run: () => undefined }),
      }) as never,
    isAutonomousEnabled: () => true,
    hasActiveUserTurn: () => false,
    appendEvolutionMessage: vi.fn(),
    executeGoal: vi.fn(async () => 'completed: g1'),
    sendOutreach: vi.fn(async () => 'sent'),
    reflect: vi.fn(async () => 'primary issue'),
    writeDiary: vi.fn(async () => '日记内容'),
    now: () => new Date(2026, 8, 6, 12, 0, 0), // 默认白天，避免静默时段触发 reflect
    ...overrides,
  }
}

describe('handleEvolutionTick', () => {
  it('开关关闭时 skip', async () => {
    const deps = makeDeps({ isAutonomousEnabled: () => false })
    expect(await handleEvolutionTick(deps)).toBe('skipped: disabled')
  })

  it('用户回合进行中时 skip', async () => {
    const deps = makeDeps({ hasActiveUserTurn: () => true })
    expect(await handleEvolutionTick(deps)).toBe('skipped: user turn in progress')
  })

  it('无已批准目标时 idle', async () => {
    const deps = makeDeps()
    expect(await handleEvolutionTick(deps)).toBe('idle')
    expect(deps.executeGoal).not.toHaveBeenCalled()
  })

  it('有已批准目标时执行', async () => {
    const executeGoal = vi.fn(async () => 'completed: g1')
    const deps = makeDeps({
      getDb: () =>
        ({
          prepare: () => ({
            all: () => [{ id: 'g1', type: 'learning', description: '学点东西' }],
            get: () => undefined,
            run: () => undefined,
          }),
        }) as never,
      executeGoal,
    })
    const result = await handleEvolutionTick(deps)
    expect(result).toContain('execute-goal')
    expect(executeGoal).toHaveBeenCalledWith(
      {
        id: 'g1',
        type: 'learning',
        description: '学点东西',
      },
      false,
    )
  })

  it('proactive-message 目标走 outreach', async () => {
    const sendOutreach = vi.fn(async () => 'sent')
    const deps = makeDeps({
      getDb: () =>
        ({
          prepare: () => ({
            all: () => [{ id: 'g1', type: 'proactive-message', description: '问候' }],
            get: () => undefined,
          }),
        }) as never,
      sendOutreach,
    })
    const result = await handleEvolutionTick(deps)
    expect(result).toContain('outreach')
    expect(sendOutreach).toHaveBeenCalled()
  })

  it('静默时段且无目标时 reflect（已写日记）', async () => {
    const reflect = vi.fn(async () => 'primary issue')
    const deps = makeDeps({
      getDb: () =>
        ({
          prepare: (sql: string) => ({
            all: () => (sql.includes('FROM reflections') ? [] : []),
            get: (key: string) =>
              key === 'autonomous.last_diary_date' ? { value: '2026-09-06' } : undefined,
            run: () => undefined,
          }),
        }) as never,
      reflect,
      now: () => new Date(2026, 8, 6, 23, 30, 0),
    })
    const result = await handleEvolutionTick(deps)
    expect(result).toContain('reflect')
    expect(reflect).toHaveBeenCalled()
  })

  it('静默时段且未写日记时 diary', async () => {
    const writeDiary = vi.fn(async () => '日记内容')
    const deps = makeDeps({
      getDb: () =>
        ({
          prepare: () => ({ all: () => [], get: () => undefined, run: () => undefined }),
        }) as never,
      writeDiary,
      now: () => new Date(2026, 8, 6, 23, 30, 0),
    })
    const result = await handleEvolutionTick(deps)
    expect(result).toContain('diary')
    expect(writeDiary).toHaveBeenCalled()
  })
})
