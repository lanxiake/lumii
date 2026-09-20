/**
 * 模型配置服务 — 灵栖/Lumii 独立版（按能力槽 chat/vision/image）
 *
 * 各槽可独立配置 Provider（例如 chat=DeepSeek，image=OpenAI）。
 * Agent 主对话走 chat 槽；视觉/生图走对应槽。
 */

/** provider 类型 */
export type ProviderType =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'ollama'
  | 'lmstudio'
  | 'rightapi'
  | 'deepseek'
  | 'openrouter'
  | 'groq'
  | 'xai'
  | 'zai'
  | 'dashscope'
  | 'moonshot'
  | 'minimax'
  | 'siliconflow'

/** 模型能力槽 */
export type CapabilitySlot = 'chat' | 'vision' | 'image'

/** 思考参数格式（与 main/provider-config.ts 对齐） */
export type ThinkingFormat = 'auto' | 'openai' | 'qwen' | 'zai'

/** 单槽配置视图 */
export interface LocalProviderConfigView {
  enabled: boolean
  type: ProviderType
  baseUrl: string
  modelId: string
  apiKey: string
  /** 盘上有密文但解不开（此时 apiKey 为空是读失败，不是用户没填），见 main/provider-config.ts */
  apiKeyDecryptFailed?: boolean
  /** chat/vision：对话框可选模型；缺省时回退 [modelId] */
  allowedModelIds?: string[]
  /** API 格式（openai/deepseek 用）：completions 或 responses，默认 responses */
  apiFormat?: 'completions' | 'responses'
  contextWindowK?: Record<string, number>
  /** 按模型声明是否支持思考；缺省按内置默认表推断 */
  modelReasoning?: Record<string, boolean>
  /** 思考参数格式，缺省 auto */
  thinkingFormat?: ThinkingFormat
}

/** 全部能力槽 */
export interface ProviderSlotsConfigView {
  chat: LocalProviderConfigView
  vision: LocalProviderConfigView
  image: LocalProviderConfigView
}

/** 模型列表项 */
export interface ListedModel {
  id: string
  name: string
}

/**
 * 2026‑08 主流Agent模型上下文窗口，单位：千tokens(k)
 * 数值为官方标称最大上下文，用于Agent框架路由/限流
 */
export const BUILTIN_CONTEXT_WINDOWS_K: Record<string, number> = {
  // OpenAI
  'gpt-4o': 128,
  'gpt-4o-mini': 128,
  'gpt-4.1': 1048,
  'gpt-4.1-mini': 1048,
  'o3': 200,
  'o3-mini': 200,
  'o4-mini': 200,
  'gpt-5.6-sol': 1048,
  'gpt-5.6-terra': 1048,
  'gpt-5.6-luna': 1048,
  'gpt-5.5': 1048,
  'gpt-5.4': 1048,
  'gpt-5-mini': 400,

  // Anthropic Claude
  'claude-3-5-sonnet': 200,
  'claude-3-7-sonnet': 200,
  'claude-sonnet-4': 200,
  'claude-sonnet-4.6': 1048,
  'claude-sonnet-4.7': 1048,
  'claude-sonnet-5': 1048,
  'claude-opus-4.6': 1048,
  'claude-opus-4.7': 1048,
  'claude-opus-4.8': 1048,
  'claude-opus-5': 1048,
  'claude-haiku-4': 200,

  // Google Gemini
  'gemini-1.5-pro': 2000,
  'gemini-2.0-flash': 1000,
  'gemini-2.5-pro': 1048,
  'gemini-3-flash': 1048,
  'gemini-3.5-flash': 1048,
  'gemini-3.5-pro': 2000,
  'gemini-3-pro': 10000,
  'gemma-4-26b-it': 256,
  'gemma-4-31b-it': 256,

  // DeepSeek
  'deepseek-chat': 128,
  'deepseek-reasoner': 128,
  'deepseek‑r1': 128,
  'deepseek‑v4‑flash': 1048,
  'deepseek‑v4‑pro': 1048,

  // Qwen 通义千问
  'qwen3': 128,
  'qwen3‑thinking': 128,
  'qwen3.6‑27b‑instruct': 256,
  'qwen3.6‑max‑preview': 256,
  'qwen3.7‑max': 1048,
  'qwen3.8‑27b‑instruct': 256,

  // GLM 智谱
  'glm‑5': 200,
  'glm‑5.2': 256,
  'glm‑5.3': 1048,

  // Kimi Moonshot
  'kimi‑k2': 256,
  'kimi‑k2.6': 256,

  // MiniMax
  'minimax‑01': 4096,
  'minimax‑m3': 1048,

  // xAI Grok
  'grok‑4': 256,
  'grok‑4.20': 256,
  'grok‑4.3': 1048,

  // Meta Llama
  'llama‑4‑scout': 10000,
  'llama‑4‑400b‑instruct': 128,

  // Mistral
  'mistral‑large‑3': 256,

  // StepFun 阶跃星辰
  'step‑3.7‑flash': 256,

  // Nvidia Nemotron
  'nemotron‑3‑ultra': 1048,
};

export function defaultContextWindowK(modelId: string): number {
  const id = modelId.trim().toLowerCase()
  const exact = BUILTIN_CONTEXT_WINDOWS_K[id]
  if (exact) return exact
  const hit = Object.entries(BUILTIN_CONTEXT_WINDOWS_K).find(([key]) => id.includes(key))
  return hit?.[1] ?? 200
}

/**
 * 内置「支持思考」模型名单 — 与 main/model-thinking.ts 的 REASONING_HINTS 保持同源。
 * 未命中一律视为不支持（中转端点对未知参数常直接报错，宁可让用户显式勾选）。
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

/** 按模型 ID 推断是否支持思考（内置默认表，供设置页显示默认值） */
export function defaultSupportsReasoning(modelId: string): boolean {
  const id = modelId.trim().toLowerCase()
  if (!id) return false
  if (/(^|[-_/.])o(1|3|4)([-_/.]|$)/.test(id)) return true
  return REASONING_HINTS.some((hint) => id.includes(hint))
}

/** 连通性测试结果 */
export interface ProviderTestResult {
  ok: boolean
  message: string
  latencyMs?: number
}

/** 各 provider 默认端点（展示用不含 /v1，保存/调用时自动补全） */
export const PROVIDER_DEFAULT_BASE_URL: Record<ProviderType, string> = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234',
  rightapi: 'https://www.rightapi.ai/draw/v1',
  deepseek: 'https://api.deepseek.com',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  xai: 'https://api.x.ai/v1',
  zai: 'https://open.bigmodel.cn/api/paas/v4',
  dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  moonshot: 'https://api.moonshot.cn/v1',
  minimax: 'https://api.minimaxi.com/v1',
  siliconflow: 'https://api.siliconflow.cn/v1',
}

/** 各 provider 类型的默认参数（与 main/provider-config.ts 同源） */
export const PROVIDER_TYPE_DEFAULTS: Record<
  ProviderType,
  { apiFormat?: 'completions' | 'responses'; thinkingFormat: ThinkingFormat }
> = {
  openai: { apiFormat: 'completions', thinkingFormat: 'auto' },
  anthropic: { thinkingFormat: 'auto' },
  gemini: { thinkingFormat: 'auto' },
  ollama: { apiFormat: 'completions', thinkingFormat: 'auto' },
  lmstudio: { apiFormat: 'completions', thinkingFormat: 'auto' },
  rightapi: { thinkingFormat: 'auto' },
  deepseek: { apiFormat: 'responses', thinkingFormat: 'auto' },
  openrouter: { apiFormat: 'completions', thinkingFormat: 'auto' },
  groq: { apiFormat: 'completions', thinkingFormat: 'auto' },
  xai: { apiFormat: 'completions', thinkingFormat: 'auto' },
  zai: { apiFormat: 'completions', thinkingFormat: 'zai' },
  dashscope: { apiFormat: 'completions', thinkingFormat: 'qwen' },
  moonshot: { apiFormat: 'completions', thinkingFormat: 'auto' },
  minimax: { apiFormat: 'completions', thinkingFormat: 'auto' },
  siliconflow: { apiFormat: 'completions', thinkingFormat: 'auto' },
}

/** provider 类型展示名 */
export const PROVIDER_TYPE_LABEL: Record<ProviderType, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  ollama: 'Ollama（本地）',
  lmstudio: 'LM Studio（本地）',
  rightapi: 'RightAPI 异步生图',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  xai: 'xAI（Grok）',
  zai: '智谱（GLM）',
  dashscope: '阿里云百炼（通义）',
  moonshot: '月之暗面（Kimi）',
  minimax: 'MiniMax',
  siliconflow: '硅基流动',
}

/** 仅在特定能力槽可选的 provider 类型 */
export const PROVIDER_TYPE_SLOT_RESTRICTION: Partial<Record<ProviderType, CapabilitySlot[]>> = {
  rightapi: ['image'],
}

/**
 * 列出某能力槽可选的 provider 类型
 */
export function listProviderTypesForSlot(slot: CapabilitySlot): ProviderType[] {
  return (Object.keys(PROVIDER_TYPE_LABEL) as ProviderType[]).filter((t) => {
    const allowed = PROVIDER_TYPE_SLOT_RESTRICTION[t]
    return !allowed || allowed.includes(slot)
  })
}

/**
 * 该类型是否走「可切换 API 格式」的 OpenAI 兼容协议。
 * anthropic/gemini 有各自的协议；rightapi 是生图专用；本地端点只支持 completions。
 */
export function supportsApiFormatChoice(type: ProviderType): boolean {
  return (
    type !== 'anthropic' &&
    type !== 'gemini' &&
    type !== 'rightapi' &&
    type !== 'ollama' &&
    type !== 'lmstudio'
  )
}

/** 能力槽展示名 */
export const CAPABILITY_SLOT_LABEL: Record<CapabilitySlot, string> = {
  chat: '文本对话',
  vision: '视觉理解',
  image: '图片生成',
}

/** 能力槽说明 */
export const CAPABILITY_SLOT_DESC: Record<CapabilitySlot, string> = {
  chat: 'Agent 主对话与文本生成。启用后才会调用该模型；未启用则忽略此配置。',
  vision: '看图、OCR、多模态。启用后图片识别走此配置。',
  image: '文生图。启用后才会调用生图接口。',
}

export const CAPABILITY_SLOTS: CapabilitySlot[] = ['chat', 'vision', 'image']

const CHAT_LISTED_MODELS_KEY = 'lumii:chat-listed-models'

/**
 * 规范化允许模型列表
 */
export function normalizeAllowedModelIds(
  allowed: string[] | undefined,
  modelId: string,
): string[] {
  const ids = (allowed ?? [])
    .map((id) => (typeof id === 'string' ? id.trim() : ''))
    .filter(Boolean)
  const unique = [...new Set(ids)]
  const fallback = modelId.trim()
  if (unique.length === 0) return fallback ? [fallback] : []
  return unique
}

/**
 * 创建默认单槽配置（不预填模型名）
 */
export function createDefaultSlotConfig(_slot: CapabilitySlot): LocalProviderConfigView {
  return {
    enabled: false,
    type: 'openai',
    baseUrl: PROVIDER_DEFAULT_BASE_URL.openai,
    modelId: '',
    apiKey: '',
    allowedModelIds: [],
    modelReasoning: {},
    thinkingFormat: 'auto',
  }
}

/**
 * 创建默认全槽配置
 */
export function createDefaultSlotsConfig(): ProviderSlotsConfigView {
  return {
    chat: createDefaultSlotConfig('chat'),
    vision: createDefaultSlotConfig('vision'),
    image: createDefaultSlotConfig('image'),
  }
}

/**
 * 判断 chat 槽是否已就绪（启用且已填模型）
 */
export function isChatProviderReady(cfg: ProviderSlotsConfigView | LocalProviderConfigView | null | undefined): boolean {
  if (!cfg) return false
  if ('chat' in cfg) {
    const chat = (cfg as ProviderSlotsConfigView).chat
    return chat.enabled === true && !!chat.modelId?.trim()
  }
  const single = cfg as LocalProviderConfigView
  return single.enabled === true && !!single.modelId?.trim()
}

/** 读取全部能力槽配置 */
export async function getProviderConfig(): Promise<ProviderSlotsConfigView> {
  return window.electronAPI.provider.getConfig()
}

/** 保存全部能力槽配置 */
export async function saveProviderConfig(
  cfg: ProviderSlotsConfigView,
): Promise<ProviderSlotsConfigView> {
  return window.electronAPI.provider.setConfig(cfg)
}

/** 拉取指定槽的远端模型列表（可传入未保存的草稿配置，避免必须先落盘） */
export async function listProviderModels(
  slot: CapabilitySlot,
  draftCfg?: LocalProviderConfigView,
): Promise<ListedModel[]> {
  const res = await window.electronAPI.provider.listModels(slot, draftCfg)
  if (!res.success) throw new Error(res.error || '获取模型列表失败')
  const models = res.data ?? []
  if (slot === 'chat' && models.length > 0) {
    try {
      localStorage.setItem(CHAT_LISTED_MODELS_KEY, JSON.stringify(models.slice(0, 200)))
    } catch { /* ignore */ }
  }
  return models
}

/** 测试指定槽连通性（可传入未保存的草稿配置，避免必须先落盘） */
export async function testProviderConnection(
  slot: CapabilitySlot,
  draftCfg?: LocalProviderConfigView,
): Promise<ProviderTestResult> {
  return window.electronAPI.provider.testConnection(slot, draftCfg)
}

// ── ChatPage 兼容适配层 ──

/** 模型选项 */
export interface ModelOption {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  supportsMultiModal?: boolean
  mode?: string
}

/** chat 候选模型 + 当前选择 */
export interface ChatModelChoices {
  candidates: ModelOption[]
  selected: string
}

/**
 * 由 chat 槽 allowedModelIds 构造对话框候选（仅已勾选模型）
 */
async function localModelOptions(): Promise<ModelOption[]> {
  const cfg = await getProviderConfig()
  const chat = cfg.chat
  if (!chat.enabled) return []

  const allowed = normalizeAllowedModelIds(chat.allowedModelIds, chat.modelId)
  if (allowed.length === 0) return []

  return allowed.map((id) => ({ id, name: id }))
}

/** 获取模型 catalog */
export async function fetchModelCatalog(): Promise<ModelOption[]> {
  return localModelOptions()
}

/** 获取 chat 候选与当前选择 */
export async function fetchChatModelChoices(): Promise<ChatModelChoices> {
  const cfg = await getProviderConfig()
  const candidates = await localModelOptions()
  const selected =
    (cfg.chat.modelId && candidates.some((c) => c.id === cfg.chat.modelId)
      ? cfg.chat.modelId
      : candidates[0]?.id) ?? ''
  return { candidates, selected }
}

/**
 * 保存 chat 模型选择：写入 chat 槽的 modelId（保留 allowlist）
 */
export async function saveChatModel(modelId: string): Promise<void> {
  const id = modelId?.trim()
  if (!id) return
  const cfg = await getProviderConfig()
  const allowed = normalizeAllowedModelIds(cfg.chat.allowedModelIds, cfg.chat.modelId)
  const nextAllowed = allowed.includes(id) ? allowed : [...allowed, id]
  if (cfg.chat.modelId === id && JSON.stringify(cfg.chat.allowedModelIds ?? []) === JSON.stringify(nextAllowed)) {
    return
  }
  cfg.chat = {
    ...cfg.chat,
    modelId: id,
    allowedModelIds: nextAllowed,
    enabled: true,
  }
  await saveProviderConfig(cfg)
  window.dispatchEvent(new CustomEvent('mtbot:provider-config-changed'))
}
