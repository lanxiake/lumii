/**
 * 模型配置服务 — 灵栖/Lumii 独立版（按能力槽 chat/vision/image）
 *
 * 各槽可独立配置 Provider（例如 chat=DeepSeek，image=OpenAI）。
 * Agent 主对话走 chat 槽；视觉/生图走对应槽。
 */

/** provider 类型 */
export type ProviderType = 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'lmstudio'

/** 模型能力槽 */
export type CapabilitySlot = 'chat' | 'vision' | 'image'

/** 单槽配置视图 */
export interface LocalProviderConfigView {
  enabled: boolean
  type: ProviderType
  baseUrl: string
  modelId: string
  apiKey: string
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
}

/** provider 类型展示名 */
export const PROVIDER_TYPE_LABEL: Record<ProviderType, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  ollama: 'Ollama（本地）',
  lmstudio: 'LM Studio（本地）',
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
 * 创建默认单槽配置（不预填模型名）
 */
export function createDefaultSlotConfig(_slot: CapabilitySlot): LocalProviderConfigView {
  return {
    enabled: false,
    type: 'openai',
    baseUrl: PROVIDER_DEFAULT_BASE_URL.openai,
    modelId: '',
    apiKey: '',
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

/** 拉取指定槽的远端模型列表 */
export async function listProviderModels(slot: CapabilitySlot): Promise<ListedModel[]> {
  const res = await window.electronAPI.provider.listModels(slot)
  if (!res.success) throw new Error(res.error || '获取模型列表失败')
  const models = res.data ?? []
  if (slot === 'chat' && models.length > 0) {
    try {
      localStorage.setItem(CHAT_LISTED_MODELS_KEY, JSON.stringify(models.slice(0, 200)))
    } catch { /* ignore */ }
  }
  return models
}

/** 测试指定槽连通性 */
export async function testProviderConnection(slot: CapabilitySlot): Promise<ProviderTestResult> {
  return window.electronAPI.provider.testConnection(slot)
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
 * 读取设置页缓存的 chat 模型列表
 */
function readCachedChatListedModels(): ModelOption[] {
  try {
    const raw = localStorage.getItem(CHAT_LISTED_MODELS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as ListedModel[]
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((m) => m && typeof m.id === 'string' && m.id.trim())
      .map((m) => ({ id: m.id, name: m.name || m.id }))
  } catch {
    return []
  }
}

/**
 * 由 chat 槽 + 缓存列表构造候选（已启用且填写了模型时可用）
 */
async function localModelOptions(): Promise<ModelOption[]> {
  const cfg = await getProviderConfig()
  const chat = cfg.chat
  if (!chat.enabled || !chat.modelId?.trim()) return []

  const map = new Map<string, ModelOption>()
  map.set(chat.modelId, { id: chat.modelId, name: chat.modelId })
  for (const m of readCachedChatListedModels()) {
    if (!map.has(m.id)) map.set(m.id, m)
  }
  return Array.from(map.values())
}

/** 获取模型 catalog */
export async function fetchModelCatalog(): Promise<ModelOption[]> {
  return localModelOptions()
}

/** 获取 chat 候选与当前选择 */
export async function fetchChatModelChoices(): Promise<ChatModelChoices> {
  const candidates = await localModelOptions()
  const selected = candidates[0]?.id ?? ''
  return { candidates, selected }
}

/**
 * 保存 chat 模型选择：写入 chat 槽的 modelId（保留其余字段）
 */
export async function saveChatModel(modelId: string): Promise<void> {
  const id = modelId?.trim()
  if (!id) return
  const cfg = await getProviderConfig()
  if (cfg.chat.modelId === id) return
  cfg.chat = { ...cfg.chat, modelId: id, enabled: true }
  await saveProviderConfig(cfg)
  window.dispatchEvent(new CustomEvent('mtbot:provider-config-changed'))
}
