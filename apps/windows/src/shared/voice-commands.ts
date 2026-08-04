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

export type VoiceGetConfigCommand = {
  readonly type: 'voice:config:get'
}

export type VoiceSetConfigCommand = {
  readonly type: 'voice:config:set'
  config: {
    asr?: Partial<import('./voice-events.js').VoiceAsrConfig>
    tts?: Partial<import('./voice-events.js').VoiceTtsConfig>
    vad?: Partial<import('./voice-events.js').VoiceVadConfig>
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

export type VoiceCommand =
  | VoiceStartCallCommand
  | VoiceStopCallCommand
  | VoiceGetModelsCommand
  | VoiceDownloadModelCommand
  | VoiceGetConfigCommand
  | VoiceSetConfigCommand
  | VoicePlaybackFinishedCommand
  | VoiceTtsPreviewCommand
  | VoiceTtsStopPreviewCommand
  | VoiceTtsGenerateFileCommand
