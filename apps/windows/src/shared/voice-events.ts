/**
 * 语音通话 IPC 事件类型定义
 * 主进程 → 渲染进程的事件推送
 */

// ─── 通话状态枚举 ───────────────────────────────────────────────────────────

export type VoiceCallState =
  | 'initializing'  // 正在初始化引擎
  | 'listening'     // 等待用户说话
  | 'recognizing'   // 正在识别
  | 'thinking'      // Agent 处理中
  | 'speaking'      // TTS 播放中
  | 'ending'        // 通话结束中
  | 'error'         // 错误状态

// ─── 模型状态 ────────────────────────────────────────────────────────────────

/** 单项下载任务状态 */
export type VoiceModelDownloadState =
  | 'idle'
  | 'downloading'
  | 'paused'
  | 'extracting'
  | 'ready'
  | 'error'

export type VoiceModelStatus = {
  id: string
  name: string
  description?: string
  /** 设置页分组：asr-core / tts-synth / tts-clone */
  group?: string
  sizeBytes: number
  downloaded: boolean
  required?: boolean
  downloadState?: VoiceModelDownloadState
  downloadedBytes?: number
  /** 瞬时下载速度（字节/秒） */
  bytesPerSecond?: number
  errorMessage?: string
  path?: string
}

// ─── 事件类型 ────────────────────────────────────────────────────────────────

export type VoiceCallStateEvent = {
  readonly type: 'voice:call:state'
  callId: string
  state: VoiceCallState
}

export type VoiceTranscriptEvent = {
  readonly type: 'voice:transcript'
  callId: string
  text: string
  isFinal: boolean
}

export type VoiceTtsChunkEvent = {
  readonly type: 'voice:tts:chunk'
  callId: string
  samples: number[]   // Float32Array 序列化为 number[]（IPC 传输）
  sampleRate: number
  isFinal: boolean
}

/** 当 TTS 产出音频文件路径时（Edge/OpenAI 降级场景），通知渲染进程加载并播放 */
export type VoiceTtsAudioFileEvent = {
  readonly type: 'voice:tts:audio-file'
  callId: string
  audioPath: string   // 本地文件绝对路径
  isFinal: boolean
}

export type VoiceCallEndedEvent = {
  readonly type: 'voice:call:ended'
  callId: string
  reason: 'user_hangup' | 'error' | 'timeout'
}

export type VoiceModelsStatusEvent = {
  readonly type: 'voice:models:status'
  models: VoiceModelStatus[]
}

export type VoiceModelsProgressEvent = {
  readonly type: 'voice:models:progress'
  modelId: string
  progress: number    // 0.0 ~ 1.0
  bytesDownloaded: number
  totalBytes: number
  /** 下载任务状态 */
  state?: VoiceModelDownloadState
  /** 瞬时下载速度（字节/秒） */
  bytesPerSecond?: number
}

/** 模型下载失败事件 */
export type VoiceModelsErrorEvent = {
  readonly type: 'voice:models:error'
  modelId: string
  message: string
}

/**
 * 语音引擎运行时阶段（依赖安装、模型加载、合成等，与下载状态独立）
 */
export type VoiceRuntimePhase =
  | 'idle'
  | 'checking_python'
  | 'installing_deps'
  | 'starting_engine'
  | 'loading_model'
  | 'synthesizing'
  | 'playing'
  | 'ready'
  | 'error'

/** 主进程 → 渲染：TTS/依赖安装等长耗时步骤的可读状态 */
export type VoiceRuntimeStatusEvent = {
  readonly type: 'voice:runtime:status'
  phase: VoiceRuntimePhase
  /** 面向用户的短说明 */
  message: string
  /** 可选补充（如 pip 输出摘要） */
  detail?: string
}

/** TTS 预览结束（成功或失败），便于 UI 结束「播放中」并展示错误 */
export type VoiceTtsPreviewEndedEvent = {
  readonly type: 'voice:tts:preview:ended'
  ok: boolean
  message?: string
}

export type VoiceErrorEvent = {
  readonly type: 'voice:error'
  callId?: string
  code: VoiceErrorCode
  message: string
}

/** 配置更新事件（主进程 → 渲染进程，config:set 后推送，用于热更新音量等渲染侧状态） */
export type VoiceConfigUpdatedEvent = {
  readonly type: 'voice:config:updated'
  config: VoiceEngineConfig
}

export type VoiceEvent =
  | VoiceCallStateEvent
  | VoiceTranscriptEvent
  | VoiceTtsChunkEvent
  | VoiceTtsAudioFileEvent
  | VoiceCallEndedEvent
  | VoiceModelsStatusEvent
  | VoiceModelsProgressEvent
  | VoiceModelsErrorEvent
  | VoiceRuntimeStatusEvent
  | VoiceTtsPreviewEndedEvent
  | VoiceErrorEvent
  | VoiceConfigUpdatedEvent

// ─── 错误码 ──────────────────────────────────────────────────────────────────

export type VoiceErrorCode =
  | 'mic_permission_denied'   // 麦克风权限被拒绝
  | 'model_not_ready'         // 模型未就绪
  | 'asr_init_failed'         // ASR 初始化失败
  | 'tts_init_failed'         // TTS 初始化失败
  | 'vad_init_failed'         // VAD 初始化失败
  | 'call_already_active'     // 已有通话进行中
  | 'no_active_call'          // 无活跃通话
  | 'unknown'                 // 未知错误

// ─── 引擎配置 ────────────────────────────────────────────────────────────────

export type VoiceAsrConfig = {
  /** ASR 提供者：local-paraformer = 本地 sherpa-onnx，openai-whisper = 云端 */
  provider: 'local-paraformer' | 'openai-whisper'
  language?: string
  apiKey?: string
}

/** Qwen3-TTS 模型变体：CustomVoice=内置音色；Base=声音克隆 */
export type Qwen3TtsVariant =
  | '0.6b-custom'
  | '1.7b-custom'
  | '0.6b-base'
  | '1.7b-base'

/**
 * 是否为声音克隆（Base）变体
 */
export function isQwen3CloneVariant(variant?: string): boolean {
  return variant === '0.6b-base' || variant === '1.7b-base'
}

/**
 * 是否为内置音色（CustomVoice）变体
 */
export function isQwen3CustomVariant(variant?: string): boolean {
  return variant === '0.6b-custom' || variant === '1.7b-custom' || !variant
}

export type VoiceTtsConfig = {
  /** TTS 提供者：local-vits / edge / qwen3（本地 Qwen3-TTS） */
  provider: 'local-vits' | 'edge' | 'qwen3'
  /** 语速（0.8 ~ 1.5） */
  speed: number
  /** 播放音量（0.0 ~ 1.0） */
  volume: number
  /** VITS 说话人 ID */
  speakerId?: number
  /** Edge TTS 音色名称 */
  voice?: string
  /** Qwen3 模型挡位（默认 0.6b-custom，无需克隆即可用） */
  qwen3Variant?: Qwen3TtsVariant
  /** CustomVoice 内置说话人（如 Vivian / Dylan） */
  qwen3Speaker?: string
  /** 1.7B CustomVoice 可选风格指令 */
  qwen3Instruct?: string
  /**
   * 是否启用声音克隆出声（默认 false）。
   * 仅当为 true 且已选择 qwen3ProfileId 时，才使用 Base 克隆音色。
   */
  qwen3CloneEnabled?: boolean
  /** 克隆所用 Base 规格（与 CustomVoice 的 qwen3Variant 分开） */
  qwen3CloneVariant?: '0.6b-base' | '1.7b-base'
  /** 当前使用的克隆音色档案 ID（启用克隆时需要） */
  qwen3ProfileId?: string
  /**
   * Qwen3 推理设备：auto=有 NVIDIA 则优先 GPU；cpu/cuda 为强制指定
   */
  qwen3Device?: 'auto' | 'cpu' | 'cuda'
  /**
   * 合成语言（Qwen3）：`Auto` 或官方支持语言名，如 Chinese / English
   */
  language?: string
}

/** Qwen3 CustomVoice 内置音色（含方言） */
export const QWEN3_CUSTOM_SPEAKERS = [
  { id: 'Vivian', name: 'Vivian', gender: '女', style: '明亮略带锋芒', native: '中文' },
  { id: 'Serena', name: 'Serena', gender: '女', style: '温暖柔和', native: '中文' },
  { id: 'Uncle_Fu', name: 'Uncle Fu', gender: '男', style: '沉稳低沉', native: '中文' },
  { id: 'Dylan', name: 'Dylan', gender: '男', style: '清朗自然', native: '中文·北京话' },
  { id: 'Eric', name: 'Eric', gender: '男', style: '略带沙哑明亮', native: '中文·四川话' },
  { id: 'Ryan', name: 'Ryan', gender: '男', style: '节奏感强', native: 'English' },
  { id: 'Aiden', name: 'Aiden', gender: '男', style: '阳光清晰', native: 'English' },
  { id: 'Ono_Anna', name: 'Ono Anna', gender: '女', style: '轻快灵动', native: '日本語' },
  { id: 'Sohee', name: 'Sohee', gender: '女', style: '情感丰富', native: '한국어' },
] as const

/** Qwen3 官方语言列表（与模型能力对齐，供设置页选用） */
export const QWEN3_TTS_LANGUAGES = [
  { id: 'Auto', name: '自动检测' },
  { id: 'Chinese', name: '中文' },
  { id: 'English', name: 'English' },
  { id: 'Japanese', name: '日本語' },
  { id: 'Korean', name: '한국어' },
  { id: 'German', name: 'Deutsch' },
  { id: 'French', name: 'Français' },
  { id: 'Russian', name: 'Русский' },
  { id: 'Portuguese', name: 'Português' },
  { id: 'Spanish', name: 'Español' },
  { id: 'Italian', name: 'Italiano' },
] as const

/** 克隆音色档案元数据（存于 clientDataRoot/voice/profiles） */
export type VoiceCloneProfile = {
  id: string
  name: string
  /** 参考音频相对 profiles/<id>/ 的文件名 */
  refAudioFile: string
  refText: string
  language: string
  /** 创建时使用的模型变体 */
  qwen3Variant: Qwen3TtsVariant
  /** false = ICL（需 refText）；true = 仅 x-vector */
  xVectorOnly: boolean
  createdAt: number
  updatedAt: number
}

/** Edge TTS 可用中文音色 */
export const EDGE_TTS_VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', gender: '女', style: '温暖亲切' },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊', gender: '女', style: '活泼可爱' },
  { id: 'zh-CN-YunjianNeural', name: '云健', gender: '男', style: '沉稳大气' },
  { id: 'zh-CN-YunxiNeural', name: '云希', gender: '男', style: '阳光少年' },
  { id: 'zh-CN-YunxiaNeural', name: '云夏', gender: '男', style: '少年音' },
  { id: 'zh-CN-YunyangNeural', name: '云扬', gender: '男', style: '新闻播报' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北', gender: '女', style: '东北方言' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮', gender: '女', style: '陕西方言' },
] as const

export type VoiceVadConfig = {
  /** 语音概率阈值（0.0 ~ 1.0），即"语音识别阈值"：silero 判定为说话的敏感度 */
  threshold: number
  /** 最短语音段（毫秒） */
  minSpeechMs: number
  /** 静音判定时长（毫秒） */
  minSilenceMs: number
  /**
   * 能量门倍率（"负面语音阈值"）：多大声才算真的在说话。
   * listening/打断判定要求段能量 > noiseBaseline * energyGateMultiplier，
   * 用于过滤背景噪声与 TTS 回声。越大越严格（更难被环境音触发）。
   */
  energyGateMultiplier: number
}

export type VoiceEngineConfig = {
  asr: VoiceAsrConfig
  tts: VoiceTtsConfig
  vad: VoiceVadConfig
  /**
   * AI 朗读（speaking）期间自动闭麦：暂停麦克风采集/ASR，朗读结束回 listening 时自动恢复。
   * 默认开启，避免 TTS 声音被回采成用户输入触发误打断。
   */
  autoMuteMicWhileSpeaking: boolean
}

export const DEFAULT_VOICE_ENGINE_CONFIG: VoiceEngineConfig = {
  asr: {
    provider: 'local-paraformer',
    language: 'zh',
  },
  tts: {
    provider: 'edge',
    speed: 1.2,
    volume: 0.8,
    speakerId: 0,
    voice: 'zh-CN-XiaoxiaoNeural',
    qwen3Variant: '0.6b-custom',
    qwen3Speaker: 'Vivian',
    qwen3CloneEnabled: false,
    qwen3CloneVariant: '0.6b-base',
    qwen3Device: 'auto',
    language: 'Auto',
  },
  vad: {
    threshold: 0.5,
    minSpeechMs: 250,
    minSilenceMs: 500,
    energyGateMultiplier: 1.5,
  },
  autoMuteMicWhileSpeaking: true,
}
