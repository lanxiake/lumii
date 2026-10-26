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
const USD_TO_CNY = 7.2

function usdPerMToYuanPerM(usdPerM: number): number {
  return usdPerM * USD_TO_CNY
}

interface ModelPrice {
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
  /**
   * 阶梯（分段）计价：厂商按**单次请求的输入 token 总量**选档，整单按该档单价结算。
   * 有它时上面几项只是第一档的镜像（给不吃 token 数的调用方兜底），实际算钱用档位。
   */
  readonly tiers?: readonly PriceTier[]
}

/** 阶梯计价的一档；`maxPromptTokens` 为该档覆盖的输入 token 上限（含） */
interface PriceTier {
  readonly maxPromptTokens: number
  readonly price: ModelPrice
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

/**
 * 构造阶梯价。第一档同时作为兜底价（展示用），所以 `steps` 必须按 `maxPromptTokens`
 * 升序给全，最后一档通常写 `Infinity`（无上限）。
 *
 * 例：qwen3.7-flash 0-32K ¥0.2/¥0.8、32K-256K ¥0.6/¥2.4、>256K ¥1.2/¥4.8。
 */
function tiered(steps: Array<{ maxPromptTokens: number; price: ModelPrice }>): ModelPrice {
  return { ...steps[0].price, tiers: steps }
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
 * 数值来源：各模型厂商官方定价页（原 `docs/temp/模型价格.md`、`deepseek价格文档.md`
 * 草稿已随文档整理清理）。
 * 仅用于本地估算，不作账单依据。
 */
const PRICES: Readonly<Record<string, ModelPrice>> = {
  // ============ OpenAI GPT 系列（$ → 元，汇率 7.2；官方定价页核对于 2026-10-26）============
  // 缓存列口径：cacheRead = 缓存命中；cacheWrite = 默认 30 分钟写入（12 小时写入更贵，未建模）
  // gpt-6-astra: $10 / $50 / cr $1.00 / cw $12.50
  'gpt-6-astra': usdTok(10, 50, 1, 12.5),
  // gpt-6.1-sol: $2 / $10 / cr $0.10 / cw $2.50
  'gpt-6.1-sol': usdTok(2, 10, 0.1, 2.5),
  // gpt-6-sol: $2 / $10 / cr $0.20 / cw $2.50
  'gpt-6-sol': usdTok(2, 10, 0.2, 2.5),
  // gpt-6-luna: $0.10 / $0.50 / cr $0.01 / cw $0.125
  'gpt-6-luna': usdTok(0.1, 0.5, 0.01, 0.125),
  // gpt-daybreak-blue/red：接口名不同，价位与 5.6-sol / 5.6-cyber 一致
  'gpt-daybreak-blue-latest': usdTok(4, 20, 0.4, 5),
  'gpt-daybreak-red-latest': usdTok(12.5, 75, 1.25, 15.625),
  // gpt-5.6-sol: $4 / $20 / cr $0.40 / cw $5.00
  'gpt-5.6-sol': usdTok(4, 20, 0.4, 5),
  // gpt-5.6-cyber: $12.50 / $75 / cr $1.25 / cw $15.625
  'gpt-5.6-cyber': usdTok(12.5, 75, 1.25, 15.625),
  // gpt-5.6-terra: $2 / $12 / cr $0.20 / cw $2.50
  'gpt-5.6-terra': usdTok(2, 12, 0.2, 2.5),
  // gpt-5.6-luna: $0.20 / $1.20 / cr $0.02 / cw $0.25
  'gpt-5.6-luna': usdTok(0.2, 1.2, 0.02, 0.25),
  // gpt-5.5 / gpt-5.4（未在最新定价页核对，沿用原值，避免历史记录失价）
  'gpt-5.5': usdTok(5, 30, 0, 0.5),
  'gpt-5.5-openai-compact': usdTok(5, 30, 0, 0.5),
  'gpt-5.4': usdTok(2.5, 15, 0, 0.25),
  'gpt-5.4-mini': usdTok(0.75, 4.5, 0, 0.075),
  // 旧版 GPT 兼容
  'gpt-4o-mini': usdTok(0.15, 0.6),
  'gpt-4o': usdTok(2.5, 10),
  'gpt-4.1-mini': usdTok(0.4, 1.6),
  'gpt-4.1-nano': usdTok(0.1, 0.4),
  'gpt-4.1': usdTok(2, 8),
  // o3 家族单价差 10 倍，具体档位必须单独列（否则 o3-pro 会被 o3 的低价吞掉）
  'o3': usdTok(2, 8),
  'o3-mini': usdTok(1.1, 4.4),
  'o3-pro': usdTok(20, 80),

  // ============ Anthropic Claude 系列（$ → 元；官方定价页核对于 2026-10-26）============
  // claude-fable-5-1 / fable-5: $10 / $50 / cr $0.25（fable-5 为 $1）/ cw $12.50
  'claude-fable-5-1': usdTok(10, 50, 0.25, 12.5),
  'claude-fable-5': usdTok(10, 50, 1, 12.5),
  // claude-opus-5-5: $4 / $20 / cr $0.20 / cw $5
  'claude-opus-5-5': usdTok(4, 20, 0.2, 5),
  // claude-opus-5 / 4.5-4.8: $5 / $25 / cr $0.50 / cw $6.25
  'claude-opus-5': usdTok(5, 25, 0.5, 6.25),
  'claude-opus-4': usdTok(5, 25, 0.5, 6.25),
  // claude-sonnet-5-5: $2 / $10 / cr $0.10 / cw $2.50
  'claude-sonnet-5-5': usdTok(2, 10, 0.1, 2.5),
  // claude-sonnet-5: $2 / $10 / cr $0.20 / cw $2.50
  'claude-sonnet-5': usdTok(2, 10, 0.2, 2.5),
  // claude-sonnet-4-6 / 4.5 / 4: $3 / $15 / cr $0.30 / cw $3.75
  'claude-sonnet-4-6': usdTok(3, 15, 0.3, 3.75),
  'claude-sonnet-4': usdTok(3, 15, 0.3, 3.75),
  // claude-haiku-5-5 按单次输入 token 分档：≤100K $0.10/$0.50，>100K $0.50/$2.50
  'claude-haiku-5-5': tiered([
    { maxPromptTokens: 100_000, price: usdTok(0.1, 0.5, 0.01, 0.125) },
    { maxPromptTokens: Infinity, price: usdTok(0.5, 2.5, 0.05, 0.625) },
  ]),
  // claude-haiku-4-5 / 4: $1 / $5 / cr $0.10 / cw $1.25
  'claude-haiku-4-5': usdTok(1, 5, 0.1, 1.25),
  'claude-haiku-4': usdTok(1, 5, 0.1, 1.25),
  // claude-3-5-haiku: $0.80 / $4 / cr $0.08 / cw $1
  'claude-3-5-haiku': usdTok(0.8, 4, 0.08, 1),

  // ============ xAI Grok 系列（$ → 元；官方模型页核对于 2026-10-26）============
  // xAI 的缓存是自动的、不单独收写入费（cacheWrite = 0）；输入超过 200K 后整单翻倍。
  // grok-4.7 / 4.6: $2 / $6 / cr $0.50（>200K：$4 / $12 / cr $1）
  'grok-4.7': tiered([
    { maxPromptTokens: 200_000, price: usdTok(2, 6, 0.5) },
    { maxPromptTokens: Infinity, price: usdTok(4, 12, 1) },
  ]),
  'grok-4.6': tiered([
    { maxPromptTokens: 200_000, price: usdTok(2, 6, 0.5) },
    { maxPromptTokens: Infinity, price: usdTok(4, 12, 1) },
  ]),
  // grok-4.5: $2 / $6 / cr $0.30（>200K：$4 / $12 / cr $0.60）
  'grok-4.5': tiered([
    { maxPromptTokens: 200_000, price: usdTok(2, 6, 0.3) },
    { maxPromptTokens: Infinity, price: usdTok(4, 12, 0.6) },
  ]),
  // grok-4.3 / 4.20-0309-non-reasoning: $1.25 / $2.50 / cr $0.20（>200K 翻倍）
  'grok-4.3': tiered([
    { maxPromptTokens: 200_000, price: usdTok(1.25, 2.5, 0.2) },
    { maxPromptTokens: Infinity, price: usdTok(2.5, 5, 0.4) },
  ]),
  'grok-4.20-0309-non-reasoning': tiered([
    { maxPromptTokens: 200_000, price: usdTok(1.25, 2.5, 0.2) },
    { maxPromptTokens: Infinity, price: usdTok(2.5, 5, 0.4) },
  ]),
  // grok-build-0.1: $1 / $2 / cr $0.20（>200K 翻倍）
  'grok-build-0.1': tiered([
    { maxPromptTokens: 200_000, price: usdTok(1, 2, 0.2) },
    { maxPromptTokens: Infinity, price: usdTok(2, 4, 0.4) },
  ]),

  // ============ Google Gemini 系列（$ → 元）============
  // gemini-4-argon: $2 / $10 / cr $0.10
  'gemini-4-argon': usdTok(2, 10, 0.1),
  // gemini-3.8-flash / 3.7-flash / flash-latest: $0.75 / $3.75 / cr $0.075
  // （3.8-flash 的 $0.75 为限时价，2026-12-31 后回到 $1.50；届时改本行）
  'gemini-3.8-flash': usdTok(0.75, 3.75, 0.075),
  'gemini-3.7-flash': usdTok(0.75, 3.75, 0.075),
  'gemini-flash-latest': usdTok(0.75, 3.75, 0.075),
  // gemini-3.5-flash-lite / flash-lite-latest: $0.30 / $2.50 / cr $0.03
  'gemini-3.5-flash-lite': usdTok(0.3, 2.5, 0.03),
  'gemini-flash-lite-latest': usdTok(0.3, 2.5, 0.03),
  // 其余 Gemini（未在最新定价页核对，沿用原值）
  'gemini-3-flash': usdTok(0.5, 3),
  'gemini-3.1-pro': usdTok(2, 12),
  'gemini-3.5-flash': usdTok(1.5, 9),
  'gemini-3.6-flash': usdTok(1.5, 7.5),

  // ============ 生图模型（按次计费，人民币元 / 次）============
  'gpt-image-2': perCall(0.04 * USD_TO_CNY),
  'gpt-image-2.5': perCall(0.06 * USD_TO_CNY),
  'gpt-image-2-vip': perCall(0.13 * USD_TO_CNY),
  'nano-banana': perCall(0.14 * USD_TO_CNY),
  'nano-banana-2': perCall(0.12 * USD_TO_CNY),
  'nano-banana-2-lite': perCall(0.05 * USD_TO_CNY),
  'nano-banana-pro': perCall(0.18 * USD_TO_CNY),

  // ============ 智谱 GLM 系列（人民币元 / 1M；官方定价页核对于 2026-10-26）============
  // 口径：第三项是「缓存命中」（老表把 ¥2 之类的缓存命中数错填到了缓存写，已纠正）；
  // 缓存存储目前限时免费，所以 cacheWrite = 0。
  // glm-5.3: ¥8 / ¥28 / cr ¥2
  'glm-5.3': tok(8, 28, 2),
  // glm-5.3-flash: ¥0.8 / ¥2.8 / cr ¥0.23
  'glm-5.3-flash': tok(0.8, 2.8, 0.23),
  // glm-5.3-flashx: ¥2 / ¥7 / cr ¥0.57
  'glm-5.3-flashx': tok(2, 7, 0.57),
  // glm-5.2: ¥8 / ¥28 / cr ¥2
  'glm-5.2': tok(8, 28, 2),
  // glm-5.1: 输入 <32K ¥6/¥24/cr¥1.3；≥32K ¥8/¥28/cr¥2
  'glm-5.1': tiered([
    { maxPromptTokens: 32_000, price: tok(6, 24, 1.3) },
    { maxPromptTokens: Infinity, price: tok(8, 28, 2) },
  ]),
  // glm-5v-turbo / glm-5-turbo: <32K ¥5/¥22/cr¥1.2；≥32K ¥7/¥26/cr¥1.8
  'glm-5v-turbo': tiered([
    { maxPromptTokens: 32_000, price: tok(5, 22, 1.2) },
    { maxPromptTokens: Infinity, price: tok(7, 26, 1.8) },
  ]),
  'glm-5-turbo': tiered([
    { maxPromptTokens: 32_000, price: tok(5, 22, 1.2) },
    { maxPromptTokens: Infinity, price: tok(7, 26, 1.8) },
  ]),
  // glm-5: <32K ¥4/¥18/cr¥1；≥32K ¥6/¥22/cr¥1.5
  'glm-5': tiered([
    { maxPromptTokens: 32_000, price: tok(4, 18, 1) },
    { maxPromptTokens: Infinity, price: tok(6, 22, 1.5) },
  ]),
  // glm-4.7: 输入 <32K ¥3/¥14、32K-200K ¥4/¥16；cr 分别 ¥0.6 / ¥0.8
  // （<32K 还有「输出 <200 token 时 ¥2/¥8」的更低价，按常规输出取 ¥3/¥14 不低估）
  'glm-4.7': tiered([
    { maxPromptTokens: 32_000, price: tok(3, 14, 0.6) },
    { maxPromptTokens: Infinity, price: tok(4, 16, 0.8) },
  ]),
  // glm-4.5-air: <32K ¥0.8/¥6/cr¥0.16；32K-128K ¥1.2/¥8/cr¥0.24
  'glm-4.5-air': tiered([
    { maxPromptTokens: 32_000, price: tok(0.8, 6, 0.16) },
    { maxPromptTokens: Infinity, price: tok(1.2, 8, 0.24) },
  ]),
  // glm-4 家族：只写具体型号。原表用一条 `glm-4` 把 4.5/4.6/4.7 全按 ¥0.14 记，
  // 差了两个数量级，已拆开。
  'glm-4-plus': tok(5, 5, 2.5),
  'glm-4-long': tok(1, 1, 0.5),
  'glm-4-flashx': tok(0.1, 0.1, 0.05),
  'glm-4-airx': tok(10, 10),
  'glm-4-air': tok(0.5, 0.5, 0.25),
  // glm-4.6v: <32K ¥1/¥3/cr¥0.2；32K-128K ¥2/¥6/cr¥0.4
  'glm-4.6v': tiered([
    { maxPromptTokens: 32_000, price: tok(1, 3, 0.2) },
    { maxPromptTokens: Infinity, price: tok(2, 6, 0.4) },
  ]),
  // glm-4.5v: <32K ¥2/¥6/cr¥0.4；32K-64K ¥4/¥12/cr¥0.8
  'glm-4.5v': tiered([
    { maxPromptTokens: 32_000, price: tok(2, 6, 0.4) },
    { maxPromptTokens: Infinity, price: tok(4, 12, 0.8) },
  ]),

  // ============ 月之暗面 Kimi 系列（人民币元 / 1M；官方定价页核对于 2026-10-26）============
  // 平台表格的第三列是「缓存命中」（不是写入），缓存写入 5min 档与输入同价、1h 档约 2 倍。
  // kimi-k3: ¥20 / ¥100 / cr ¥2 / cw ¥20
  'kimi-k3': tok(20, 100, 2, 20),
  // kimi-k3.1-pro: ¥13 / ¥68 / cr ¥1.3 / cw ¥13
  'kimi-k3.1-pro': tok(13, 68, 1.3, 13),
  // kimi-k3.1-pro-highspeed: ¥26 / ¥136 / cr ¥1.3 / cw ¥26
  'kimi-k3.1-pro-highspeed': tok(26, 136, 1.3, 26),
  // kimi-k2.7-code: ¥6.5 / ¥27 / cr ¥1.3
  'kimi-k2.7-code': tok(6.5, 27, 1.3),
  // kimi-k2.7-code-highspeed: ¥13 / ¥54 / cr ¥2.6
  'kimi-k2.7-code-highspeed': tok(13, 54, 2.6),
  // kimi-k2.6: ¥6.5 / ¥27 / cr ¥1.1
  'kimi-k2.6': tok(6.5, 27, 1.1),
  // kimi-k2.5: ¥4 / ¥21 / cr ¥0.7（官网当前表格已不列，沿用旧表并按同一口径把 ¥0.7 归为缓存命中）
  'kimi-k2.5': tok(4, 21, 0.7),
  // 旧版 kimi-k2 兼容
  'kimi-k2': tok(0.56, 2.22),

  // ============ 阿里通义 Qwen 系列（人民币元 / 1M；官方定价页核对于 2026-10-26）============
  // 百炼的通用缓存规则：缓存命中 ≈ 输入 ×10%，显式缓存创建 ≈ 输入 ×125%
  // （qwen3.8-flash / 3.8-omni-flash 官方直接给了 ¥0.1 命中价，按官方值写）。
  // qwen3.8-flash: 0-1M ¥0.8 / ¥2.7 / cr ¥0.1
  'qwen3.8-flash': tok(0.8, 2.7, 0.1, 1),
  // qwen3.8-omni-flash: ¥0.8 / ¥2.7 / cr ¥0.1
  'qwen3.8-omni-flash': tok(0.8, 2.7, 0.1),
  // qwen3.8-max: 0-1M ¥12 / ¥36
  'qwen3.8-max': tok(12, 36, 1.2, 15),
  // qwen3.8-27b: 0-1M ¥3 / ¥12（中国内地）
  'qwen3.8-27b': tok(3, 12, 0.3, 3.75),
  // qwen3.7-max: 0-1M ¥12 / ¥36
  'qwen3.7-max': tok(12, 36, 1.2, 15),
  // qwen3.7-flash: ≤32K ¥0.2/¥0.8；32K-256K ¥0.6/¥2.4；256K-1M ¥1.2/¥4.8
  'qwen3.7-flash': tiered([
    { maxPromptTokens: 32_000, price: tok(0.2, 0.8, 0.02, 0.25) },
    { maxPromptTokens: 256_000, price: tok(0.6, 2.4, 0.06, 0.75) },
    { maxPromptTokens: Infinity, price: tok(1.2, 4.8, 0.12, 1.5) },
  ]),
  // qwen3.7-plus: ≤256K ¥2/¥8；256K-1M ¥6/¥24
  'qwen3.7-plus': tiered([
    { maxPromptTokens: 256_000, price: tok(2, 8, 0.2, 2.5) },
    { maxPromptTokens: Infinity, price: tok(6, 24, 0.6, 7.5) },
  ]),
  // qwen3.6-flash: ≤256K ¥1.2/¥7.2；256K-1M ¥4.8/¥28.8
  'qwen3.6-flash': tiered([
    { maxPromptTokens: 256_000, price: tok(1.2, 7.2, 0.12, 1.5) },
    { maxPromptTokens: Infinity, price: tok(4.8, 28.8, 0.48, 6) },
  ]),
  // qwen3.6-plus: ≤256K ¥2/¥12；256K-1M ¥8/¥48
  'qwen3.6-plus': tiered([
    { maxPromptTokens: 256_000, price: tok(2, 12, 0.2, 2.5) },
    { maxPromptTokens: Infinity, price: tok(8, 48, 0.8, 10) },
  ]),
  // qwen3.6-max-preview: ≤128K ¥9/¥54；128K-1M ¥15/¥90
  'qwen3.6-max': tiered([
    { maxPromptTokens: 128_000, price: tok(9, 54, 0.9, 11.25) },
    { maxPromptTokens: Infinity, price: tok(15, 90, 1.5, 18.75) },
  ]),
  'qwen3.6-max-preview': tiered([
    { maxPromptTokens: 128_000, price: tok(9, 54, 0.9, 11.25) },
    { maxPromptTokens: Infinity, price: tok(15, 90, 1.5, 18.75) },
  ]),
  // 旧版 qwen 兼容
  'qwen-max': tok(2.4, 9.6),
  'qwen-plus': tok(0.79, 2.02),
  'qwen-turbo': tok(0.29, 0.58),

  // ============ DeepSeek 系列（人民币元 / 1M；官方定价页核对于 2026-10-26）============
  // 下表写的是**高峰价**；闲时自动半价（见 DEEPSEEK_OFFPEAK_OVERRIDE + isDeepSeekPeakHour）。
  // 模型名以 deepseek-flash 为准；旧名 deepseek-v4-flash 仍可调用，按 Flash 计价。
  'deepseek-flash': tok(2, 8, 0.04),
  'deepseek-v4-flash': tok(2, 8, 0.04),
  'deepseek-v4-pro': tok(9, 27, 0.3),
  // 旧版 deepseek-chat / reasoner（保留兼容）
  'deepseek-chat': tok(0.27, 1.1),
  'deepseek-reasoner': tok(0.55, 2.19),

  // ============ MiniMax（人民币元 / 1M；官方定价页核对于 2026-10-26）============
  // minimax-m3: ≤512K ¥2.1/¥8.4/cr¥0.42（永久五折价）；>512K ¥4.2/¥16.8/cr¥0.84
  'minimax-m3': tiered([
    { maxPromptTokens: 512_000, price: tok(2.1, 8.4, 0.42) },
    { maxPromptTokens: Infinity, price: tok(4.2, 16.8, 0.84) },
  ]),
  // minimax-m3.1-flash: ¥1 / ¥4 / cr ¥0.1
  'minimax-m3.1-flash': tok(1, 4, 0.1),
  // 旧档位（官网当前只列 M3 / M3.1-Flash，以下保留 models.dev 折算值，避免历史记录失价）
  'minimax-m2.1': usdTok(0.3, 1.2, 0.03, 0.375),
  'minimax-m2.5': usdTok(0.3, 1.2, 0.03, 0.375),
  'minimax-m2.5-highspeed': usdTok(0.6, 2.4, 0.06, 0.375),
  'minimax-m2.7': usdTok(0.3, 1.2, 0.06, 0.375),
  'minimax-m2.7-highspeed': usdTok(0.6, 2.4, 0.06, 0.375),

  // ============ 其他（models.dev 折算，未逐条核官网）============
  // LongCat
  'longcat-2.0': usdTok(0.3, 1.2, 0.006, 0),
  'longcat-2.5-preview': usdTok(0.3, 1.2, 0.006, 0),
  // MiMo
  'mimo-v2.5': usdTok(0.14, 0.28, 0.0028, 0),
  'mimo-v2.5-pro': usdTok(0.435, 0.87, 0.0036, 0),
  'mimo-v2.5-pro-ultraspeed': usdTok(1.305, 2.61, 0.0108, 0),
  'mimo-v2.6-flash': usdTok(0.14, 0.28, 0.0028, 0),
  'mimo-v2.6-pro': usdTok(0.435, 0.87, 0.0036, 0),
  'mimo-v2.6-pro-ultraspeed': usdTok(4.35, 8.7, 0.036, 0),
}

/** DeepSeek 闲时价格表。闲时 = 高峰 × 0.5（官方：「空闲时段价格为高峰时段价格的一半」） */
const DEEPSEEK_OFFPEAK_OVERRIDE: Readonly<Record<string, ModelPrice>> = {
  'deepseek-flash': tok(1, 4, 0.02),
  'deepseek-v4-flash': tok(1, 4, 0.02),
  'deepseek-v4-pro': tok(4.5, 13.5, 0.15),
}

/** 本地推理的模型 id 特征，命中即视为零成本而非未知价格 */
const LOCAL_HINTS = ['ollama', 'lmstudio', 'llama.cpp', 'localhost', '127.0.0.1'] as const

/** 该模型是否跑在本机（本机推理成本记 0，不是「价格未知」） */
export function isLocalModel(modelId: string): boolean {
  const id = modelId.toLowerCase()
  return LOCAL_HINTS.some((hint) => id.includes(hint))
}

/**
 * **用户自定义价格**：按模型前缀覆盖内置表。
 *
 * 为什么要这一层：内置表只写「有据可查的」厂商官网价，而用户实际走的往往是
 * 中转/自建网关，单价跟官网不一样（折扣、包月、加价）。没有这一层时，
 * 用量面板上的花费就是一个跟真实账单对不上的数字——比显示「—」更糟。
 *
 * 匹配口径与内置表一致（大小写不敏感的最长前缀），**自定义优先**：
 * 同一前缀两边都有时用自定义那份，用户改过就是用户说了算。
 * 只存在于内存 + 落盘文件，不上传、不联网。
 */
export interface ModelPriceInput {
  inputYuanPerMTok: number
  outputYuanPerMTok: number
  cacheReadYuanPerMTok?: number
  cacheWriteYuanPerMTok?: number
  /** 按次计费（生图）填这个，token 三项可填 0 */
  perCallYuan?: number
}

/** 前缀 → 价格。进程内单例，主进程启动时从磁盘载入一次 */
let priceOverrides: Record<string, ModelPrice> = {}

/** 把一段用户输入收成合法的 ModelPrice；有任何非法字段就整条丢弃（不猜） */
function parsePriceInput(raw: unknown): ModelPrice | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
  const input = num(o.inputYuanPerMTok)
  const output = num(o.outputYuanPerMTok)
  if (input === null || output === null) return null
  const perCall = o.perCallYuan === undefined ? null : num(o.perCallYuan)
  if (o.perCallYuan !== undefined && perCall === null) return null
  return {
    inputYuanPerMTok: input,
    outputYuanPerMTok: output,
    cacheReadYuanPerMTok: num(o.cacheReadYuanPerMTok) ?? 0,
    cacheWriteYuanPerMTok: num(o.cacheWriteYuanPerMTok) ?? 0,
    ...(perCall !== null ? { perCallYuan: perCall } : {}),
  }
}

/** 写入用户自定义价格（整表替换，空对象 = 清空）。坏条目逐条丢弃，绝不抛 */
export function setPriceOverrides(raw: unknown): void {
  const next: Record<string, ModelPrice> = {}
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const prefix = key.trim().toLowerCase()
      if (!prefix) continue
      const parsed = parsePriceInput(value)
      if (parsed) next[prefix] = parsed
    }
  }
  priceOverrides = next
}

/** 当前生效的自定义价格（给设置页回显用） */
export function getPriceOverrides(): Record<string, ModelPriceInput> {
  const out: Record<string, ModelPriceInput> = {}
  for (const [prefix, p] of Object.entries(priceOverrides)) {
    out[prefix] = {
      inputYuanPerMTok: p.inputYuanPerMTok,
      outputYuanPerMTok: p.outputYuanPerMTok,
      ...(p.cacheReadYuanPerMTok ? { cacheReadYuanPerMTok: p.cacheReadYuanPerMTok } : {}),
      ...(p.cacheWriteYuanPerMTok ? { cacheWriteYuanPerMTok: p.cacheWriteYuanPerMTok } : {}),
      ...(p.perCallYuan !== undefined ? { perCallYuan: p.perCallYuan } : {}),
    }
  }
  return out
}

/**
 * 内置价目表（只读快照）。设置页的「同步内置价格」用它把某个模型恢复成官方价，
 * 也让用户一眼看出「哪些模型本来就有价」。
 */
export function listBuiltinPrices(): Array<{ prefix: string; price: ModelPriceInput }> {
  return Object.entries(PRICES).map(([prefix, p]) => ({
    prefix,
    price: {
      inputYuanPerMTok: p.inputYuanPerMTok,
      outputYuanPerMTok: p.outputYuanPerMTok,
      ...(p.cacheReadYuanPerMTok ? { cacheReadYuanPerMTok: p.cacheReadYuanPerMTok } : {}),
      ...(p.cacheWriteYuanPerMTok ? { cacheWriteYuanPerMTok: p.cacheWriteYuanPerMTok } : {}),
      ...(p.perCallYuan !== undefined ? { perCallYuan: p.perCallYuan } : {}),
    },
  }))
}

/** 该模型是否命中了用户自定义价（命中就不该再套 DeepSeek 峰谷价——那是内置表的规则） */
function hasCustomPrice(modelId: string): boolean {
  const id = modelId.toLowerCase()
  return Object.keys(priceOverrides).some((prefix) => id.includes(prefix))
}

/** 内置表里有没有这个前缀（给「恢复官方价」按钮判断可用性） */
export function hasBuiltinPrice(modelId: string): boolean {
  const id = modelId.toLowerCase()
  return Object.keys(PRICES).some((prefix) => id.includes(prefix))
}

/**
 * 判断给定时间戳（epoch ms）是否为 DeepSeek 高峰时段。
 *
 * 官方规则：北京时间**周一至周五**（不含中国法定节假日）09:00-12:00、14:00-18:00 为高峰；
 * 其余时段（含周末）全天闲时。
 *
 * 节假日没有内置日历 → 法定节假日会被当成高峰，属于「宁可高估」的偏差（半天 ×2）。
 * 要精确就接一份节假日表；这里先不做。
 */
function isDeepSeekPeakHour(tsMs: number): boolean {
  // 先整体挪到 UTC+8 再取日期/时间，否则 UTC 16:00 之后「北京已跨日、周几却还是前一天」
  const bj = new Date(tsMs + 8 * 3_600_000)
  const day = bj.getUTCDay() // 0 = 周日
  if (day === 0 || day === 6) return false
  const t = bj.getUTCHours() * 60 + bj.getUTCMinutes()
  // 09:00-12:00 = 540-720 min; 14:00-18:00 = 840-1080 min（含起始，不含结束边界）
  return (t >= 540 && t < 720) || (t >= 840 && t < 1080)
}

/**
 * 取模型基础价格（最长前缀匹配）；查不到返回 undefined。
 *
 * 先查**用户自定义**再查内置：用户改过的价就是他实际付的价，内置表只是缺省。
 * 注意：此函数不处理 DeepSeek 峰谷价，只返回「高峰价（保守）」。
 * 真实花费估算请调用 estimateCostYuan。
 */
function lookupModelPrice(modelId: string): ModelPrice | undefined {
  const id = modelId.toLowerCase()
  let matched: ModelPrice | undefined
  let matchedLen = 0
  for (const table of [priceOverrides, PRICES]) {
    for (const [prefix, price] of Object.entries(table)) {
      if (id.includes(prefix) && prefix.length > matchedLen) {
        matched = price
        matchedLen = prefix.length
      }
    }
    // 自定义表命中就不用再看内置（哪怕内置有更长前缀）——用户显式改过就是答案
    if (matched) return matched
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

  const {
    inputTokens = 0,
    outputTokens = 0,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
    callCount = 1,
  } = tokens

  let price = lookupModelPrice(modelId)
  if (!price) return undefined

  // 阶梯计价：按单次请求的输入总量（未命中 + 缓存读 + 缓存写）整单落档
  if (price.tiers?.length) {
    const promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens
    const hit = price.tiers.find((t) => promptTokens <= t.maxPromptTokens)
    price = (hit ?? price.tiers[price.tiers.length - 1]).price
  }

  // DeepSeek 闲时覆盖：只有显式给了时间戳且判定为闲时才切；否则默认高峰（保守）
  // 用户给这个模型填了自定义价就跳过——峰谷价是内置表的规则，不该盖掉用户填的数
  if (tsMs !== undefined && modelId.toLowerCase().includes('deepseek') && !hasCustomPrice(modelId)) {
    if (!isDeepSeekPeakHour(tsMs)) {
      const override = lookupDeepSeekOffpeakOverride(modelId)
      if (override) price = override
    }
  }

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
function estimateCostCents(
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
const CNY_PER_USD = USD_TO_CNY
/** @deprecated 直接处理人民币元 */
function centsToCny(cents: number): number {
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
function formatCostCny(cents: number | undefined): string {
  if (cents === undefined) return '—'
  return formatCostYuan(centsToCny(cents))
}
