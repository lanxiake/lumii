/**
 * 录屏 IPC 注册（主进程侧）
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ScreenRecordService } from './screen-record-service'
import type {
  ScreenRecordStartParams,
  ScreenRecordStopParams,
  ScreenRecordNarrateParams,
  ScreenRecordBurnSubtitlesParams,
  ScreenRecordSubtitleCue,
  ScreenRecordSubtitleStyle,
} from '../../../../shared/screen-record'
import { getNarrateService } from '../../../../main/kernel/screen-record-contract'
import { getBurnSubtitlesService } from './burn-accessor'
import {
  listRecordings,
  loadSubtitleProject,
  restoreOriginalRecording,
  saveSubtitleProject,
  cuesToProjectCues,
  deleteRecordingArtifacts,
} from './subtitle-project'
import { resolveRecordingsDir } from '../../../../main/workspace-paths'
import { isPathUnderDir } from '../../../../main/preview-path-acl'
import { createMeasuredHandler } from '../../../../main/kernel/measured-handler'
import type { IpcHandleRegistrar } from '../../../../main/kernel/ipc-registry'
import type { PerfMonitorLike } from '../../../../shared/performance'

/**
 * 校验渲染层传来的成片路径：必须是 recordings 根目录下的 webm/mp4。
 */
function guardRecordingPath(
  videoPath: string | undefined,
): { ok: true; abs: string } | { ok: false; error: { ok: false; error: string; message?: string } } {
  if (!videoPath) {
    return { ok: false, error: { ok: false, error: 'source_unavailable', message: 'path required' } }
  }
  const abs = path.resolve(videoPath)
  const root = path.resolve(resolveRecordingsDir())
  const ext = path.extname(abs).toLowerCase()
  if (
    !isPathUnderDir(abs, root) ||
    path.dirname(abs) !== root ||
    (ext !== '.webm' && ext !== '.mp4')
  ) {
    return { ok: false, error: { ok: false, error: 'source_not_in_recordings' } }
  }
  return { ok: true, abs }
}

/**
 * 注册录屏 IPC，绑定到单一 ScreenRecordService。
 *
 * 通道经**注册器**挂载（扩展 apply 里传 `ctx.registerIpc` / `ctx.registerIpcListener`）：
 * 停用/热重载时随扩展作用域摘除；注册器本身对重复 handler 幂等（先摘旧再挂）。
 */
export function registerScreenRecordIpc(
  registrar: IpcHandleRegistrar,
  service: ScreenRecordService,
  performanceMonitor?: PerfMonitorLike,
): void {

  registrar.handle('screen-record:list-sources', async (_e, p?: { includeThumbnail?: boolean }) => {
    return service.listSources(p?.includeThumbnail)
  })

  const startHandler = async (
    _e: unknown,
    p: { params: ScreenRecordStartParams } | ScreenRecordStartParams,
  ) => {
    const params = 'params' in p && p.params ? p.params : (p as ScreenRecordStartParams)
    return service.start(params)
  }
  registrar.handle(
    'screen-record:start',
    performanceMonitor
      ? createMeasuredHandler('screen-record:start', startHandler, performanceMonitor)
      : startHandler,
  )

  registrar.handle('screen-record:stop', async (_e, p?: { params?: ScreenRecordStopParams } | ScreenRecordStopParams) => {
    const params =
      p && typeof p === 'object' && 'params' in p && p.params
        ? p.params
        : (p as ScreenRecordStopParams | undefined)
    return service.stop(params)
  })

  registrar.handle('screen-record:narrate', async (_e, p: { params: ScreenRecordNarrateParams }) => {
    const narrate = getNarrateService()
    if (!narrate) return { ok: false, error: 'disabled' }
    return narrate.narrate(p.params)
  })

  registrar.handle('screen-record:list-recordings', async () => {
    try {
      const items = listRecordings(resolveRecordingsDir())
      return { ok: true, items }
    } catch (e) {
      return {
        ok: false,
        error: 'write_failed',
        message: e instanceof Error ? e.message : String(e),
      }
    }
  })

  registrar.handle('screen-record:delete-recording', async (_e, p: { path: string }) => {
    const guarded = guardRecordingPath(p?.path)
    if (!guarded.ok) return guarded.error
    return deleteRecordingArtifacts(guarded.abs)
  })

  registrar.handle('screen-record:restore-original', async (_e, p: { path: string }) => {
    const guarded = guardRecordingPath(p?.path)
    if (!guarded.ok) return guarded.error
    return restoreOriginalRecording(guarded.abs)
  })

  registrar.handle('screen-record:load-subtitle-project', async (_e, p: { path: string }) => {
    const videoPath = p?.path
    if (!videoPath) return { ok: false, error: 'invalid_cues', message: 'path required' }
    const abs = path.resolve(videoPath)
    const root = path.resolve(resolveRecordingsDir())
    if (!isPathUnderDir(abs, root)) {
      return { ok: false, error: 'source_not_in_recordings' }
    }
    const loaded = loadSubtitleProject(abs)
    if (!loaded.ok) {
      return { ok: false, error: loaded.error, message: loaded.message }
    }
    return {
      ok: true,
      cues: loaded.cues,
      style: loaded.style,
      source: loaded.source,
      originalPath: loaded.originalPath,
    }
  })

  registrar.handle(
    'screen-record:save-subtitle-project',
    async (
      _e,
      p: {
        path: string
        cues: ScreenRecordSubtitleCue[]
        style?: Partial<ScreenRecordSubtitleStyle>
      },
    ) => {
      const videoPath = p?.path
      if (!videoPath) return { ok: false, error: 'invalid_cues', message: 'path required' }
      const abs = path.resolve(videoPath)
      const root = path.resolve(resolveRecordingsDir())
      if (!isPathUnderDir(abs, root)) {
        return { ok: false, error: 'source_not_in_recordings' }
      }
      if (!fs.existsSync(abs)) {
        return { ok: false, error: 'source_unavailable' }
      }
      const cues = cuesToProjectCues(
        (p.cues ?? []).map((c) => ({
          id: c.id,
          startMs: c.startMs,
          endMs: c.endMs ?? c.startMs + 1,
          text: c.text,
          audioFile: c.audioFile,
        })),
      )
      const saved = saveSubtitleProject(abs, cues, p.style)
      if (!saved.ok) {
        return { ok: false, error: saved.error, message: saved.message }
      }
      return saved
    },
  )

  registrar.handle(
    'screen-record:burn-subtitles',
    async (_e, p: { params: ScreenRecordBurnSubtitlesParams }) => {
      const burn = getBurnSubtitlesService()
      if (!burn) {
        return {
          ok: false,
          error: 'disabled',
          message: '烧录服务尚未就绪，请稍后再试',
        }
      }
      return burn.burn(p.params)
    },
  )

  registrar.handle('screen-record:pause', async () => service.pause())

  registrar.handle('screen-record:resume', async () => service.resume())

  registrar.handle('screen-record:status', async () => service.getStatus())

  registrar.on?.(
    'screen-record:confirm-respond',
    (_e, p: { sessionId: string; allow: boolean; rememberAlwaysAllow?: boolean }) => {
      void service.respondConfirm(p)
    },
  )

  registrar.on?.(
    'screen-record:chunk',
    (
      _e,
      p: { sessionId: string; chunkBase64: string; index: number; isLast: boolean },
    ) => {
      void service.handleChunk(p)
    },
  )

  registrar.on?.('screen-record:stream-ended', (_e, p: { sessionId: string }) => {
    void service.handleStreamEnded(p)
  })

  registrar.on?.(
    'screen-record:capture-error',
    (_e, p: { sessionId: string; reason: string }) => {
      void service.handleCaptureError(p)
    },
  )
}
