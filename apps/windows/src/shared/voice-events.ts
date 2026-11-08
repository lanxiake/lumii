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

type VoiceCallStateEvent = {
  readonly type: 'voice:call:state'
  callId: string
  state: VoiceCallState
}

type VoiceTranscriptEvent = {
  readonly type: 'voice:transcript'
  callId: string
  text: string
  isFinal: boolean
  /**
   * 识别阶段（P0-4 识别可见性）：
   * - `partial`  正在识别（流式引擎才会有）
   * - `pending`  认出来了，但还在提交窗口里等用户说完
   * - `final`    定稿，即将/已经发送
   *
   * 兼容：老消费方只读 `isFinal` 也照常工作（`isFinal === (phase === 'final')`）。
   */
  phase?: 'partial' | 'pending' | 'final'
}

type VoiceTtsChunkEvent = {
  readonly type: 'voice:tts:chunk'
  callId: string
  samples: number[]   // Float32Array 序列化为 number[]（IPC 传输）
  sampleRate: number
  isFinal: boolean
}

/** 当 TTS 产出音频文件路径时（Edge/OpenAI 降级场景），通知渲染进程加载并播放 */
type VoiceTtsAudioFileEvent = {
  readonly type: 'voice:tts:audio-file'
  callId: string
  audioPath: string   // 本地文件绝对路径
  isFinal: boolean
}

type VoiceCallEndedEvent = {
  readonly type: 'voice:call:ended'
  callId: string
  reason: 'user_hangup' | 'error' | 'timeout'
}

type VoiceModelsStatusEvent = {
  readonly type: 'voice:models:status'
  models: VoiceModelStatus[]
}

type VoiceModelsProgressEvent = {
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
type VoiceModelsErrorEvent = {
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
type VoiceRuntimeStatusEvent = {
  readonly type: 'voice:runtime:status'
  phase: VoiceRuntimePhase
  /** 面向用户的短说明 */
  message: string
  /** 可选补充（如 pip 输出摘要） */
  detail?: string
}

/** TTS 预览音频块（主进程 → 渲染，流式推送） */
export type VoiceTtsPreviewChunkEvent = {
  readonly type: 'voice:tts:preview:chunk'
  /** PCM Float32 采样（sampleRate=-1 时为 Edge MP3 字节） */
  samples: Float32Array | number[]
  sampleRate: number
  chunkIndex: number
  isFinal: boolean
  /** 发起该次预览时传入的会话标识，消费端据此过滤（省略=旧行为） */
  previewId?: string
}

/** TTS 预览结束（成功或失败），便于 UI 结束「播放中」并展示错误 */
type VoiceTtsPreviewEndedEvent = {
  readonly type: 'voice:tts:preview:ended'
  ok: boolean
  message?: string
  /** 发起该次预览时传入的会话标识 */
  previewId?: string
}

type VoiceErrorEvent = {
  readonly type: 'voice:error'
  callId?: string
  code: VoiceErrorCode
  message: string
}

/** 配置更新事件（主进程 → 渲染进程，config:set 后推送，用于热更新音量等渲染侧状态） */
type VoiceConfigUpdatedEvent = {
  readonly type: 'voice:config:updated'
  config: VoiceEngineConfig
}

/** 唤醒监听的当前状态（渲染层据此决定要不要继续推流） */
type VoiceWakeStateEvent = {
  readonly type: 'voice:wake:state'
  active: boolean
  /** 未激活的原因（模型没下 / 用户关了 / 通话中） */
  reason?: string
}

/** 唤醒命中：通知渲染层（宠物窗口是新页面，收不到这次推送，所以另有 consume 查询） */
type VoiceWakeDetectedEvent = {
  readonly type: 'voice:wake:detected'
  /** 命中的规范化口令 */
  matched: string
  /** 命中的 ASR 原文（排查误触发用） */
  rawText: string
  timestamp: number
}

type VoiceEvent =
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
  | VoiceWakeStateEvent
  | VoiceWakeDetectedEvent

// ─── 错误码 ──────────────────────────────────────────────────────────────────

type VoiceErrorCode =
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
 * 是否为声音克隆（Base）变体。
 *
 * 全仓唯一判据：main 侧的配置迁移（voice-config-store）、IPC 覆盖（voice-ipc）
 * 与合成选型（voice-service）都调这里，别再写 `v === '0.6b-base' || v === '1.7b-base'`。
 */
export function isQwen3CloneVariant(variant?: string): variant is '0.6b-base' | '1.7b-base' {
  return variant === '0.6b-base' || variant === '1.7b-base'
}

export type VoiceTtsConfig = {
  /**
   * TTS 引擎 id，对应 `builtin/tts-<engine>/` 注册到注册表里的值：
   * `edge`（内置默认）/ `local-vits`（MeloTTS）/ `qwen3` / `breeze` …
   *
   * **是 string 而不是联合类型**：引擎由插件提供，插件集合随用户启停变化，
   * 联合类型会把「可安装的引擎」写死在核心代码里。合法值以
   * `listTtsEngines()`（`shared/tts-engine-registry.ts`）为准。
   */
  provider: string
  /** 语速（0.8 ~ 1.5） */
  speed: number
  /** 播放音量（0.0 ~ 2.0，>1 为增益增强，适配偏安静的本地模型） */
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

  // ── Breeze TTS（外部部署，插件为 com.lumii.tts.breeze）──────────────────
  /** Breeze 仓库根目录（含 breeze_infer/） */
  breezeRepoPath?: string
  /** checkpoint 目录；相对路径按 breezeRepoPath 解析 */
  breezeModelDir?: string
  /** 服务端口（默认 7860） */
  breezePort?: number
  /** 已运行的服务地址；填了就直接连，不自动拉起 */
  breezeBaseUrl?: string
  /** Python 解释器；缺省用 <repoPath>/.venv */
  breezePython?: string
  /** 指令强度（README 推荐 4 能明显增强指令跟随） */
  breezeCfgScale?: number
  /** 声音设计 / 风格指令 */
  breezeInstruction?: string
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
  /**
   * 灵敏度档位：只修正能量门系数（标准 = 1，与旧行为逐位相同）。
   * **不要拿它去动 `threshold`**——那个要重建 VAD 引擎，装了也热更不了。
   */
  sensitivity?: 'sensitive' | 'standard' | 'strict'
  /** 静音判定时长（毫秒） */
  minSilenceMs: number
  /**
   * 能量门倍率（"负面语音阈值"）：多大声才算真的在说话。
   * listening/打断判定要求段能量 > noiseBaseline * energyGateMultiplier，
   * 用于过滤背景噪声与 TTS 回声。越大越严格（更难被环境音触发）。
   */
  energyGateMultiplier: number
  /**
   * 提交窗口下限（毫秒）：识别出的整句先进缓冲，至少静默这么久才发给 Agent。
   * 窗口期内用户再开口，计时器重置（相当于"你还在说就继续等"）。
   * 0 = 立即提交（旧行为）。
   */
  commitMinMs?: number
  /**
   * 提交窗口上限（毫秒）：从第一段入缓冲算起，最多等这么久就强制提交。
   * 兜住"一直有环境音、永远续期"导致的话说不出去。
   */
  commitMaxMs?: number
  /**
   * @deprecated 旧版单值窗口。读到它（且没有 commitMinMs）时按 min = 该值、max = 该值 × 2 映射。
   */
  commitWindowMs?: number
}

/**
 * AI 朗读（speaking）期间允许用户怎么打断。
 *
 * - `mute`：完全闭麦，说什么都不打断（老字段 `autoMuteMicWhileSpeaking=true` 的等价物）
 * - `two-stage`（默认）：渲染侧疑似开口先压低回放音量，主进程 ASR 确认才真打断
 * - `direct`：不压音，主进程用更低能量门槛直接判定，反应最快也最容易被环境噪声误触
 */
export type VoiceInterruptMode = 'mute' | 'two-stage' | 'direct'

export type VoiceCaptureConfig = {
  /** 系统回声消除（浏览器 AEC） */
  echoCancellation: boolean
  /** 系统降噪（Web 标准只有布尔，**没有强度档**） */
  noiseSuppression: boolean
  /** 系统自动增益（小声说话靠它拉起来；关掉后靠拾音灵敏度档） */
  autoGainControl: boolean
}

export type VoiceEngineConfig = {
  asr: VoiceAsrConfig
  tts: VoiceTtsConfig
  vad: VoiceVadConfig
  /** 朗读期间的打断策略，见 {@link VoiceInterruptMode} */
  interruptMode: VoiceInterruptMode
  /**
   * 采麦前端开关（`getUserMedia` 约束）。**改动需要重开通话**——
   * constraints 只能在建流时给，改不了已开的流。
   */
  capture: VoiceCaptureConfig
  /**
   * 调试开关（默认全关）。能量门/打断门槛都是经验值，真机手测时
   * 没有 `segRms / baseline / gate` 就只能猜"是不是被门挡了"。
   */
  debug?: {
    /** 每次能量门拒绝打一条结构化日志（500ms 限流） */
    gateLog?: boolean
  }
  /**
   * 语音唤醒（默认关）。开启后空闲时持续听麦克风，听到唤醒词（默认「灵栖灵栖」）
   * 就进宠物模式并开始对话。`wakeWord` 允许更换口令，但**必须能被离线 ASR 认出来**，
   * 生僻词/单字长口令识别率很低——这一版不做声学级关键词唤醒。
   */
  wakeWord: {
    enabled: boolean
  }
}

export const DEFAULT_VOICE_ENGINE_CONFIG: VoiceEngineConfig = {
  asr: {
    provider: 'local-paraformer',
    language: 'zh',
  },
  tts: {
    provider: 'edge',
    speed: 1.0,
    volume: 1.0,
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
    sensitivity: 'standard',
    minSpeechMs: 250,
    minSilenceMs: 500,
    energyGateMultiplier: 1.5,
    // 参数量级参考（2026-10 核对）：
    //   OpenAI server_vad silence_duration_ms=500；LiveKit min_silence=550
    //   LiveKit endpointing fixed min_delay=500 / max_delay=3000
    // 我们取 800/2500：短句不至于等太久，长停顿也兜得住。
    commitMinMs: 800,
    commitMaxMs: 2500,
  },
  interruptMode: 'two-stage',
  capture: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  wakeWord: { enabled: false },
}
