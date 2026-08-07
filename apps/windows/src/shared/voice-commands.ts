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

/** 预览 TTS 声音（设置页用，不影响当前通话） */
export type VoiceTtsPreviewCommand = {
  readonly type: 'voice:tts:preview'
  text?: string
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

export type VoiceCommand =
  | VoiceStartCallCommand
  | VoiceStopCallCommand
  | VoiceGetModelsCommand
  | VoiceDownloadModelCommand
  | VoicePauseModelCommand
  | VoiceCancelModelCommand
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
