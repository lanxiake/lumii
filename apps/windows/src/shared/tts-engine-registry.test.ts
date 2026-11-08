import { describe, it, expect } from 'vitest'
import {
  enabledTtsModelIds,
  getTtsEngine,
  listTtsEngines,
  registerTtsEngine,
  type TtsEngineEntry,
} from './tts-engine-registry.js'

function engine(id: string, modelIds: string[] = []): TtsEngineEntry {
  return {
    id,
    label: id,
    modelIds,
    concurrency: 1,
    outputFormat: 'pcm',
    create: () => {
      throw new Error('测试不构建 provider')
    },
  }
}

describe('TTS 引擎注册表', () => {
  it('注册后能查到，注销后查不到（插件禁用即功能消失）', () => {
    const off = registerTtsEngine(engine('test-a'))
    expect(getTtsEngine('test-a')?.id).toBe('test-a')

    off()
    expect(getTtsEngine('test-a')).toBeNull()
  })

  it('与具体插件生命周期绑定：注销只删自己注册的那个实例', () => {
    const off1 = registerTtsEngine(engine('test-b'))
    off1()
    // 二次注销是幂等的
    expect(() => off1()).not.toThrow()
    expect(getTtsEngine('test-b')).toBeNull()
  })

  it('重复 id 直接报错（避免两个插件抢同一个 provider 值）', () => {
    const off = registerTtsEngine(engine('test-c'))
    try {
      expect(() => registerTtsEngine(engine('test-c'))).toThrow(/重复/)
    } finally {
      off()
    }
  })

  it('模型 id 并集只包含已注册引擎的模型', () => {
    const off1 = registerTtsEngine(engine('test-d', ['m1', 'm2']))
    const off2 = registerTtsEngine(engine('test-e', ['m2', 'm3']))
    try {
      expect([...enabledTtsModelIds()].sort()).toEqual(
        expect.arrayContaining(['m1', 'm2', 'm3']),
      )
      off1()
      expect(enabledTtsModelIds().has('m1')).toBe(false)
      expect(enabledTtsModelIds().has('m3')).toBe(true)
    } finally {
      off1()
      off2()
    }
  })

  it('注销后不出现在引擎列表里', () => {
    const off = registerTtsEngine(engine('test-f'))
    expect(listTtsEngines().some((e) => e.id === 'test-f')).toBe(true)
    off()
    expect(listTtsEngines().some((e) => e.id === 'test-f')).toBe(false)
  })
})
