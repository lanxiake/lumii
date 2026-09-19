/**
 * model-thinking 单元测试 — 模型思考能力与档位解析
 */
import { describe, expect, it } from 'vitest'
import {
  defaultSupportsReasoning,
  resolveModelThinking,
  resolveReasoningOptions,
  resolveThinkingFormat,
} from './model-thinking'

const baseCfg = {
  type: 'openai' as const,
  baseUrl: 'https://kms.example.com:35019',
}

describe('defaultSupportsReasoning', () => {
  it('命中内置名单返回 true', () => {
    expect(defaultSupportsReasoning('Qwen3.8-Flash-Next')).toBe(true)
    expect(defaultSupportsReasoning('deepseek-v4-flash')).toBe(true)
    expect(defaultSupportsReasoning('claude-sonnet-4-5')).toBe(true)
    expect(defaultSupportsReasoning('gemini-2.5-pro')).toBe(true)
    expect(defaultSupportsReasoning('gpt-5.6-terra')).toBe(true)
  })

  it('o1/o3/o4 按分隔符匹配，不误伤含 o1 的普通名字', () => {
    expect(defaultSupportsReasoning('o3-mini')).toBe(true)
    expect(defaultSupportsReasoning('proto1-model')).toBe(false)
  })

  it('未知模型返回 false（中转对未知参数常直接 400，宁可让用户勾选）', () => {
    expect(defaultSupportsReasoning('my-custom-model')).toBe(false)
    expect(defaultSupportsReasoning('')).toBe(false)
  })
})

describe('resolveThinkingFormat', () => {
  it('显式配置优先', () => {
    expect(resolveThinkingFormat({ ...baseCfg, thinkingFormat: 'qwen' }, 'gpt-4o')).toBe('qwen')
    expect(resolveThinkingFormat({ ...baseCfg, thinkingFormat: 'openai' }, 'qwen3-next')).toBe('openai')
  })

  it('qwen 系模型默认走 chat_template_kwargs（vLLM/SGLang 系）', () => {
    expect(resolveThinkingFormat(baseCfg, 'Qwen3.8-Flash-Next')).toBe('qwen')
  })

  it('z.ai 端点走 thinking 格式', () => {
    expect(resolveThinkingFormat({ type: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4' }, 'glm-4.6')).toBe('zai')
  })

  it('其余端点走 OpenAI 原生 reasoning_effort', () => {
    expect(resolveThinkingFormat(baseCfg, 'deepseek-v4-flash')).toBe('openai')
  })

  it('未配置时按 openai 兜底', () => {
    expect(resolveThinkingFormat(undefined, 'unknown-model')).toBe('openai')
  })
})

describe('resolveModelThinking', () => {
  it('显式勾选优先于内置名单', () => {
    expect(
      resolveModelThinking({ ...baseCfg, modelReasoning: { 'my-model': true } }, 'my-model'),
    ).toMatchObject({ reasoning: true })
    expect(
      resolveModelThinking({ ...baseCfg, modelReasoning: { 'qwen3-next': false } }, 'qwen3-next'),
    ).toMatchObject({ reasoning: false })
  })

  it('未勾选时按内置名单推断，未知模型不声明能力', () => {
    expect(resolveModelThinking(baseCfg, 'Qwen3.8-Flash-Next').reasoning).toBe(true)
    expect(resolveModelThinking(baseCfg, 'unknown-model').reasoning).toBeUndefined()
  })

  it('z.ai 恒为 supports-reasoning：显式取消勾选也不能置 false（否则关不掉思考）', () => {
    const cfg = {
      type: 'openai' as const,
      baseUrl: 'https://api.z.ai/api/paas/v4',
      modelReasoning: { 'glm-4.6': false },
    }
    expect(resolveModelThinking(cfg, 'glm-4.6')).toEqual({ reasoning: true, thinkingFormat: 'zai' })
  })
})

describe('resolveReasoningOptions', () => {
  it('High 档一律 high', () => {
    expect(resolveReasoningOptions('high', 'openai', 'https://relay.example/v1')).toEqual({
      reasoning: 'high',
    })
  })

  it('预算型 provider 的 Max 走更大思考预算（真正拉开差距）', () => {
    expect(resolveReasoningOptions('max', 'anthropic-messages', 'https://api.anthropic.com')).toEqual({
      reasoning: 'high',
      thinkingBudgets: { high: 32_768 },
    })
    expect(resolveReasoningOptions('max', 'google-genai', 'https://x')).toEqual({
      reasoning: 'high',
      thinkingBudgets: { high: 32_768 },
    })
  })

  it('官方 OpenAI 端点的 Max 用 xhigh', () => {
    expect(resolveReasoningOptions('max', 'openai', 'https://api.openai.com')).toEqual({
      reasoning: 'xhigh',
    })
  })

  it('自建中转的 Max 等同 High（xhigh 会被端点 400）', () => {
    expect(resolveReasoningOptions('max', 'openai', 'https://kms.example.com:35019')).toEqual({
      reasoning: 'high',
    })
  })
})
