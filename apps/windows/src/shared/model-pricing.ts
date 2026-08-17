/**
 * 模型价格表（美分 / 百万 token）。
 *
 * 只做「有据可查的才写」：查不到价格的模型返回 undefined，UI 显示「—」，
 * 绝不用 0 冒充免费——本地模型的 0 成本和未知价格是两件事，靠 `isLocal` 区分。
 */

export interface ModelPrice {
  /** 输入价，美分 / 1M token */
  readonly inputCentsPerMTok: number
  /** 输出价，美分 / 1M token */
  readonly outputCentsPerMTok: number
}

/**
 * 价格表。key 为小写模型 id 的匹配前缀，取最长匹配。
 * 数值来源为各服务商公开价目表，可能滞后；只用于本地估算，不作账单依据。
 */
const PRICES: Readonly<Record<string, ModelPrice>> = {
  // Anthropic
  'claude-opus-4': { inputCentsPerMTok: 1500, outputCentsPerMTok: 7500 },
  'claude-sonnet-4': { inputCentsPerMTok: 300, outputCentsPerMTok: 1500 },
  'claude-haiku-4': { inputCentsPerMTok: 100, outputCentsPerMTok: 500 },
  'claude-3-5-haiku': { inputCentsPerMTok: 80, outputCentsPerMTok: 400 },
  // OpenAI
  'gpt-4o-mini': { inputCentsPerMTok: 15, outputCentsPerMTok: 60 },
  'gpt-4o': { inputCentsPerMTok: 250, outputCentsPerMTok: 1000 },
  'gpt-4.1-mini': { inputCentsPerMTok: 40, outputCentsPerMTok: 160 },
  'gpt-4.1': { inputCentsPerMTok: 200, outputCentsPerMTok: 800 },
  o3: { inputCentsPerMTok: 200, outputCentsPerMTok: 800 },
  // DeepSeek（官方价格以人民币计，换算为美分/1M；空闲时段 + cache miss 口径）
  // v4-pro: 输入 4.5 元/1M = 4.5/7.2 ≈ 0.625 USD = 62.5 美分；输出 13.5 元/1M ≈ 187.5 美分
  // v4-flash: 输入 1.5 元/1M ≈ 20.83 美分；输出 4.5 元/1M ≈ 62.5 美分
  'deepseek-v4-pro': { inputCentsPerMTok: 62.5, outputCentsPerMTok: 187.5 },
  'deepseek-v4-flash': { inputCentsPerMTok: 20.83, outputCentsPerMTok: 62.5 },
  'deepseek-chat': { inputCentsPerMTok: 27, outputCentsPerMTok: 110 },
  'deepseek-reasoner': { inputCentsPerMTok: 55, outputCentsPerMTok: 219 },
  // 阿里通义 / 智谱 / 月之暗面（按公开人民币价折算，约 7.2 汇率）
  'qwen-max': { inputCentsPerMTok: 33, outputCentsPerMTok: 133 },
  'qwen-plus': { inputCentsPerMTok: 11, outputCentsPerMTok: 28 },
  'qwen-turbo': { inputCentsPerMTok: 4, outputCentsPerMTok: 8 },
  'glm-4': { inputCentsPerMTok: 14, outputCentsPerMTok: 14 },
  'kimi-k2': { inputCentsPerMTok: 56, outputCentsPerMTok: 222 },
}

/** 本地推理的模型 id 特征，命中即视为零成本而非未知价格 */
const LOCAL_HINTS = ['ollama', 'lmstudio', 'llama.cpp', 'localhost', '127.0.0.1'] as const

/** 该模型是否跑在本机（本机推理成本记 0，不是「价格未知」） */
export function isLocalModel(modelId: string): boolean {
  const id = modelId.toLowerCase()
  return LOCAL_HINTS.some((hint) => id.includes(hint))
}

/** 取模型价格；查不到返回 undefined（调用方须显示「—」而非 0） */
export function lookupModelPrice(modelId: string): ModelPrice | undefined {
  const id = modelId.toLowerCase()
  let matched: ModelPrice | undefined
  let matchedLen = 0
  for (const [prefix, price] of Object.entries(PRICES)) {
    if (id.includes(prefix) && prefix.length > matchedLen) {
      matched = price
      matchedLen = prefix.length
    }
  }
  return matched
}

/**
 * 估算一次调用的花费（美分，保留 4 位小数）。
 *
 * - 本地模型 → 0
 * - 价格未知 → undefined（UI 显示「—」）
 */
export function estimateCostCents(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
): number | undefined {
  if (isLocalModel(modelId)) return 0
  const price = lookupModelPrice(modelId)
  if (!price) return undefined
  const cents =
    (promptTokens / 1_000_000) * price.inputCentsPerMTok +
    (completionTokens / 1_000_000) * price.outputCentsPerMTok
  return Math.round(cents * 10_000) / 10_000
}

/** 美分 → 人民币展示的固定汇率。价目表本身是美元计价，换算仅供本地参考 */
export const CNY_PER_USD = 7.2

/** 美分 → 人民币数值（元） */
export function centsToCny(cents: number): number {
  return (cents / 100) * CNY_PER_USD
}

/**
 * 美分格式化成人民币字符串（中文单位「元」）。
 * undefined → 「—」（无价目表时不能显示 0）
 */
export function formatCostCny(cents: number | undefined): string {
  if (cents === undefined) return '—'
  const cny = centsToCny(cents)
  return cny >= 1 ? `${cny.toFixed(2)} 元` : `${cny.toFixed(4)} 元`
}
