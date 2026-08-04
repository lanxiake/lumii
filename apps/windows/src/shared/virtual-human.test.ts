/**
 * virtual-human 纯函数单元测试
 *
 * 覆盖：resolveAgentId 三优先级、extractEmotionTags、stripVirtualHumanTags、
 *       mapEmotionsToIndices（07 号计划 §4.2 验收项）。
 */
import { describe, it, expect } from 'vitest'
import {
  resolveAgentId,
  extractEmotionTags,
  extractMotionTags,
  stripVirtualHumanTags,
  mapEmotionsToIndices,
} from './virtual-human'

describe('virtual-human / resolveAgentId', () => {
  it('全局覆盖优先（未跟随模型且指定 agentId）', () => {
    expect(
      resolveAgentId({
        settings: { agentId: 'global-a', followModelAgent: false },
        modelAgentId: 'model-a',
        sessionAgentId: 'sess-a',
      }),
    ).toBe('global-a')
  })

  it('跟随模型时忽略全局，用模型 agentId', () => {
    expect(
      resolveAgentId({
        settings: { agentId: 'global-a', followModelAgent: true },
        modelAgentId: 'model-a',
        sessionAgentId: 'sess-a',
      }),
    ).toBe('model-a')
  })

  it('无模型 agentId 时回退会话绑定', () => {
    expect(
      resolveAgentId({
        settings: { agentId: '', followModelAgent: true },
        modelAgentId: undefined,
        sessionAgentId: 'sess-a',
      }),
    ).toBe('sess-a')
  })

  it('全部缺失返回 undefined（系统默认）', () => {
    expect(
      resolveAgentId({
        settings: { agentId: '', followModelAgent: true },
      }),
    ).toBeUndefined()
  })

  it('未跟随但全局为空 → 回退模型', () => {
    expect(
      resolveAgentId({
        settings: { agentId: '', followModelAgent: false },
        modelAgentId: 'model-a',
      }),
    ).toBe('model-a')
  })
})

describe('virtual-human / extractEmotionTags', () => {
  it('提取多个表情标签并清洁文本', () => {
    const { cleanText, emotions } = extractEmotionTags('[joy]你好[neutral]在吗')
    expect(emotions).toEqual(['joy', 'neutral'])
    expect(cleanText).toBe('你好在吗')
  })

  it('无标签时原样返回', () => {
    const { cleanText, emotions } = extractEmotionTags('普通文本')
    expect(emotions).toEqual([])
    expect(cleanText).toBe('普通文本')
  })

  it('支持中文标签名', () => {
    const { emotions } = extractEmotionTags('[开心]哈哈')
    expect(emotions).toEqual(['开心'])
  })
})

describe('virtual-human / stripVirtualHumanTags', () => {
  it('剥离表情标签', () => {
    expect(stripVirtualHumanTags('[joy]你好呀')).toBe('你好呀')
  })

  it('剥离闭合的 vh_action 标签', () => {
    expect(stripVirtualHumanTags('<vh_action>*点头*</vh_action>好的')).toBe('好的')
  })

  it('剥离流式未闭合的 vh_action 残留', () => {
    expect(stripVirtualHumanTags('好的<vh_action>*微微')).toBe('好的')
  })

  it('表情 + 动作混合', () => {
    expect(stripVirtualHumanTags('[joy]开心<vh_action>*笑*</vh_action>！')).toBe('开心！')
  })

  it('剥离 [motion:tag] 动作标签', () => {
    expect(stripVirtualHumanTags('[motion:wave]你好[motion:1]呀')).toBe('你好呀')
  })
})

describe('virtual-human / extractMotionTags', () => {
  it('提取多个动作标签', () => {
    expect(extractMotionTags('[motion:wave]嗨[motion:2]哈')).toEqual(['wave', '2'])
  })

  it('无动作标签返回空数组', () => {
    expect(extractMotionTags('[joy]纯表情')).toEqual([])
  })
})

describe('virtual-human / mapEmotionsToIndices', () => {
  const emotionMap = { neutral: 0, joy: 3, sad: 1 }
  it('映射已知表情，过滤未知', () => {
    expect(mapEmotionsToIndices(['joy', 'unknown', 'sad'], emotionMap)).toEqual([3, 1])
  })
  it('空输入返回空', () => {
    expect(mapEmotionsToIndices([], emotionMap)).toEqual([])
  })
})
