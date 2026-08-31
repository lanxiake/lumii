/**
 * local-companion-handler 单元测试
 *
 * 聚焦 handleTick 的门闩决策顺序：
 *   1. 非宠物模式 → skip（自动调度）
 *   2. 主动联系已关闭 → skip
 *   3. 免打扰时段 → skip（自动调度）
 *   4. gentle 模式非工作日 → skip（自动调度）
 *   5. 正常场景 → 发送并携带称呼
 *   6. 手动「立即执行」→ 绕过宠物模式等软门闩
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
  isLocalCompanionInstruction,
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

  it('手动立即执行 → 非宠物模式也能发送', async () => {
    const deps = createDeps({
      isPetMode: () => false,
      getProactiveCare: () => ({ enabled: true, mode: 'gentle', nickname: '小明' }),
    })
    const result = await handleLocalCompanionInstruction('__companion_tick__', deps, {
      manual: true,
    })
    expect(result.startsWith('executed:')).toBe(true)
    expect(deps.showNotification).toHaveBeenCalledTimes(1)
  })

  it('手动立即执行 → 仍受主动联系总开关约束', async () => {
    const deps = createDeps({
      isPetMode: () => false,
      getProactiveCare: () => ({ enabled: false, mode: 'gentle', nickname: '' }),
    })
    const result = await handleLocalCompanionInstruction('__companion_tick__', deps, {
      manual: true,
    })
    expect(result).toBe('skipped: disabled')
    expect(deps.showNotification).not.toHaveBeenCalled()
  })

  it('手动立即执行 → 绕过免打扰与工作日门闩', async () => {
    vi.setSystemTime(new Date(2026, 6, 25, 23, 0, 0)) // 周六 23:00
    const deps = createDeps({
      isPetMode: () => false,
      getProactiveCare: () => ({ enabled: true, mode: 'gentle', nickname: '' }),
    })
    const result = await handleLocalCompanionInstruction('__companion_tick__', deps, {
      manual: true,
    })
    expect(result.startsWith('executed:')).toBe(true)
    expect(deps.showNotification).toHaveBeenCalledTimes(1)
  })

  it('记忆读写未注入 → 跳过', async () => {
    const deps = createDeps()
    const fast = await handleLocalCompanionInstruction('__companion_memory_fast__', deps)
    expect(fast).toBe('skipped: 记忆读写未注入')
  })
})

describe('local-companion-handler / 记忆整理', () => {
  /** 含工具/方法冲突的记忆全文，会被 needsPersonalMemoryConsolidation 判为需要整理 */
  const CONFLICTING = [
    '## 用户偏好',
    '- 规则：生成图片时调用 generate_image.py 脚本。原因：用户指定。',
    '- 规则：生成图片时使用 image_generate 工具。原因：用户指定。',
  ].join('\n')

  function memDeps(
    content: string,
    llm: (prompt: string) => Promise<string>,
  ): { deps: LocalCompanionDeps; written: string[] } {
    const written: string[] = []
    const deps = {
      getDb: () => createFakeDb(),
      isPetMode: () => true,
      getProactiveCare: () => ({ enabled: true, mode: 'gentle' as const, nickname: '' }),
      getUserMemory: async () => ({ content }),
      updateUserMemory: async (next: string) => {
        written.push(next)
        return undefined
      },
      callLLM: llm,
    } as LocalCompanionDeps
    return { deps, written }
  }

  it('记忆为空 → 不叫 LLM', async () => {
    const llm = vi.fn(async () => 'never')
    const { deps, written } = memDeps('   ', llm)
    const result = await handleLocalCompanionInstruction('__companion_memory_fast__', deps)
    expect(result).toBe('skipped: 个人记忆为空，无需整理')
    expect(llm).not.toHaveBeenCalled()
    expect(written).toEqual([])
  })

  it('fast：记忆干净时不叫 LLM', async () => {
    const llm = vi.fn(async () => 'never')
    const { deps, written } = memDeps('## 用户偏好\n- 规则：回复保持简洁。原因：用户明确要求。', llm)
    const result = await handleLocalCompanionInstruction('__companion_memory_fast__', deps)
    expect(result).toBe('skipped: 记忆无重复或冲突，跳过整理')
    expect(llm).not.toHaveBeenCalled()
    expect(written).toEqual([])
  })

  it('deep：即使记忆干净也会整理', async () => {
    const llm = vi.fn(async () => '## 用户偏好\n- 规则：回复简洁。原因：用户要求。')
    const { deps, written } = memDeps(
      '## 用户偏好\n- 规则：回复保持简洁明了不要啰嗦。原因：用户明确要求。',
      llm,
    )
    const result = await handleLocalCompanionInstruction('__companion_memory_deep__', deps)
    expect(llm).toHaveBeenCalled()
    expect(result.startsWith('executed:')).toBe(true)
    expect(written).toHaveLength(1)
  })

  it('fast：查出冲突时整理并写回', async () => {
    const merged = '## 用户偏好\n- 规则：生成图片时使用 image_generate 工具。原因：用户指定。'
    const llm = vi.fn(async () => merged)
    const { deps, written } = memDeps(CONFLICTING, llm)
    const result = await handleLocalCompanionInstruction('__companion_memory_fast__', deps)
    expect(llm).toHaveBeenCalled()
    expect(written).toEqual([merged])
    expect(result).toContain('精简')
  })

  it('LLM 抛错 → 返回 error，不写回', async () => {
    const llm = vi.fn(async () => {
      throw new Error('模型不可用')
    })
    const { deps, written } = memDeps(CONFLICTING, llm)
    const result = await handleLocalCompanionInstruction('__companion_memory_deep__', deps)
    expect(result).toBe('error: 模型不可用')
    expect(written).toEqual([])
  })
})

describe('local-companion-handler / 综述指令已移除（P2）', () => {
  it('__wiki_auto_synthesis__ 不再是 companion 指令', () => {
    expect(isLocalCompanionInstruction('__wiki_auto_synthesis__')).toBe(false)
    // ERO 抽取与综述无关，仍应受理
    expect(isLocalCompanionInstruction('__wiki_ero_extract__')).toBe(true)
  })
})

describe('local-companion-handler / Wiki ERO 抽取', () => {
  it('runWikiEroExtract 未注入 → unavailable', async () => {
    const deps = createDeps()
    const result = await handleLocalCompanionInstruction('__wiki_ero_extract__', deps)
    expect(result).toBe('wiki ero extract unavailable')
  })

  it('runWikiEroExtract 注入 → 返回摘要字符串', async () => {
    const runWikiEroExtract = vi.fn(async () => 'pages:3 entities:5 relations:2 obs:1')
    const deps = createDeps({ runWikiEroExtract })
    const result = await handleLocalCompanionInstruction('__wiki_ero_extract__', deps)
    expect(result).toBe('pages:3 entities:5 relations:2 obs:1')
    expect(runWikiEroExtract).toHaveBeenCalledTimes(1)
  })
})
