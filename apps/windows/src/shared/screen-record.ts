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

/**
 * 录制会话内打点（活跃时钟 atMs，与 elapsedMs 同基准）。
 * 教程流水线：stop 后用 timeline 生成 narrate cues。
 */
export interface ScreenRecordMarker {
  id: string
  atMs: number
  label: string
  kind?: 'beat' | 'action' | 'note'
}

/** screen_record_mark 参数 */
export type ScreenRecordMarkParams = {
  label: string
  kind?: 'beat' | 'action' | 'note'
}

/** screen_record_mark 返回 */
export type ScreenRecordMarkResult =
  | {
      ok: true
      marker: ScreenRecordMarker
      elapsedMs: number
    }
  | { ok: false; error: ScreenRecordErrorCode; message?: string }

/** stop 返回（设计 §3.1 第 3 行 + 教程 timeline） */
export type ScreenRecordStopResult =
  | {
      ok: true
      path: string
      durationMs: number
      bytes: number
      /** 本会话打点（按 atMs 升序；无打点时为空数组） */
      timeline: ScreenRecordMarker[]
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
      /** 目标窗口被最小化/遮挡导致画面丢失，成片已冻结最后一帧 */
      targetHidden?: boolean
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
  | { readonly type: 'screen-record:mark'; params: ScreenRecordMarkParams }
  | { readonly type: 'screen-record:inspect'; path: string }
  | { readonly type: 'screen-record:list-recordings' }
  | { readonly type: 'screen-record:delete-recording'; path: string }
  | { readonly type: 'screen-record:restore-original'; path: string }
  | { readonly type: 'screen-record:load-subtitle-project'; path: string }
  | {
      readonly type: 'screen-record:save-subtitle-project'
      path: string
      cues: ScreenRecordSubtitleCue[]
    }
  | { readonly type: 'screen-record:burn-subtitles'; params: ScreenRecordBurnSubtitlesParams }
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
  /** 成片写盘完成：渲染层据此打开面板并定位到新成片 */
  | {
      readonly type: 'screen-record:event:recording-saved'
      path: string
      durationMs: number
      bytes: number
      mp4Path?: string
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

/**
 * narrate 成功/失败结果。
 * 成片就地覆盖；原片备份在 `{stem}.lumii-subs/original.*`（见 originalPath）。
 */
export type ScreenRecordNarrateResult =
  | {
      ok: true
      /** 当前可见成片路径（就地更新后，可能已是 mp4） */
      path: string
      /** 无字幕原片备份 */
      originalPath?: string
      /** `*.lumii-subs` 附属目录 */
      projectDir?: string
      srtPath?: string
      mp4Path?: string
      bytes: number
      durationMs?: number
      dubbed: boolean
      /** burn 成功为 true；soft 或烧录降级为 false */
      burned: boolean
      ttsCount?: number
      warning?: 'subtitle_burn_failed' | 'mp4_failed'
      /** 一句人话说明（如就地覆盖、勿查找 *-narrated） */
      message?: string
    }
  | { ok: false; error: ScreenRecordErrorCode; message?: string }

/** screen_record_inspect：成片与字幕附属元数据（不读帧） */
export type ScreenRecordInspectResult =
  | {
      ok: true
      path: string
      exists: boolean
      bytes?: number
      mtimeMs?: number
      durationMs?: number
      hasOriginal: boolean
      hasSrt: boolean
      hasProject: boolean
      ttsCount: number
      originalPath?: string
      projectDir?: string
      srtPath?: string
    }
  | { ok: false; error: ScreenRecordErrorCode; message?: string }

/** 成片库列表项 */
export interface ScreenRecordRecordingItem {
  path: string
  name: string
  bytes: number
  mtimeMs: number
  hasSrt: boolean
  hasProject: boolean
}

export type ScreenRecordListRecordingsResult =
  | { ok: true; items: ScreenRecordRecordingItem[] }
  | { ok: false; error: ScreenRecordErrorCode; message?: string }

/** 删除成片及字幕工程附属文件的结果 */
export type ScreenRecordDeleteRecordingResult =
  | { ok: true; deletedPaths: string[] }
  | { ok: false; error: ScreenRecordErrorCode; message?: string }

/** 用附属目录内的无字幕原片覆盖当前成片（撤销烧录）的结果 */
export type ScreenRecordRestoreOriginalResult =
  | { ok: true; path: string }
  | { ok: false; error: ScreenRecordErrorCode; message?: string }

/**
 * 字幕外观样式。
 * fontSize 沿用 ASS 语义：以 PlayResY=288 为基准，实际像素高度会按视频高等比放大，
 * 因此预览换算必须用同一基准，见 SUBTITLE_ASS_PLAY_RES_Y。
 */
export interface ScreenRecordSubtitleStyle {
  fontSize: number
  /** #RRGGBB 字体颜色 */
  primaryColor: string
  /** 描边宽度（0 表示无描边） */
  outline: number
}

/** libass 渲染 SRT 时的默认 PlayResY */
export const SUBTITLE_ASS_PLAY_RES_Y = 288

export const SCREEN_RECORD_SUBTITLE_STYLE_DEFAULTS: ScreenRecordSubtitleStyle = {
  fontSize: 28,
  primaryColor: '#FFFFFF',
  outline: 2,
}

/** 字幕项目 cue（编辑器 / burn） */
export interface ScreenRecordSubtitleCue {
  id?: string
  startMs: number
  endMs?: number
  text: string
  textHash?: string
  audioFile?: string
}

export type ScreenRecordLoadSubtitleProjectResult =
  | {
      ok: true
      cues: Array<Required<Pick<ScreenRecordSubtitleCue, 'id' | 'startMs' | 'endMs' | 'text' | 'textHash'>> & {
        audioFile?: string
      }>
      style: ScreenRecordSubtitleStyle
      source: 'project' | 'srt' | 'narrated_srt' | 'empty'
      /** 附属目录内的无字幕原片；编辑器用它预览以免与已烧录字幕重影 */
      originalPath?: string
    }
  | { ok: false; error: ScreenRecordErrorCode; message?: string }

export type ScreenRecordSaveSubtitleProjectResult =
  | { ok: true; projectPath: string; srtPath: string }
  | { ok: false; error: ScreenRecordErrorCode; message?: string }

/** 烧录参数：可传 cues；省略则读 sidecar project */
export interface ScreenRecordBurnSubtitlesParams {
  path: string
  cues?: ScreenRecordSubtitleCue[]
  /** 默认 true：增量 TTS 配音 */
  dub?: boolean
  /** 默认 burn */
  subtitleMode?: 'soft' | 'burn'
  originalAudioGain?: number
  exportMp4?: boolean
  /** 字幕外观；省略则沿用项目文件中已保存的样式 */
  style?: Partial<ScreenRecordSubtitleStyle>
}

export type ScreenRecordBurnSubtitlesResult =
  | {
      ok: true
      path: string
      srtPath?: string
      projectPath?: string
      mp4Path?: string
      warning?: 'subtitle_burn_failed' | 'mp4_failed'
      ttsRegenerated?: number
      ttsReused?: number
    }
  | { ok: false; error: ScreenRecordErrorCode; message?: string }
