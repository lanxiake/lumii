/**
 * 语音通话 IPC 命令类型定义
 * 渲染进程 → 主进程的命令
 */

export type VoiceStartCallCommand = {
  readonly type: 'voice:call:start'
  sessionKey: string
  agentId?: string
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

/** 预览/朗读 TTS（设置页短试听；消息朗读可传更大 maxChars） */
export type VoiceTtsPreviewCommand = {
  readonly type: 'voice:tts:preview'
  text?: string
  /**
   * 最大朗读字符数。设置页试听建议 100；消息朗读可到数千。
   * 默认 100（兼容旧调用）。上限 20000。
   */
  maxChars?: number
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
  | VoiceProfilesSaveTempRefCommand
