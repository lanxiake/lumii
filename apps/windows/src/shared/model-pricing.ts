/**
 * 模型价格表（人民币：元 / 百万 token 或 元 / 次）。
 *
 * 只做「有据可查的才写」：查不到价格的模型返回 undefined，UI 显示「—」，
 * 绝不用 0 冒充免费——本地模型的 0 成本和未知价格是两件事，靠 `isLocalModel` 区分。
 *
 * 计费维度：
 *   - 输入（cache miss）、输出：常规 token 计费
 *   - cacheRead / cacheWrite：Anthropic / OpenAI 等厂商独立定价，未公布则取 0
 *   - 按次计费：生图模型（gpt-image-2、nano-banana 等）不走 token，每次固定价
 *
 * 国内模型：文档中标注 ¥ 的直接照抄（元 / 1M）
 * 国外模型：文档中标注 $ 的按汇率 7.2 折算为元
 */

/** 美元 → 人民币折算汇率（本地估算用，非实时） */
export const USD_TO_CNY = 7.2

function usdPerMToYuanPerM(usdPerM: number): number {
  return usdPerM * USD_TO_CNY
}

export interface ModelPrice {
  /** 输入价（缓存未命中），元 / 1M token */
  readonly inputYuanPerMTok: number
  /** 输出价，元 / 1M token */
  readonly outputYuanPerMTok: number
  /** 缓存命中（读）价，元 / 1M token。未单独定价的模型填 0（与 input 同价） */
  readonly cacheReadYuanPerMTok: number
  /** 缓存写入价，元 / 1M token。未单独定价的模型填 0 */
  readonly cacheWriteYuanPerMTok: number
  /** 按次计费（生图等），元 / 次。按 token 计费的模型填 undefined */
  readonly perCallYuan?: number
}

/** 构造按 token 计费的价格项（元 / 1M，cache 未公布时按 0 处理） */
function tok(
  input: number,
  output: number,
  cacheRead: number = 0,
  cacheWrite: number = 0,
): ModelPrice {
  return {
    inputYuanPerMTok: input,
    outputYuanPerMTok: output,
    cacheReadYuanPerMTok: cacheRead,
    cacheWriteYuanPerMTok: cacheWrite,
  }
}

/** 美元文档 → 人民币 token 价格。参数同 tok()，但单位是 $ / 1M */
function usdTok(
  inputUsd: number,
  outputUsd: number,
  cacheReadUsd: number = 0,
  cacheWriteUsd: number = 0,
): ModelPrice {
  return tok(
    usdPerMToYuanPerM(inputUsd),
    usdPerMToYuanPerM(outputUsd),
    usdPerMToYuanPerM(cacheReadUsd),
    usdPerMToYuanPerM(cacheWriteUsd),
  )
}

/** 构造按次计费的价格项 */
function perCall(yuan: number): ModelPrice {
  return {
    inputYuanPerMTok: 0,
    outputYuanPerMTok: 0,
    cacheReadYuanPerMTok: 0,
    cacheWriteYuanPerMTok: 0,
    perCallYuan: yuan,
  }
}

/**
 * 价格表。key 为小写模型 id 的匹配前缀，取最长匹配。
 * 数值来源：docs/temp/模型价格.md 与 docs/temp/deepseek价格文档.md
 * 仅用于本地估算，不作账单依据。
 */
const PRICES: Readonly<Record<string, ModelPrice>> = {
  // ============ OpenAI GPT 系列（$ → 元，汇率 7.2） ============
  // gpt-5.4: $2.5/M 入, $15/M 出, cache write $0.25/M
  'gpt-5.4': usdTok(2.5, 15, 0, 0.25),
  // gpt-5.4-mini: $0.75/M 入, $4.5/M 出, cache write $0.075/M
  'gpt-5.4-mini': usdTok(0.75, 4.5, 0, 0.075),
  // gpt-5.5 / gpt-5.5-openai-compact: $5/M 入, $30/M 出, cache write $0.5/M
  'gpt-5.5': usdTok(5, 30, 0, 0.5),
  'gpt-5.5-openai-compact': usdTok(5, 30, 0, 0.5),
  // gpt-5.6-luna: $0.2/M 入, $1.2/M 出, cache write $0.25/M, cache read $0.02/M
  'gpt-5.6-luna': usdTok(0.2, 1.2, 0.02, 0.25),
  // gpt-5.6-sol 上下文 ≤272K 段: $5/$30/$6.25(cw)/$0.5(cr?文档列3 cache write;列4 cache read 按 $0.5/M)
  // 其余段: $10/$45/$12.5/$1。这里取较贵的「其余」段做保守估算，长上下文不低估。
  'gpt-5.6-sol': usdTok(10, 45, 1, 12.5),
  // gpt-5.6-terra: $2/$12/$2.5(cw)/$0.2(cr)
  'gpt-5.6-terra': usdTok(2, 12, 0.2, 2.5),
  // 旧版 GPT 兼容（保留，避免历史记录失价）
  'gpt-4o-mini': usdTok(0.15, 0.6),
  'gpt-4o': usdTok(2.5, 10),
  'gpt-4.1-mini': usdTok(0.4, 1.6),
  'gpt-4.1': usdTok(2, 8),
  o3: usdTok(2, 8),

  // ============ Anthropic Claude 系列（$ → 元） ============
  // claude-fable-5: $10/$50/$12.5(cw)/$1(cr)
  'claude-fable-5': usdTok(10, 50, 1, 12.5),
  // claude-haiku-4-5-20251001: $1/$5/$1.25(cw)/$0.1(cr)
  'claude-haiku-4-5': usdTok(1, 5, 0.1, 1.25),
  // claude-opus-4-6 / 4-7 / 4-8 / 5: $5/$25/$6.25(cw)/$0.5(cr)
  'claude-opus-4': usdTok(5, 25, 0.5, 6.25),
  'claude-opus-5': usdTok(5, 25, 0.5, 6.25),
  // claude-sonnet-4-6: $3/$15/$3.75(cw)/$0.3(cr)
  'claude-sonnet-4-6': usdTok(3, 15, 0.3, 3.75),
  'claude-sonnet-4': usdTok(3, 15, 0.3, 3.75),
  // claude-sonnet-5: $2/$10/$2.5(cw)/$0.2(cr)
  'claude-sonnet-5': usdTok(2, 10, 0.2, 2.5),
  // 旧版
  'claude-haiku-4': usdTok(1, 5, 0.1, 1.25),
  'claude-3-5-haiku': usdTok(0.8, 4),

  // ============ xAI Grok 系列（$ → 元） ============
  // grok-4.5: $2/$6/$2(cw)/$0.3(cr)
  'grok-4.5': usdTok(2, 6, 0.3, 2),
  // grok-4.6: $2/$6/$2(cw)/$0.5(cr)
  'grok-4.6': usdTok(2, 6, 0.5, 2),

  // ============ Google Gemini 系列（$ → 元） ============
  // gemini-3-flash-preview: $0.5/$3
  'gemini-3-flash': usdTok(0.5, 3),
  // gemini-3.1-pro / preview: $2/$12
  'gemini-3.1-pro': usdTok(2, 12),
  // gemini-3.5-flash: $1.5/$9
  'gemini-3.5-flash': usdTok(1.5, 9),
  // gemini-3.6-flash: $1.5/$7.5
  'gemini-3.6-flash': usdTok(1.5, 7.5),

  // ============ 生图模型（按次计费，人民币元 / 次）============
  // gpt-image-2: $0.04/次
  'gpt-image-2': perCall(0.04 * USD_TO_CNY),
  // gpt-image-2-vip: $0.13/次
  'gpt-image-2-vip': perCall(0.13 * USD_TO_CNY),
  // nano-banana: $0.14/次
  'nano-banana': perCall(0.14 * USD_TO_CNY),
  // nano-banana-2: $0.12/次
  'nano-banana-2': perCall(0.12 * USD_TO_CNY),
  // nano-banana-2-lite: $0.05/次
  'nano-banana-2-lite': perCall(0.05 * USD_TO_CNY),
  // nano-banana-pro: $0.18/次
  'nano-banana-pro': perCall(0.18 * USD_TO_CNY),

  // ============ 智谱 GLM 系列（人民币元 / 1M）============
  // glm-4.7 上下文 ≤32K · 出 ≤200：¥2/¥8 cache write ¥0.4
  // 其余上下文 ≤32K：¥3/¥14 cache write ¥0.6
  // 取较贵的段保守估算
  'glm-4.7': tok(3, 14, 0, 0.6),
  // glm-5 上下文 ≤32K：¥4/¥18 cache write ¥1；其余：¥6/¥22 cache write ¥1.5 → 取其余
  'glm-5': tok(6, 22, 0, 1.5),
  // glm-5.1 上下文 ≤32K：¥6/¥24 cw ¥1.3；其余 ¥8/¥28 cw ¥2 → 取其余
  'glm-5.1': tok(8, 28, 0, 2),
  // glm-5.2: ¥8/¥28 cw ¥2
  'glm-5.2': tok(8, 28, 0, 2),
  // 旧版 glm-4 兼容
  'glm-4': tok(0.14, 0.14),

  // ============ 月之暗面 Kimi 系列（人民币元 / 1M）============
  // kimi-k2.5: ¥4/¥21 cw ¥0.7
  'kimi-k2.5': tok(4, 21, 0, 0.7),
  // kimi-k2.6: ¥6.5/¥27 cw ¥1.1
  'kimi-k2.6': tok(6.5, 27, 0, 1.1),
  // kimi-k2.7-code: ¥6.5/¥27 cw ¥1.3
  'kimi-k2.7-code': tok(6.5, 27, 0, 1.3),
  // 旧版 kimi-k2 兼容（文档未列，沿用原值，折算后约 ¥0.56/¥2.22 —— 但 ¥ 口径此处直接写原估算）
  'kimi-k2': tok(0.56, 2.22),

  // ============ 阿里通义 Qwen 系列（人民币元 / 1M）============
  // qwen3.6-flash: ≤256K 时 ¥1.2/¥7.2 cr¥1.5 cw¥0.12；其余 ¥4.8/¥28.8 cr¥6 cw¥0.48 → 取其余保守
  'qwen3.6-flash': tok(4.8, 28.8, 6, 0.48),
  // qwen3.6-max-preview: ≤128K ¥9/¥54 cr¥11.25 cw¥0.9；其余 ¥15/¥90 cr¥18.75 cw¥1.5 → 取其余
  'qwen3.6-max': tok(15, 90, 18.75, 1.5),
  'qwen3.6-max-preview': tok(15, 90, 18.75, 1.5),
  // qwen3.6-plus: ≤256K ¥0.5/¥3 cr¥0.625 cw¥0.05；其余 ¥2/¥6 cr¥2.5 cw¥0.2 → 取其余
  'qwen3.6-plus': tok(2, 6, 2.5, 0.2),
  // qwen3.7-max: ¥12/¥36 cr¥15 cw¥2.4
  'qwen3.7-max': tok(12, 36, 15, 2.4),
  // qwen3.7-plus: ≤256K ¥2/¥8 cr¥2.5 cw¥0.2；其余 ¥6/¥24 cr¥7.5 cw¥0.6 → 取其余
  'qwen3.7-plus': tok(6, 24, 7.5, 0.6),
  // 旧版 qwen 兼容（折算口径：原注释 qwen-max ¥33/133 美分 = $0.33/$1.33 → 新体系统一为 ¥/1M，需重新对齐）
  // 原注释 ¥ 折算：qwen-max 33 美分 = $0.33 → 人民币约 ¥2.38/1M。为避免与新文档冲突，保留旧估算即可。
  'qwen-max': tok(2.38, 9.58),
  'qwen-plus': tok(0.79, 2.02),
  'qwen-turbo': tok(0.29, 0.58),

  // ============ DeepSeek 系列（人民币元 / 1M。高峰/闲时在 estimateCostYuan 中按时间戳动态切换）============
  // 高峰时段（默认，保守）：v4-flash cache未命中入 ¥3.0 / cache命中 ¥0.10 / 输出 ¥9.0
  //                      v4-pro  cache未命中入 ¥9.0 / cache命中 ¥0.30 / 输出 ¥27.0
  'deepseek-v4-flash': tok(3, 9, 0.1, 0),
  'deepseek-v4-pro': tok(9, 27, 0.3, 0),
  // 旧版 deepseek-chat / reasoner（原值：¥0.27/¥1.10、¥0.55/¥2.19 —— 保留兼容）
  'deepseek-chat': tok(0.27, 1.1),
  'deepseek-reasoner': tok(0.55, 2.19),
}

/** DeepSeek 高峰闲时价格覆盖表。闲时 = 高峰 × 0.5（文档明确「空闲时段价格为高峰时段价格的一半」） */
const DEEPSEEK_OFFPEAK_OVERRIDE: Readonly<Record<string, ModelPrice>> = {
  'deepseek-v4-flash': tok(1.5, 4.5, 0.05, 0),
  'deepseek-v4-pro': tok(4.5, 13.5, 0.15, 0),
}

/** 本地推理的模型 id 特征，命中即视为零成本而非未知价格 */
const LOCAL_HINTS = ['ollama', 'lmstudio', 'llama.cpp', 'localhost', '127.0.0.1'] as const

/** 该模型是否跑在本机（本机推理成本记 0，不是「价格未知」） */
export function isLocalModel(modelId: string): boolean {
  const id = modelId.toLowerCase()
  return LOCAL_HINTS.some((hint) => id.includes(hint))
}

/**
 * 判断给定时间戳（epoch ms）是否为 DeepSeek 高峰时段。
 * 高峰：北京时间 09:00-12:00、14:00-18:00（UTC+8）
 */
export function isDeepSeekPeakHour(tsMs: number): boolean {
  const d = new Date(tsMs)
  const beijingHour = (d.getUTCHours() + 8) % 24
  const beijingMinute = d.getUTCMinutes()
  const t = beijingHour * 60 + beijingMinute
  // 09:00-12:00 = 540-720 min; 14:00-18:00 = 840-1080 min（含起始，不含结束边界）
  return (t >= 540 && t < 720) || (t >= 840 && t < 1080)
}

/**
 * 取模型基础价格（最长前缀匹配）；查不到返回 undefined。
 * 注意：此函数不处理 DeepSeek 峰谷价，只返回「高峰价（保守）」。
 * 真实花费估算请调用 estimateCostYuan。
 */
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

/** 最长前缀匹配 DeepSeek 闲时覆盖表，命中则返回闲时价格 */
function lookupDeepSeekOffpeakOverride(modelId: string): ModelPrice | undefined {
  const id = modelId.toLowerCase()
  let matched: ModelPrice | undefined
  let matchedLen = 0
  for (const [prefix, price] of Object.entries(DEEPSEEK_OFFPEAK_OVERRIDE)) {
    if (id.includes(prefix) && prefix.length > matchedLen) {
      matched = price
      matchedLen = prefix.length
    }
  }
  return matched
}

/** 估算花费时使用的 token 明细入参 */
export interface TokenBreakdown {
  /** 输入（未命中缓存的部分） */
  inputTokens?: number
  /** 输出 */
  outputTokens?: number
  /** 缓存命中（读），通常来自 usage.cacheRead */
  cacheReadTokens?: number
  /** 缓存写入，通常来自 usage.cacheWrite */
  cacheWriteTokens?: number
  /** 调用次数（按次计费模型默认 1 次）。传入 0 则跳过 per-call 项 */
  callCount?: number
}

/**
 * 估算一次调用的花费（人民币元，保留 6 位小数避免累计丢失）。
 *
 * - 本地模型 → 0
 * - 按次计费模型（生图）→ 忽略 token，按次计价
 * - 按 token 模型：input + cacheRead + cacheWrite + output 分项 × 各自单价
 * - 价格未知 → undefined（UI 显示「—」）
 *
 * @param tsMs 调用时间戳（epoch ms），用于判断 DeepSeek 峰谷价；缺省按高峰（保守）估算
 */
export function estimateCostYuan(
  modelId: string,
  tokens: TokenBreakdown,
  tsMs?: number,
): number | undefined {
  if (isLocalModel(modelId)) return 0

  let price = lookupModelPrice(modelId)
  if (!price) return undefined

  // DeepSeek 闲时覆盖：只有显式给了时间戳且判定为闲时才切；否则默认高峰（保守）
  if (tsMs !== undefined && modelId.toLowerCase().includes('deepseek')) {
    if (!isDeepSeekPeakHour(tsMs)) {
      const override = lookupDeepSeekOffpeakOverride(modelId)
      if (override) price = override
    }
  }

  const {
    inputTokens = 0,
    outputTokens = 0,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
    callCount = 1,
  } = tokens

  const M = 1_000_000
  let yuan =
    (inputTokens / M) * price.inputYuanPerMTok +
    (outputTokens / M) * price.outputYuanPerMTok +
    (cacheReadTokens / M) * price.cacheReadYuanPerMTok +
    (cacheWriteTokens / M) * price.cacheWriteYuanPerMTok

  if (price.perCallYuan !== undefined) {
    yuan += price.perCallYuan * callCount
  }

  return Math.round(yuan * 1_000_000) / 1_000_000
}

/**
 * 旧接口兼容：estimateCostCents 已废弃，统一用人民币。
 * 保留此导出避免外部直接引用处编译报错，内部不再推荐使用。
 * @deprecated 请使用 estimateCostYuan（人民币口径，直接返回元）
 */
export function estimateCostCents(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
): number | undefined {
  const yuan = estimateCostYuan(modelId, {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
  })
  if (yuan === undefined) return undefined
  // 元 → 美分：先折算为美元再 ×100（即 yuan / 7.2 * 100 = yuan * 100/7.2）
  return Math.round((yuan * (100 / USD_TO_CNY)) * 10_000) / 10_000
}

/**
 * 美分 → 人民币数值（元）。保留给用量 JSONL 中历史 `costCents` 字段做一次性迁移换算，
 * 新代码请直接使用人民币元。
 * @deprecated 新代码直接处理元
 */
export const CNY_PER_USD = USD_TO_CNY
/** @deprecated 直接处理人民币元 */
export function centsToCny(cents: number): number {
  return (cents / 100) * CNY_PER_USD
}

/**
 * 格式化成人民币字符串（中文单位「元」）。
 * - undefined → 「—」（无价目表时不能显示 0）
 * - ≥ 1 元：保留 2 位小数
 * - < 1 元：保留 4 位小数（体现 sub-cent 的 token 花费）
 */
export function formatCostYuan(yuan: number | undefined): string {
  if (yuan === undefined) return '—'
  return yuan >= 1 ? `${yuan.toFixed(2)} 元` : `${yuan.toFixed(4)} 元`
}

/**
 * 旧接口兼容：formatCostCny 内部已改为直接吃美分并折算（即保留原签名不变）。
 * @deprecated 新代码请使用 formatCostYuan，直接传人民币元
 */
export function formatCostCny(cents: number | undefined): string {
  if (cents === undefined) return '—'
  return formatCostYuan(centsToCny(cents))
}
