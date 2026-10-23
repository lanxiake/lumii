/**
 * 录屏扩展的主进程契约与访问器。
 *
 * 核心（托盘 / 主窗口 / Agent 工具）只认这里的接口；实现在官方扩展
 * `plugins/external-src/screen-record/impl`，由扩展在 `apply` 里装配后挂上来。
 * 扩展没装/被禁用时取到 null，调用方按「功能不可用」处理。
 *
 * 状态挂 `globalThis`：官方扩展是独立 bundle，模块级变量会有第二份拷贝，
 * 否则工具层拿到的永远是 null（静默失能）。
 */
import type {
  ScreenRecordAnnotateParams,
  ScreenRecordAnnotateResult,
  ScreenRecordInspectResult,
  ScreenRecordListSourcesResult,
  ScreenRecordMarkParams,
  ScreenRecordMarkResult,
  ScreenRecordNarrateParams,
  ScreenRecordNarrateResult,
  ScreenRecordPauseResult,
  ScreenRecordResumeResult,
  ScreenRecordStartParams,
  ScreenRecordStartResult,
  ScreenRecordStatusResult,
  ScreenRecordStopParams,
  ScreenRecordStopResult,
  ScreenScreenshotParams,
  ScreenScreenshotResult,
} from '../../shared/screen-record'

/** 录屏会话编排（状态机 / 确认 / 写盘）对外的全部能力 */
export interface ScreenRecordService {
  listSources: (includeThumbnail?: boolean) => Promise<ScreenRecordListSourcesResult>
  start: (params: ScreenRecordStartParams) => Promise<ScreenRecordStartResult>
  stop: (params?: ScreenRecordStopParams) => Promise<ScreenRecordStopResult>
  /** 暂停录制（仅 recording） */
  pause: () => Promise<ScreenRecordPauseResult>
  /** 继续录制（仅 paused） */
  resume: () => Promise<ScreenRecordResumeResult>
  /**
   * 活跃时钟打点（仅 recording）。
   * 教程：resume 后先 mark 再操作；stop 返回 timeline 供 narrate cues。
   */
  mark: (params: ScreenRecordMarkParams) => ScreenRecordMarkResult
  /**
   * 画面标注入 timeline（recording 或 paused 均可）。
   * 后期由 narrate ffmpeg 烧录，录制期不叠加。
   */
  annotate: (params: ScreenRecordAnnotateParams) => ScreenRecordAnnotateResult
  /** 截取整屏/窗口单帧（可与录屏并行；确认槽独立） */
  screenshot: (params: ScreenScreenshotParams) => Promise<ScreenScreenshotResult>
  getStatus: () => ScreenRecordStatusResult
  respondConfirm: (p: {
    sessionId: string
    allow: boolean
    rememberAlwaysAllow?: boolean
  }) => Promise<void>
  handleChunk: (p: {
    sessionId: string
    chunkBase64: string
    index: number
    isLast: boolean
  }) => Promise<void>
  handleStreamEnded: (p: { sessionId: string }) => Promise<void>
  handleCaptureError: (p: { sessionId: string; reason: string }) => Promise<void>
  handleRendererGone: () => Promise<void>
  flushBeforeQuit: () => Promise<void>
}

/** 旁白编排（TTS → SRT → 混音/烧字幕） */
export interface NarrateService {
  narrate: (params: ScreenRecordNarrateParams) => Promise<ScreenRecordNarrateResult>
}

/** 读取成片旁的 `lumii-subs.json`（Agent 工具用；纯文件读，不碰录制状态） */
export type RecordingInspector = (videoPath: string) => ScreenRecordInspectResult

const KEY = Symbol.for('lumii.screen-record.contract')
const shared = ((globalThis as Record<symbol, unknown>)[KEY] ??= {
  service: null,
  narrate: null,
  recordingInspector: null,
}) as {
  service: ScreenRecordService | null
  narrate: NarrateService | null
  recordingInspector: RecordingInspector | null
}

/** 设置全局录屏服务单例（扩展 apply 时调用；卸载传 null） */
export function setScreenRecordService(svc: ScreenRecordService | null): void {
  shared.service = svc
}

/** 读取全局录屏服务单例 */
export function getScreenRecordService(): ScreenRecordService | null {
  return shared.service
}

/** 挂接旁白服务实例 */
export function setNarrateService(svc: NarrateService | null): void {
  shared.narrate = svc
}

/** 获取旁白服务（未初始化返回 null） */
export function getNarrateService(): NarrateService | null {
  return shared.narrate
}

/** 挂接成片检查器（扩展装配时调用；卸载传 null） */
export function setRecordingInspector(fn: RecordingInspector | null): void {
  shared.recordingInspector = fn
}

/** 获取成片检查器（扩展未装配返回 null） */
export function getRecordingInspector(): RecordingInspector | null {
  return shared.recordingInspector
}
