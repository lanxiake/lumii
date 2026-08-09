/**
 * 语音通话 IPC 命令类型定义
 * 渲染进程 → 主进程的命令
 */

export type VoiceStartCallCommand = {
  readonly type: 'voice:call:start'
  sessionKey: string
  agentId?: string
  /** 文字回复出声（不采麦），仅做 TTS 播放 */
  micless?: boolean
  /**
   * 持续朗读模式（仅 micless）：一轮 TTS 结束不结束通话，回到等待态朗读下一轮回复。
   * 用于「实时朗读」开关常驻；省略时为旧行为（一轮即停）。
   */
  persistent?: boolean
}

export type VoiceStopCallCommand = {
  readonly type: 'voice:call:stop'
  callId: string
}

export type VoiceGetModelsCommand = {
  readonly type: 'voice:models:get'
}

export type VoiceDownloadModelCommand = {
  readonly type: 'voice:models:download'
  modelId: string
}

/** 暂停模型下载（保留 partial，可续传） */
export type VoicePauseModelCommand = {
  readonly type: 'voice:models:pause'
  modelId: string
}

/** 取消模型下载并清理 partial */
export type VoiceCancelModelCommand = {
  readonly type: 'voice:models:cancel'
  modelId: string
}

/** 卸载已下载的模型/运行时（删除本地文件；PyTorch 另卸 pip 包） */
export type VoiceUninstallModelCommand = {
  readonly type: 'voice:models:uninstall'
  modelId: string
}

export type VoiceGetConfigCommand = {
  readonly type: 'voice:config:get'
}

export type VoiceSetConfigCommand = {
  readonly type: 'voice:config:set'
  config: {
    asr?: Partial<import('./voice-events.js').VoiceAsrConfig>
    tts?: Partial<import('./voice-events.js').VoiceTtsConfig>
    vad?: Partial<import('./voice-events.js').VoiceVadConfig>
    autoMuteMicWhileSpeaking?: boolean
  }
}

/** 渲染进程通知主进程：TTS 音频已完全播放完毕 */
export type VoicePlaybackFinishedCommand = {
  readonly type: 'voice:playback:finished'
  callId: string
}

/**
 * 试听时临时覆盖的音色参数（不写入全局配置，仅本次预览生效）。
 * 用于「语音合成」区试听内置音色、「我的音色」列表逐条试听克隆声，避免串声。
 */
export type VoiceTtsPreviewOverride = {
  provider?: 'local-vits' | 'edge' | 'qwen3'
  /** 是否用克隆出声（true 时配合 qwen3ProfileId 走 Base 克隆） */
  cloneEnabled?: boolean
  /** 克隆音色档案 ID */
  qwen3ProfileId?: string
  /** Qwen3 模型变体（内置 custom / 克隆 base） */
  qwen3Variant?: import('./voice-events.js').Qwen3TtsVariant
  /** CustomVoice 内置说话人 */
  qwen3Speaker?: string
  /** Edge 音色名 */
  voice?: string
  /** 合成语言 */
  language?: string
}

/** 预览/朗读 TTS（设置页短试听；消息朗读可传更大 maxChars） */
export type VoiceTtsPreviewCommand = {
  readonly type: 'voice:tts:preview'
  text?: string
  /**
   * 最大朗读字符数。设置页试听建议 100；消息朗读可到数千。
   * 默认 100（兼容旧调用）。上限 20000。
   */
  maxChars?: number
  /**
   * 可选：临时覆盖音色（仅本次预览生效，不改全局配置）。
   * 省略时沿用全局 config，行为与旧版一致。
   */
  override?: VoiceTtsPreviewOverride
  /**
   * 可选：本次预览的会话标识。主进程会原样带回 preview:chunk / preview:ended 事件，
   * 消费端据此只播放自己发起的那次的音频，避免设置页试听与消息朗读互相串流。
   */
  previewId?: string
}

/** 停止 TTS 预览/朗读播放 */
export type VoiceTtsStopPreviewCommand = {
  readonly type: 'voice:tts:stop-preview'
}

/** 将文本合成为音频文件，返回文件绝对路径 */
export type VoiceTtsGenerateFileCommand = {
  readonly type: 'voice:tts:generate-file'
  text: string
  destDir: string
}

/** 开始 ASR 实时识别测试（不拉起 Agent） */
export type VoiceAsrTestStartCommand = {
  readonly type: 'voice:asr:test:start'
}

/** 停止 ASR 实时识别测试 */
export type VoiceAsrTestStopCommand = {
  readonly type: 'voice:asr:test:stop'
}

/** 列出克隆音色档案 */
export type VoiceProfilesListCommand = {
  readonly type: 'voice:profiles:list'
}

/** 创建/更新克隆音色档案（refAudioPath 为绝对路径，将拷贝入库） */
export type VoiceProfilesUpsertCommand = {
  readonly type: 'voice:profiles:upsert'
  profile: {
    id?: string
    name: string
    refAudioPath: string
    refText: string
    language?: string
    qwen3Variant?: import('./voice-events.js').Qwen3TtsVariant
    xVectorOnly?: boolean
  }
}

/** 删除克隆音色档案 */
export type VoiceProfilesDeleteCommand = {
  readonly type: 'voice:profiles:delete'
  profileId: string
}

/** 重命名克隆音色档案（仅改名称，不动参考音频） */
export type VoiceProfilesRenameCommand = {
  readonly type: 'voice:profiles:rename'
  profileId: string
  name: string
}

/** 将克隆参考音频写入临时目录，返回绝对路径 */
export type VoiceProfilesSaveTempRefCommand = {
  readonly type: 'voice:profiles:save-temp-ref'
  /** 原始音频字节的 base64 */
  audioBase64: string
  /** 扩展名，默认 wav */
  ext?: 'wav' | 'webm'
}

export type VoiceCommand =
  | VoiceStartCallCommand
  | VoiceStopCallCommand
  | VoiceGetModelsCommand
  | VoiceDownloadModelCommand
  | VoicePauseModelCommand
  | VoiceCancelModelCommand
  | VoiceUninstallModelCommand
  | VoiceGetConfigCommand
  | VoiceSetConfigCommand
  | VoicePlaybackFinishedCommand
  | VoiceTtsPreviewCommand
  | VoiceTtsStopPreviewCommand
  | VoiceTtsGenerateFileCommand
  | VoiceAsrTestStartCommand
  | VoiceAsrTestStopCommand
  | VoiceProfilesListCommand
  | VoiceProfilesUpsertCommand
  | VoiceProfilesDeleteCommand
  | VoiceProfilesRenameCommand
  | VoiceProfilesSaveTempRefCommand
