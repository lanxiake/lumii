/**
 * virtual-human-context / renderVirtualHumanPromptSection 单元测试
 *
 * 仅测纯函数 renderVirtualHumanPromptSection（Prompt 模板生成）。
 * resolveVirtualHumanContext 涉及 registry/store 文件 IO，留集成验证。
 * mock electron 以允许模块顶层 import（resolver/store 依赖 app）。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => 'E:\\fake\\app', getPath: () => 'E:\\fake\\userData' },
}))

import { renderVirtualHumanPromptSection } from './virtual-human-context'
import type { VirtualHumanPromptContext } from '../../shared/virtual-human'

const base: VirtualHumanPromptContext = {
  modelId: 'mao_pro',
  modelName: '猫猫',
  emotionKeys: ['neutral', 'joy', 'sad'],
  motionActions: [],
  personaAddon: '你是虚拟人猫猫。',
  enableExpressionPrompt: true,
  enableThinkTagPrompt: false,
}

describe('renderVirtualHumanPromptSection', () => {
  it('注入 persona + 表情段', () => {
    const out = renderVirtualHumanPromptSection(base)
    expect(out).toContain('## 宠物模式')
    expect(out).toContain('你是虚拟人猫猫。')
    expect(out).toContain('## 表情控制')
    expect(out).toContain('[joy]')
    expect(out).toContain('何时使用')
    expect(out).not.toContain('## 动作与神态')
  })

  it('关闭表情开关后不含表情段', () => {
    const out = renderVirtualHumanPromptSection({ ...base, enableExpressionPrompt: false })
    expect(out).not.toContain('## 表情控制')
    expect(out).toContain('你是虚拟人猫猫。')
  })

  it('开启动作开关后含 vh_action 段', () => {
    const out = renderVirtualHumanPromptSection({ ...base, enableThinkTagPrompt: true })
    expect(out).toContain('## 动作与神态')
    expect(out).toContain('<vh_action>')
  })

  it('有可触发动作时注入「可触发动作」段（编号），与神态开关解耦', () => {
    const out = renderVirtualHumanPromptSection({
      ...base,
      enableThinkTagPrompt: false,
      motionActions: [{ tag: '1' }, { tag: '2' }],
    })
    expect(out).toContain('## 可触发动作')
    expect(out).toContain('[motion:1]')
    expect(out).toContain('[motion:2]')
    expect(out).toContain('没有列表之外的动作')
  })

  it('有语义动作时按描述逐条列出', () => {
    const out = renderVirtualHumanPromptSection({
      ...base,
      motionActions: [{ tag: 'wave', description: '挥手打招呼' }],
    })
    expect(out).toContain('[motion:wave]')
    expect(out).toContain('挥手打招呼')
  })

  it('无 motionActions 时不注入可触发动作段', () => {
    const out = renderVirtualHumanPromptSection({
      ...base,
      enableThinkTagPrompt: true,
      motionActions: [],
    })
    expect(out).not.toContain('## 可触发动作')
  })

  it('可触发动作段独立于 vh_action 神态段：think 关、有动作 → 只注入可触发动作', () => {
    const out = renderVirtualHumanPromptSection({
      ...base,
      enableThinkTagPrompt: false,
      motionActions: [{ tag: '1' }],
    })
    expect(out).toContain('## 可触发动作')
    expect(out).not.toContain('## 动作与神态')
  })

  it('表情开关开但 emotionKeys 为空时不注入表情段', () => {
    const out = renderVirtualHumanPromptSection({ ...base, emotionKeys: [] })
    expect(out).not.toContain('## 表情控制')
  })

  it('无 persona 且全部关闭时仍含宠物模式说明', () => {
    const out = renderVirtualHumanPromptSection({
      ...base,
      personaAddon: undefined,
      enableExpressionPrompt: false,
      enableThinkTagPrompt: false,
    })
    expect(out).toContain('## 宠物模式')
    expect(out).not.toContain('## 表情控制')
  })
})
