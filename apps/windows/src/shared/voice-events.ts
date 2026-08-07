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
  sizeBytes: number
  downloaded: boolean
  required?: boolean
  downloadState?: VoiceModelDownloadState
  downloadedBytes?: number
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
}

/** 模型下载失败事件 */
export type VoiceModelsErrorEvent = {
  readonly type: 'voice:models:error'
  modelId: string
  message: string
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

export type VoiceTtsConfig = {
  /** TTS 提供者：local-vits = 本地 sherpa-onnx，edge = Edge TTS */
  provider: 'local-vits' | 'edge'
  /** 语速（0.8 ~ 1.5） */
  speed: number
  /** 播放音量（0.0 ~ 1.0） */
  volume: number
  /** VITS 说话人 ID */
  speakerId?: number
  /** Edge TTS 音色名称 */
  voice?: string
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
  },
  vad: {
    threshold: 0.5,
    minSpeechMs: 250,
    minSilenceMs: 500,
    energyGateMultiplier: 1.5,
  },
  autoMuteMicWhileSpeaking: true,
}
