/**
 * Agent 录屏工具注册（list / start / stop / status / pause / resume / narrate / mark / inspect）
 * 模式对齐 bridge-app-ui-tools.ts；只调 ScreenRecordService / NarrateService，不碰采集实现。
 */

import path from 'node:path'
import { Type } from '@sinclair/typebox'
import {
  ToolRegistry,
  createMtBotTool,
  type ToolExecutionContext,
  type MtBotTool,
} from '@mtbot/agent-runtime'
import { agentRuntimeLog as log, jsonToolResult } from './bridge-utils'
import type { ScreenRecordService } from '../screen-record'
import type { NarrateService } from '../screen-record/narrate-service'
import { inspectRecording } from '../screen-record/subtitle-project'
import { isPathUnderDir } from '../preview-path-acl'
import { resolveRecordingsDir } from '../workspace-paths'
import { MAX_DURATION_SEC_CAP } from '../../shared/screen-record'

/** registerScreenRecordTools 依赖 */
export interface RegisterScreenRecordToolsDeps {
  getService: () => ScreenRecordService | null
  getNarrateService?: () => NarrateService | null
}

/**
 * 注册录屏工具到 ToolRegistry。
 */
export function registerScreenRecordTools(
  toolRegistry: ToolRegistry,
  ctx: ToolExecutionContext,
  deps: RegisterScreenRecordToolsDeps,
): void {
  const get = () => deps.getService()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reg = (tool: any) => toolRegistry.register(tool as MtBotTool)

  reg(
    createMtBotTool(
      {
        name: 'screen_record_list_sources',
        label: 'Screen Record List Sources',
        category: 'channel' as const,
        description:
          '列出可录制的整屏和窗口源（含 Lumii 自身）。' +
          '默认 includeThumbnail=false 不返回缩略图，节省 token；需要缩略图区分时显式传 true。' +
          'isLumii=true 的源是 Lumii 自身窗口，无需用户确认即可录制。' +
          '演示/存档/教程素材用录屏；看界面细节仍用 app_screenshot / browser_screenshot，禁止用录屏代替截图观察。',
        parameters: Type.Object({
          includeThumbnail: Type.Optional(
            Type.Boolean({
              description: '是否返回每张源的缩略图（base64 PNG，每张 10-50KB，默认 false）',
            }),
          ),
        }),
        isReadOnly: true,
        needsPermission: false,
        execute: async (_id, rawParams) => {
          const svc = get()
          if (!svc) return jsonToolResult({ ok: false, error: 'disabled' })
          const p = (rawParams ?? {}) as { includeThumbnail?: boolean }
          try {
            return jsonToolResult(await svc.listSources(p.includeThumbnail ?? false))
          } catch (e) {
            log.error('[screen_record_list_sources]', e)
            return jsonToolResult({ ok: false, error: 'capture_failed' })
          }
        },
      },
      ctx,
    ),
  )

  reg(
    createMtBotTool(
      {
        name: 'screen_record_start',
        label: 'Screen Record Start',
        category: 'channel' as const,
        description:
          '开始录制指定源。非 Lumii 自身源默认需用户确认（返回 needs_confirmation，可用 status 轮询）。' +
          'includeMic 默认 true；maxDurationSec 默认 1800，最大 7200。' +
          '同时仅一路录制；重复 start 返回 already_recording。' +
          '教程场景建议 includeMic=false（事后 TTS 配音），除非要录真实人声。',
        parameters: Type.Object({
          sourceId: Type.String({ description: 'list_sources 返回的 sourceId' }),
          includeMic: Type.Optional(Type.Boolean({ description: '是否混入麦克风，默认 true' })),
          includeSystemAudio: Type.Optional(
            Type.Boolean({ description: '是否录系统声，默认跟随设置（整屏较可靠）' }),
          ),
          maxDurationSec: Type.Optional(
            Type.Number({ description: '最长录制秒数，默认 1800，上限 7200' }),
          ),
        }),
        isReadOnly: false,
        needsPermission: true,
        execute: async (_id, rawParams) => {
          const svc = get()
          if (!svc) return jsonToolResult({ ok: false, error: 'disabled' })
          const p = rawParams as {
            sourceId?: string
            includeMic?: boolean
            includeSystemAudio?: boolean
            maxDurationSec?: number
          }
          if (!p?.sourceId) {
            return jsonToolResult({ ok: false, error: 'usage', message: 'sourceId required' })
          }
          let maxDurationSec = p.maxDurationSec
          if (typeof maxDurationSec === 'number' && maxDurationSec > MAX_DURATION_SEC_CAP) {
            maxDurationSec = MAX_DURATION_SEC_CAP
          }
          try {
            return jsonToolResult(
              await svc.start({
                sourceId: p.sourceId,
                includeMic: p.includeMic,
                includeSystemAudio: p.includeSystemAudio,
                maxDurationSec,
              }),
            )
          } catch (e) {
            log.error('[screen_record_start]', e)
            return jsonToolResult({ ok: false, error: 'capture_failed' })
          }
        },
      },
      ctx,
    ),
  )

  reg(
    createMtBotTool(
      {
        name: 'screen_record_stop',
        label: 'Screen Record Stop',
        category: 'channel' as const,
        description:
          '结束当前录屏会话，返回 { ok, path, durationMs, bytes, timeline, mp4Path? }。' +
          'timeline 为本会话 mark 打点（活跃时钟 atMs），供 narrate cues 使用。' +
          'exportMp4=true 时尝试转码 MP4（失败保留 WebM，warning=mp4_failed）。' +
          'idle 时返回 no_active_session（幂等，不视为异常）。',
        parameters: Type.Object({
          exportMp4: Type.Optional(
            Type.Boolean({ description: '停止后是否导出 MP4；默认跟随设置 exportMp4Default' }),
          ),
        }),
        isReadOnly: false,
        needsPermission: false,
        execute: async (_id, rawParams) => {
          const svc = get()
          if (!svc) return jsonToolResult({ ok: false, error: 'disabled' })
          const p = (rawParams ?? {}) as { exportMp4?: boolean }
          try {
            return jsonToolResult(await svc.stop({ exportMp4: p.exportMp4 }))
          } catch (e) {
            log.error('[screen_record_stop]', e)
            return jsonToolResult({ ok: false, error: 'capture_failed' })
          }
        },
      },
      ctx,
    ),
  )

  reg(
    createMtBotTool(
      {
        name: 'screen_record_status',
        label: 'Screen Record Status',
        category: 'channel' as const,
        description:
          '查询当前录屏状态（含 paused）。pending_confirm 时 confirmTimeoutSec 告知剩余确认秒数；' +
          'elapsedMs 为活跃录制时长（不含暂停）。',
        parameters: Type.Object({}),
        isReadOnly: true,
        needsPermission: false,
        execute: async () => {
          const svc = get()
          if (!svc) return jsonToolResult({ ok: false, error: 'disabled' })
          try {
            return jsonToolResult(svc.getStatus())
          } catch (e) {
            log.error('[screen_record_status]', e)
            return jsonToolResult({ ok: false, error: 'capture_failed' })
          }
        },
      },
      ctx,
    ),
  )

  reg(
    createMtBotTool(
      {
        name: 'screen_record_pause',
        label: 'Screen Record Pause',
        category: 'channel' as const,
        description:
          '暂停当前录制（仅 recording 态）。暂停期间不成片静默段，活跃计时停止。' +
          '教程模式：思考、截图、规划脚本时先 pause，避免空镜进成片。' +
          '非 recording 返回 not_recording。',
        parameters: Type.Object({}),
        isReadOnly: false,
        needsPermission: false,
        execute: async () => {
          const svc = get()
          if (!svc) return jsonToolResult({ ok: false, error: 'disabled' })
          try {
            return jsonToolResult(await svc.pause())
          } catch (e) {
            log.error('[screen_record_pause]', e)
            return jsonToolResult({ ok: false, error: 'capture_failed' })
          }
        },
      },
      ctx,
    ),
  )

  reg(
    createMtBotTool(
      {
        name: 'screen_record_resume',
        label: 'Screen Record Resume',
        category: 'channel' as const,
        description:
          '继续已暂停的录制（仅 paused 态）。非 paused 返回 not_paused。' +
          '教程模式：恢复后立刻 screen_record_mark，再执行 app_act。',
        parameters: Type.Object({}),
        isReadOnly: false,
        needsPermission: false,
        execute: async () => {
          const svc = get()
          if (!svc) return jsonToolResult({ ok: false, error: 'disabled' })
          try {
            return jsonToolResult(await svc.resume())
          } catch (e) {
            log.error('[screen_record_resume]', e)
            return jsonToolResult({ ok: false, error: 'capture_failed' })
          }
        },
      },
      ctx,
    ),
  )

  reg(
    createMtBotTool(
      {
        name: 'screen_record_mark',
        label: 'Screen Record Mark',
        category: 'channel' as const,
        description:
          '在活跃录制时钟上打点（仅 recording 可用；paused 须先 resume）。' +
          '教程配音前先 mark；stop 后用 timeline 生成 cues（startMs=atMs，text 由 label 扩写），' +
          '禁止凭感觉估时间。建议每个关键演示步一个 beat。',
        parameters: Type.Object({
          label: Type.String({ description: '打点标签，如「获取模型列表」' }),
          kind: Type.Optional(
            Type.Union(
              [Type.Literal('beat'), Type.Literal('action'), Type.Literal('note')],
              { description: '默认 beat' },
            ),
          ),
        }),
        isReadOnly: false,
        needsPermission: false,
        execute: async (_id, rawParams) => {
          const svc = get()
          if (!svc) return jsonToolResult({ ok: false, error: 'disabled' })
          const p = (rawParams ?? {}) as { label?: string; kind?: 'beat' | 'action' | 'note' }
          try {
            return jsonToolResult(svc.mark({ label: p.label ?? '', kind: p.kind }))
          } catch (e) {
            log.error('[screen_record_mark]', e)
            return jsonToolResult({ ok: false, error: 'capture_failed' })
          }
        },
      },
      ctx,
    ),
  )

  reg(
    createMtBotTool(
      {
        name: 'screen_record_inspect',
        label: 'Screen Record Inspect',
        category: 'channel' as const,
        description:
          '只读检查 recordings/ 内成片与 *.lumii-subs 附属状态（exists/bytes/hasOriginal/hasSrt/ttsCount 等）。' +
          '用于 narrate 后验收；禁止用 glob/bash 猜测 *-narrated / *-burned 文件名。',
        parameters: Type.Object({
          path: Type.String({ description: '成片绝对路径（须在 recordings/）' }),
        }),
        isReadOnly: true,
        needsPermission: false,
        execute: async (_id, rawParams) => {
          const p = (rawParams ?? {}) as { path?: string }
          if (!p?.path || typeof p.path !== 'string') {
            return jsonToolResult({ ok: false, error: 'usage', message: 'path required' })
          }
          try {
            const abs = path.resolve(p.path)
            const root = path.resolve(resolveRecordingsDir())
            if (!isPathUnderDir(abs, root)) {
              return jsonToolResult({
                ok: false,
                error: 'source_not_in_recordings',
                message: 'path must be under recordings/',
              })
            }
            return jsonToolResult(inspectRecording(abs))
          } catch (e) {
            log.error('[screen_record_inspect]', e)
            return jsonToolResult({
              ok: false,
              error: 'capture_failed',
              message: e instanceof Error ? e.message : String(e),
            })
          }
        },
      },
      ctx,
    ),
  )

  reg(
    createMtBotTool(
      {
        name: 'screen_record_narrate',
        label: 'Screen Record Narrate',
        category: 'channel' as const,
        description:
          '对 recordings/ 内成片做字幕+TTS。成片就地覆盖；原片在 {stem}.lumii-subs/original.*。' +
          '默认 writeSrt=true、dub=true、subtitleMode=burn。教程交付请 exportMp4=true。' +
          '返回含 dubbed/burned/bytes/originalPath/projectDir/message；' +
          '禁止 glob 查找 *-narrated/*-burned。音色复用客户端语音设置。' +
          'cues：优先用 stop 返回的 timeline 转 startMs+旁白文案；长文本控制 cues 数量。',
        parameters: Type.Object({
          path: Type.String({ description: '源成片绝对路径（须在 recordings/）' }),
          cues: Type.Array(
            Type.Object({
              startMs: Type.Number(),
              text: Type.String(),
              endMs: Type.Optional(Type.Number()),
            }),
            { minItems: 1 },
          ),
          writeSrt: Type.Optional(Type.Boolean()),
          dub: Type.Optional(Type.Boolean()),
          subtitleMode: Type.Optional(
            Type.Union([Type.Literal('burn'), Type.Literal('soft')], {
              description: '默认 burn',
            }),
          ),
          originalAudioGain: Type.Optional(Type.Number()),
          exportMp4: Type.Optional(Type.Boolean()),
        }),
        isReadOnly: false,
        needsPermission: false,
        execute: async (_id, rawParams) => {
          const narrateSvc = deps.getNarrateService?.() ?? null
          if (!narrateSvc) return jsonToolResult({ ok: false, error: 'disabled' })
          const p = rawParams as {
            path?: string
            cues?: Array<{ startMs: number; text: string; endMs?: number }>
            writeSrt?: boolean
            dub?: boolean
            subtitleMode?: 'burn' | 'soft'
            originalAudioGain?: number
            exportMp4?: boolean
          }
          try {
            return jsonToolResult(
              await narrateSvc.narrate({
                path: p.path ?? '',
                cues: p.cues ?? [],
                writeSrt: p.writeSrt,
                dub: p.dub,
                subtitleMode: p.subtitleMode,
                originalAudioGain: p.originalAudioGain,
                exportMp4: p.exportMp4,
              }),
            )
          } catch (e) {
            log.error('[screen_record_narrate]', e)
            return jsonToolResult({ ok: false, error: 'narrate_failed' })
          }
        },
      },
      ctx,
    ),
  )
}
