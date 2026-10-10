/**
 * 模型思考能力解析 — 由 provider 配置 + 内置默认表推出「该模型怎么发思考参数」。
 *
 * 为什么需要它：pi-ai 只在 `model.reasoning === true` 时才把思考参数写进请求体，
 * 而客户端传给 pi-ai 的是只含 {id, api} 的最小模型对象，永远拿不到 reasoning，
 * 导致对话页的思考开关/等级对请求体零影响（见 docs/plans/客户端UI/2026-09-19-*）。
 */

import type { LocalProviderConfig } from './provider-config.js'

/** 已解析的端点格式（不含 auto） */
export type ResolvedThinkingFormat = 'openai' | 'qwen' | 'zai'

export interface ModelThinking {
  /** 是否支持思考；undefined = 交给 direct-stream 按端点兜底（如 z.ai） */
  readonly reasoning?: boolean
  readonly thinkingFormat: ResolvedThinkingFormat
}

/**
 * 内置「支持思考」模型名单（子串匹配，小写）。
 * 未命中一律视为不支持——中转端点对未知参数常直接 400，宁可让用户在设置里勾选。
 */
const REASONING_HINTS = [
  'gpt-5',
  'claude-3-7',
  'claude-3.7',
  'claude-4',
  'claude-sonnet-4',
  'claude-opus-4',
  'claude-haiku-4',
  'gemini-2.5',
  'gemini-3',
  'deepseek-reasoner',
  'deepseek-v3.2',
  'deepseek-v4',
  'qwen3',
  'qwq',
  'glm-4.5',
  'glm-4.6',
  'glm-5',
  'kimi-k2-thinking',
  'kimi-k2.5',
  'minimax-m2',
  'grok-4',
]

/** 按模型 ID 推断是否支持思考（内置默认表） */
export function defaultSupportsReasoning(modelId: string): boolean {
  const id = modelId.trim().toLowerCase()
  if (!id) return false
  // o1/o3/o4 系列要按分隔符匹配，避免命中含 "o1" 的无关模型名
  if (/(^|[-_/.])o(1|3|4)([-_/.]|$)/.test(id)) return true
  return REASONING_HINTS.some((hint) => id.includes(hint))
}

/**
 * 把各家的思考档位归一成 OpenAI 词表（reasoning_effort）的托管端点类型。
 * 只有这些类型下，槽位里显式选「OpenAI」才可信——它们是别人家模型的中转/托管，
 * 协议由平台文档约定；自建中转（type=openai + 自定义 baseUrl）不在其中。
 */
const OPENAI_NATIVE_TYPES: ReadonlySet<string> = new Set(['openrouter', 'groq'])

/**
 * 解析思考参数格式：
 * 显式 qwen/zai → z.ai 端点 → qwen 系模型（vLLM/SGLang 走 chat_template_kwargs）→ OpenAI 原生。
 *
 * Qwen 系模型上，显式选「OpenAI」**不生效**：档位词表是端点私有的（实测某中转的
 * Qwen3.8-Flash-Next 只认 xhigh(默认)/medium/low，发 pi-ai 的 "high" 直接 400），
 * 而显式设置只能表达「用不用 reasoning_effort」这一个 bit，救不了词表对不上的端点。
 * qwen 分支「不发档位（= 端点自己的最高档）+ 显式开关」才是实测可用的形态。
 * 于是：Qwen 系按模型走（auto 本来就这么推断），只有 OpenAI 原生词表的托管端点除外。
 */
export function resolveThinkingFormat(
  cfg: Pick<LocalProviderConfig, 'type' | 'baseUrl' | 'thinkingFormat'> | undefined,
  modelId: string,
): ResolvedThinkingFormat {
  const explicit = cfg?.thinkingFormat
  if (explicit === 'qwen' || explicit === 'zai') return explicit
  // 'zai' 类型在片2加入 ProviderType；这里用字符串比较，加类型前也成立
  const typeName: string = cfg?.type ?? ''
  if (/qwen/i.test(modelId) && !OPENAI_NATIVE_TYPES.has(typeName)) return 'qwen'
  if (explicit === 'openai') return 'openai'
  if (typeName === 'zai' || (cfg?.baseUrl ?? '').includes('api.z.ai')) return 'zai'
  return 'openai'
}

/**
 * 解析某模型在给定槽位配置下的思考能力。
 * 注意：z.ai 必须始终 reasoning=true（其「显式关闭」分支依赖该标记，置 false 反而关不掉）。
 */
export function resolveModelThinking(
  cfg: Pick<LocalProviderConfig, 'type' | 'baseUrl' | 'modelReasoning' | 'thinkingFormat'> | undefined,
  modelId: string,
): ModelThinking {
  const thinkingFormat = resolveThinkingFormat(cfg, modelId)
  if (thinkingFormat === 'zai') return { reasoning: true, thinkingFormat }
  const explicit = cfg?.modelReasoning?.[modelId]
  if (typeof explicit === 'boolean') return { reasoning: explicit, thinkingFormat }
  const inferred = defaultSupportsReasoning(modelId)
  return { reasoning: inferred ? true : undefined, thinkingFormat }
}

/**
 * provider 类型 → pi-ai api 名。
 * 中转端点（OpenRouter / 硅基流动等）讲的是 OpenAI 兼容协议，即使托管了 claude /
 * gemini 模型，也不能按模型 ID 猜成 anthropic-messages / google-*。
 */
export function apiForProviderType(type: string | undefined): string | undefined {
  switch (type) {
    case 'anthropic':
      return 'anthropic-messages'
    case 'gemini':
      return 'google-generative-ai'
    case 'openai':
    case 'deepseek':
    case 'ollama':
    case 'lmstudio':
    case 'rightapi':
    case 'openrouter':
    case 'groq':
    case 'xai':
    case 'zai':
    case 'dashscope':
    case 'moonshot':
    case 'minimax':
    case 'siliconflow':
      return 'openai'
    default:
      return undefined
  }
}

/** Max 档使用的思考预算（pi-ai 默认 high=16384，Max 给两倍） */
const MAX_THINKING_BUDGET = 32_768

/** 该 API 家族是否按 token 预算控制思考（其余家族是档位语义） */
function isTokenBudgetApi(api: string): boolean {
  return api === 'anthropic-messages' || api.startsWith('google') || api === 'bedrock-converse-stream'
}

/**
 * 应用档位（high|max）→ pi-ai 参数：
 * - 预算型（Anthropic/Gemini/Bedrock）：Max 给更大思考预算，真正拉开差距
 * - 官方 OpenAI 端点：Max 用 xhigh（pi-ai 只对少数模型生效）
 * - 其余 OpenAI 兼容端点：Max 等同 High——端点多半不认 xhigh，发了直接 400
 */
export function resolveReasoningOptions(
  effort: 'high' | 'max',
  api: string,
  baseUrl: string,
): { reasoning: 'high' | 'xhigh'; thinkingBudgets?: { high: number } } {
  if (effort !== 'max') return { reasoning: 'high' }
  if (isTokenBudgetApi(api)) {
    return { reasoning: 'high', thinkingBudgets: { high: MAX_THINKING_BUDGET } }
  }
  if (baseUrl.includes('api.openai.com')) return { reasoning: 'xhigh' }
  return { reasoning: 'high' }
}
