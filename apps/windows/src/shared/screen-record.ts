/**
 * 客户端录屏（AI 可控）共享类型、命令/事件与常量
 * 对齐设计 docs/design/2026-08-15-screen-record-design.md
 */

/** 录屏源（screen/window），Lumii 自身源 isLumii=true */
export interface ScreenRecordSource {
  sourceId: string
  name: string
  /** 'screen' 整屏 | 'window' 单窗口 */
  type: 'screen' | 'window'
  /** 是否 Lumii 自身窗口（免确认）。主进程以 webContents.getMediaSourceId() 为主判断，标题 fallback */
  isLumii: boolean
  /** 缩略图 base64 dataURL；list_sources includeThumbnail=false 时为 '' */
  thumbnailDataUrl: string
  /** display_id 辅助区分多屏 */
  displayId?: string
}

/** 录屏状态机六态（MVP 五态 + 二期 paused） */
export type ScreenRecordStatus =
  | 'idle'
  | 'pending_confirm'
  | 'recording'
  | 'paused'
  | 'stopping'
  | 'error'

/** 设计 §6 错误码 + 二期 pause/resume */
export type ScreenRecordErrorCode =
  | 'disabled'
  | 'already_recording'
  | 'no_active_session'
  | 'source_unavailable'
  | 'insufficient_disk_space'
  | 'mic_unavailable'
  | 'system_audio_unavailable'
  | 'permission_denied'
  | 'confirmation_timeout'
  | 'stream_ended'
  | 'capture_failed'
  | 'write_failed'
  | 'usage'
  /** pause 时非 recording */
  | 'not_recording'
  /** resume 时非 paused */
  | 'not_paused'
  /** 旁白：TTS 不可用 */
  | 'tts_unavailable'
  /** 旁白：编排/混流失败 */
  | 'narrate_failed'
  /** 旁白：cues 非法 */
  | 'invalid_cues'
  /** 旁白：源文件不在 recordings/ */
  | 'source_not_in_recordings'

/** list_sources 工具参数 */
export interface ScreenRecordListSourcesParams {
  includeThumbnail?: boolean
}

/** list_sources 返回 */
export type ScreenRecordListSourcesResult =
  | { ok: true; sources: ScreenRecordSource[] }
  | { ok: false; error: ScreenRecordErrorCode; message?: string }

/** screen_record_start 参数（设计 §3.1 第二行） */
export interface ScreenRecordStartParams {
  sourceId: string
  /** 默认 true，跟随设置 includeMicDefault；显式传值覆盖默认 */
  includeMic?: boolean
  /** 默认跟随 includeSystemAudioDefault；显式传值覆盖 */
  includeSystemAudio?: boolean
  /** 默认 1800；>7200 截断 7200；<0 报 usage */
  maxDurationSec?: number
}

/** start 返回（needs_confirmation 时不阻塞 Agent） */
export type ScreenRecordStartResult =
  | { ok: true; status: 'recording'; sessionId: string; startedAt: number }
  | {
      ok: true
      status: 'needs_confirmation'
      sessionId: string
      confirmTimeoutSec: number
      sourceName: string
      sourceType: string
    }
  | { ok: false; error: ScreenRecordErrorCode; message?: string }

/** screen_record_stop 可选参数 */
export interface ScreenRecordStopParams {
  /** 停止后导出 MP4；默认跟随 exportMp4Default */
  exportMp4?: boolean
}

/** stop 返回（设计 §3.1 第 3 行） */
export type ScreenRecordStopResult =
  | {
      ok: true
      path: string
      durationMs: number
      bytes: number
      /** 可选 MP4 路径（exportMp4 成功时） */
      mp4Path?: string
      /** 麦/系统声降级或 MP4 失败时带 warning */
      warning?: 'mic_muted' | 'system_audio_muted' | 'audio_degraded' | 'mp4_failed'
    }
  | { ok: false; error: ScreenRecordErrorCode; message?: string; partialPath?: string }

/** status 返回（设计 §3.1 第 4 行） */
export type ScreenRecordStatusResult =
  | {
      ok: true
      status: ScreenRecordStatus
      sessionId?: string
      sourceId?: string
      sourceName?: string
      elapsedMs?: number
      startedAt?: number
      /** status === 'pending_confirm' 时带剩余倒计时秒 */
      pendingConfirm?: boolean
      confirmTimeoutSec?: number
      confirmStartedAt?: number
      includeMic?: boolean
    }
  | { ok: false; error: ScreenRecordErrorCode }

/** 录屏设置（设计 §4.5 + 二期 exportMp4） */
export interface ScreenRecordConfig {
  enabled: boolean
  /** AI 非自身源录屏是否免确认（仍尊重系统麦克风权限） */
  alwaysAllow: boolean
  /** 默认是否混入麦克风 */
  includeMicDefault: boolean
  /** 默认是否录系统声（Windows 整屏较可靠；单窗口可能无音轨） */
  includeSystemAudioDefault: boolean
  /** 停止时默认是否导出 MP4（失败保留 WebM，warning=mp4_failed） */
  exportMp4Default: boolean
  /** 旁白混流时原声音量增益（0–1，默认 0.35） */
  narrateOriginalAudioGain: number
  /** AI 触发时确认弹窗超时秒数，超时自动拒绝 */
  confirmTimeoutSec: number
}

/** 录屏设置默认值 */
export const SCREEN_RECORD_SETTINGS_DEFAULTS: ScreenRecordConfig = {
  enabled: true,
  alwaysAllow: false,
  includeMicDefault: true,
  includeSystemAudioDefault: true,
  exportMp4Default: false,
  narrateOriginalAudioGain: 0.35,
  confirmTimeoutSec: 120,
}

/** 录屏落盘子目录名（相对 `{workspace}/temp/`） */
export const RECORDINGS_DIRNAME = 'recordings'

/** maxDurationSec 上限；超出截断不报错 */
export const MAX_DURATION_SEC_CAP = 7200

/** 磁盘可用 < 此值（500 MB）start 直接拒绝 */
export const MIN_FREE_DISK_BYTES = 500 * 1024 * 1024

/** MediaRecorder 分片间隔（设计 §2.2 chunk interval 2–5s） */
export const MEDIA_RECORDER_TIMESLICE_MS = 3000

/** 单 chunk 超此字节数（2 MB）时在 IPC 发送前拆分，避免阻塞主进程 */
export const MAX_CHUNK_BYTES_PER_IPC = 2 * 1024 * 1024

/** 确认超时触发的 session 内部定时 tick 精度 */
export const CONFIRM_TIMEOUT_TICK_MS = 1000

/* ---------------- IPC 命令 & 事件类型（三处同步用） ---------------- */

/** Renderer → Main 命令（ScreenRecordService 作为唯一 consumer） */
export type ScreenRecordCommand =
  | { readonly type: 'screen-record:list-sources'; includeThumbnail?: boolean }
  | { readonly type: 'screen-record:start'; params: ScreenRecordStartParams; sessionId?: string }
  | { readonly type: 'screen-record:stop'; params?: ScreenRecordStopParams }
  | { readonly type: 'screen-record:pause' }
  | { readonly type: 'screen-record:resume' }
  | { readonly type: 'screen-record:status' }
  | { readonly type: 'screen-record:narrate'; params: ScreenRecordNarrateParams }
  | {
      readonly type: 'screen-record:confirm-respond'
      sessionId: string
      allow: boolean
      rememberAlwaysAllow?: boolean
    }
  /** 渲染进程分片写盘（base64） */
  | {
      readonly type: 'screen-record:chunk'
      sessionId: string
      chunkBase64: string
      index: number
      isLast: boolean
    }
  /** 渲染进程 MediaStream ended（目标窗口关闭） */
  | { readonly type: 'screen-record:stream-ended'; sessionId: string }
  /** 渲染进程采集层报错 */
  | { readonly type: 'screen-record:capture-error'; sessionId: string; reason: string }

/** Main → Renderer 事件（ScreenRecordCapture / UI 订阅） */
export type ScreenRecordEvent =
  | {
      readonly type: 'screen-record:event:status-changed'
      status: ScreenRecordStatus
      detail: ScreenRecordStatusResult
    }
  | {
      readonly type: 'screen-record:event:confirm-requested'
      sessionId: string
      sourceName: string
      sourceType: string
      sourceId: string
      thumbnailDataUrl?: string
      timeoutSec: number
      startedAt: number
    }
  | {
      readonly type: 'screen-record:event:start-capture'
      sessionId: string
      sourceId: string
      includeMic: boolean
      includeSystemAudio: boolean
      maxDurationSec: number
    }
  | { readonly type: 'screen-record:event:stop-capture'; sessionId: string }
  | { readonly type: 'screen-record:event:pause-capture'; sessionId: string }
  | { readonly type: 'screen-record:event:resume-capture'; sessionId: string }
  | {
      readonly type: 'screen-record:event:cancelled'
      sessionId: string
      reason: ScreenRecordErrorCode
    }
  /** 托盘「开始录屏」但无预选源时，请求渲染层打开面板 */
  | { readonly type: 'screen-record:open-panel' }
  /** 确认弹窗勾选「始终允许」后，请求渲染层把设置落盘 */
  | { readonly type: 'screen-record:persist-always-allow'; value: boolean }

/** pause / resume 工具返回 */
export type ScreenRecordPauseResult =
  | { ok: true; status: 'paused'; elapsedMs: number }
  | { ok: false; error: ScreenRecordErrorCode; message?: string }

export type ScreenRecordResumeResult =
  | { ok: true; status: 'recording'; elapsedMs: number }
  | { ok: false; error: ScreenRecordErrorCode; message?: string }

/** 旁白单条字幕/口播 cue（缺 endMs 时由 TTS 时长填补） */
export interface ScreenRecordNarrateCue {
  startMs: number
  text: string
  endMs?: number
}

/**
 * screen_record_narrate 参数。
 * subtitleMode 默认 **burn**（烧进画面）；同时仍写出旁路 .srt（writeSrt 默认 true）。
 */
export interface ScreenRecordNarrateParams {
  /** 源成片绝对路径，须落在 recordings/ */
  path: string
  cues: ScreenRecordNarrateCue[]
  /** 默认 true：写出 UTF-8 .srt */
  writeSrt?: boolean
  /** 默认 true：TTS 配音混入 */
  dub?: boolean
  /** 默认 burn；burn 失败可降级 soft */
  subtitleMode?: 'soft' | 'burn'
  /** 原声增益，默认跟随设置 narrateOriginalAudioGain（0.35） */
  originalAudioGain?: number
  /** 成片后再导出 MP4 */
  exportMp4?: boolean
}

/** narrate 成功/失败结果 */
export type ScreenRecordNarrateResult =
  | {
      ok: true
      /** 旁白后新文件路径（原片保留） */
      path: string
      srtPath?: string
      mp4Path?: string
      warning?: 'subtitle_burn_failed' | 'mp4_failed'
    }
  | { ok: false; error: ScreenRecordErrorCode; message?: string }
