/**
 * 模型配置服务 — 灵栖/Lumii 独立版
 *
 * 磁盘上是「全局 Provider 列表 + 三个能力槽各自引用」，同一家的 Key 只填一次。
 * 主进程把槽引用解析成平铺的 LocalProviderConfigView，运行时按那个形状消费。
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
  /** API 格式（openai/deepseek 用）：completions 或 responses；缺省跟类型默认值 */
  apiFormat?: 'completions' | 'responses'
  /** 按模型覆盖 API 格式 */
  apiFormatByModel?: Record<string, 'completions' | 'responses'>
  contextWindowK?: Record<string, number>
  /** 按模型声明是否支持思考；缺省按内置默认表推断 */
  modelReasoning?: Record<string, boolean>
  /** 思考参数格式，缺省 auto */
  thinkingFormat?: ThinkingFormat
}

/** 全部能力槽（已解析的平铺形状） */
export interface ProviderSlotsConfigView {
  chat: LocalProviderConfigView
  vision: LocalProviderConfigView
  image: LocalProviderConfigView
}

/** 用户配置的一个模型提供商（一份凭据 + 端点） */
export interface ProviderEntryView {
  id: string
  /** 展示名；留空时界面回退到类型名 */
  name: string
  type: ProviderType
  baseUrl: string
  apiKey: string
  apiKeyDecryptFailed?: boolean
  /** 该提供商下可用的模型 id 列表 */
  modelIds: string[]
  apiFormat?: 'completions' | 'responses'
  apiFormatByModel?: Record<string, 'completions' | 'responses'>
  thinkingFormat?: ThinkingFormat
}

/** 能力槽对某个 provider 与模型的选择 */
export interface SlotSelectionView {
  enabled: boolean
  /** 引用的 provider id；空串表示尚未选择 */
  providerId: string
  modelId: string
  contextWindowK?: Record<string, number>
  modelReasoning?: Record<string, boolean>
}

/** 完整配置（多 Provider 列表 + 槽选择） */
export interface ProviderStoreView {
  providers: ProviderEntryView[]
  slots: {
    chat: SlotSelectionView
    vision: SlotSelectionView
    image: SlotSelectionView
  }
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
const BUILTIN_CONTEXT_WINDOWS_K: Record<string, number> = {
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
  'deepseek-r1': 128,
  'deepseek-v4-flash': 1048,
  'deepseek-v4-pro': 1048,

  // Qwen 通义千问
  'qwen3': 128,
  'qwen3-thinking': 128,
  'qwen3.6-27b-instruct': 256,
  'qwen3.6-max-preview': 256,
  'qwen3.7-max': 1048,
  'qwen3.8-27b-instruct': 256,
  'qwen3.8-flash-next': 256,

  // GLM 智谱
  'glm-5': 200,
  'glm-5.2': 256,
  'glm-5.3': 1048,

  // Kimi Moonshot
  'kimi-k2': 256,
  'kimi-k2.6': 256,

  // MiniMax
  'minimax-01': 4096,
  'minimax-m3': 1048,

  // xAI Grok
  'grok-4': 256,
  'grok-4.20': 256,
  'grok-4.3': 1048,

  // Meta Llama
  'llama-4-scout': 10000,
  'llama-4-400b-instruct': 128,

  // Mistral
  'mistral-large-3': 256,

  // StepFun 阶跃星辰
  'step-3.7-flash': 256,

  // Nvidia Nemotron
  'nemotron-3-ultra': 1048,
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
  rightapi: 'https://api.site/draw/v1',
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
const PROVIDER_TYPE_SLOT_RESTRICTION: Partial<Record<ProviderType, CapabilitySlot[]>> = {
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
function normalizeAllowedModelIds(
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
function createDefaultSlotConfig(_slot: CapabilitySlot): LocalProviderConfigView {
  return {
    enabled: false,
    type: 'openai',
    baseUrl: PROVIDER_DEFAULT_BASE_URL.openai,
    modelId: '',
    apiKey: '',
    allowedModelIds: [],
    apiFormat: 'completions',
    apiFormatByModel: {},
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

/** 创建默认 provider 条目（不预填模型名） */
export function createProviderEntry(type: ProviderType = 'openai'): ProviderEntryView {
  const defaults = PROVIDER_TYPE_DEFAULTS[type]
  return {
    id: '',
    name: '',
    type,
    baseUrl: PROVIDER_DEFAULT_BASE_URL[type],
    apiKey: '',
    modelIds: [],
    apiFormat: defaults.apiFormat,
    apiFormatByModel: {},
    thinkingFormat: defaults.thinkingFormat,
  }
}

function createDefaultSelection(): SlotSelectionView {
  return { enabled: false, providerId: '', modelId: '', contextWindowK: {}, modelReasoning: {} }
}

/**
 * 创建默认完整配置。
 * 预置一个空 provider 作为「新增条目」的落脚点，避免界面首屏是一张空表。
 */
export function createDefaultProviderStore(): ProviderStoreView {
  return {
    providers: [createProviderEntry('openai')],
    slots: {
      chat: createDefaultSelection(),
      vision: createDefaultSelection(),
      image: createDefaultSelection(),
    },
  }
}

/** provider 在界面上的展示名 */
export function providerDisplayName(p: ProviderEntryView): string {
  return p.name?.trim() || PROVIDER_TYPE_LABEL[p.type] || '未命名提供商'
}

/**
 * 把 store 解析成平铺的槽视图（与服务端 resolveSlotView 同语义）。
 * 界面用它取得「某槽当前生效的类型/端点/Key」，避免各处重复拼装。
 */
export function resolveSlotFromStore(
  store: ProviderStoreView,
  slot: CapabilitySlot,
): LocalProviderConfigView & { providerId: string } {
  const sel = store.slots[slot]
  const provider = store.providers.find((p) => p.id === sel.providerId)
  if (!provider) return { ...createDefaultSlotConfig(slot), providerId: '' }

  const allowed = normalizeAllowedModelIds(provider.modelIds, sel.modelId)
  const modelId = sel.modelId && !allowed.includes(sel.modelId) ? sel.modelId : (sel.modelId || allowed[0] || '')
  return {
    enabled: sel.enabled,
    type: provider.type,
    baseUrl: provider.baseUrl,
    modelId,
    apiKey: provider.apiKey,
    apiKeyDecryptFailed: provider.apiKeyDecryptFailed,
    allowedModelIds: modelId && !allowed.includes(modelId) ? [...allowed, modelId] : allowed,
    apiFormat: provider.apiFormat,
    apiFormatByModel: provider.apiFormatByModel,
    contextWindowK: sel.contextWindowK,
    modelReasoning: sel.modelReasoning,
    thinkingFormat: provider.thinkingFormat,
    providerId: provider.id,
  }
}

/**
 * 判断 chat 槽是否已就绪（启用且已填模型）
 */
export function isChatProviderReady(cfg: ProviderSlotsConfigView | ProviderStoreView | LocalProviderConfigView | null | undefined): boolean {
  if (!cfg) return false
  if ('chat' in cfg) {
    const chat = (cfg as ProviderSlotsConfigView).chat
    return chat.enabled === true && !!chat.modelId?.trim()
  }
  const single = cfg as LocalProviderConfigView
  return single.enabled === true && !!single.modelId?.trim()
}

/** 读取完整配置（多 Provider 列表 + 槽选择） */
export async function getProviderStore(): Promise<ProviderStoreView> {
  const raw = await window.electronAPI.provider.getConfig()
  // 主进程始终返回 v2；这里兜底旧形状，避免灰度期界面炸掉
  if (raw && 'providers' in raw && Array.isArray(raw.providers)) {
    return raw
  }
  return createDefaultProviderStore()
}

/** 保存完整配置 */
export async function saveProviderStore(store: ProviderStoreView): Promise<ProviderStoreView> {
  return window.electronAPI.provider.setConfig(store)
}

/** 读取全部能力槽配置（运行时形状，由 store 在本地解析） */
export async function getProviderConfig(): Promise<ProviderSlotsConfigView> {
  const store = await getProviderStore()
  return {
    chat: resolveSlotFromStore(store, 'chat'),
    vision: resolveSlotFromStore(store, 'vision'),
    image: resolveSlotFromStore(store, 'image'),
  }
}

/** 保存全部能力槽配置（旧入口；主进程会拆成 provider 列表落盘，这里转回 store 形状） */
export async function saveProviderConfig(
  cfg: ProviderSlotsConfigView,
): Promise<ProviderSlotsConfigView> {
  const store = createDefaultProviderStore()
  for (const slot of CAPABILITY_SLOTS) {
    const flat = cfg[slot]
    if (!flat?.enabled) continue
    const provider = createProviderEntry(flat.type)
    provider.baseUrl = flat.baseUrl
    provider.apiKey = flat.apiKey
    provider.modelIds = normalizeAllowedModelIds(flat.allowedModelIds, flat.modelId)
    provider.apiFormat = flat.apiFormat
    provider.apiFormatByModel = flat.apiFormatByModel
    provider.thinkingFormat = flat.thinkingFormat
    provider.id = `slot-${slot}`
    store.providers.push(provider)
    store.slots[slot] = {
      enabled: true,
      providerId: provider.id,
      modelId: flat.modelId,
      contextWindowK: flat.contextWindowK,
      modelReasoning: flat.modelReasoning,
    }
  }
  store.providers = store.providers.filter((p) => p.id !== '')
  const saved = await saveProviderStore(store)
  return {
    chat: resolveSlotFromStore(saved, 'chat'),
    vision: resolveSlotFromStore(saved, 'vision'),
    image: resolveSlotFromStore(saved, 'image'),
  }
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

/** 探测端点推荐的 API 格式（Completions / Responses） */
export async function probeProviderApiFormat(
  slot: CapabilitySlot,
  draftCfg?: LocalProviderConfigView,
): Promise<{
  success: boolean
  data?: {
    recommended: 'completions' | 'responses'
    responsesAvailable: boolean
    completionsAvailable: boolean
    message: string
    latencyMs: number
  }
  error?: string
}> {
  return window.electronAPI.provider.probeApiFormat(slot, draftCfg)
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
  /** 所属 Provider（跨 Provider 切换时用于分组与回写） */
  providerId?: string
  providerName?: string
}

/** chat 候选模型 + 当前选择 */
export interface ChatModelChoices {
  candidates: ModelOption[]
  selected: string
}

/** 带 provider 前缀的模型引用，跨 Provider 切换时用它 */
export function modelRef(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`
}

/**
 * 由 store 构造对话框候选：所有 provider 的模型，加 `providerId::` 前缀。
 *
 * 前缀只在内部流转；显示名用裸模型 id，避免下拉框里全是 `p2::gpt-4o`。
 */
function chatCandidatesFromStore(store: ProviderStoreView): ModelOption[] {
  const out: ModelOption[] = []
  for (const p of store.providers) {
    for (const modelId of p.modelIds) {
      out.push({
        id: modelRef(p.id, modelId),
        name: modelId,
        providerId: p.id,
        providerName: providerDisplayName(p),
      })
    }
  }
  return out
}

/** 获取模型 catalog（对话页的模型列表） */
export async function fetchModelCatalog(): Promise<ModelOption[]> {
  const store = await getProviderStore()
  const candidates = chatCandidatesFromStore(store)
  const current = store.slots.chat
  if (current.enabled && current.providerId && current.modelId) {
    const ref = modelRef(current.providerId, current.modelId)
    if (!candidates.some((c) => c.id === ref)) {
      candidates.push({
        id: ref,
        name: current.modelId,
        providerId: current.providerId,
        providerName:
          store.providers.find((p) => p.id === current.providerId)?.name ||
          current.providerId,
      })
    }
  }
  return candidates
}

/** 获取 chat 候选与当前选择 */
export async function fetchChatModelChoices(): Promise<ChatModelChoices> {
  const store = await getProviderStore()
  const candidates = await fetchModelCatalog()
  const current = store.slots.chat
  const selected =
    current.providerId && current.modelId
      ? modelRef(current.providerId, current.modelId)
      : (candidates[0]?.id ?? '')
  return { candidates, selected }
}

/**
 * 保存 chat 模型选择。
 *
 * 接受 `providerId::modelId` 引用：切到别的 Provider 时，把 chat 槽改指向该 provider。
 * 裸模型 id 视为「在当前 provider 上换模型」。
 */
export async function saveChatModel(modelRefOrId: string): Promise<void> {
  const raw = modelRefOrId?.trim()
  if (!raw) return
  const [maybeProvider, maybeModel] = raw.includes('::')
    ? (() => {
        const i = raw.indexOf('::')
        return [raw.slice(0, i), raw.slice(i + 2)] as const
      })()
    : [undefined, raw] as const
  const modelId = maybeModel.trim()
  if (!modelId) return

  const store = await getProviderStore()
  const chat = store.slots.chat
  const providerId = maybeProvider || chat.providerId
  const provider = store.providers.find((p) => p.id === providerId)
  if (!provider) return

  const changed = chat.providerId !== provider.id || chat.modelId !== modelId || !chat.enabled
  if (!changed) return

  store.slots.chat = { ...chat, enabled: true, providerId: provider.id, modelId }
  await saveProviderStore(store)
  window.dispatchEvent(new CustomEvent('mtbot:provider-config-changed'))
}
