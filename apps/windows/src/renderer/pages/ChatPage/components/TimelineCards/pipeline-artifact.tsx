/**
 * 流水线产物卡：用户必须直接看到「跑了什么、差多少、从哪打开」。
 *
 * 数据只来自 `pipeline_run` 的返回（run + journal 的摘要），卡里不做第二次探测：
 * 静态导出是否存在由主进程在返回时判定（`previewPath`），这里只负责呈现。
 */
import React, { useMemo, useState } from 'react'
import { ComparePreviewModal } from '../../../../components/ComparePreview'
import type { TimelineCardContext } from './registry'
import styles from './pipeline-artifact.module.css'

interface PipelineStepSummary {
  readonly id: string
  readonly ok: boolean
  readonly ms: number
  readonly observed?: unknown
}

/**
 * `pipeline_run` 的 JSON 载荷（只声明卡片用得到的字段）。
 * 失败时是 `{status:'error', message, failedAt?}`，与成功共用同一个解析入口。
 */
export interface PipelineRunPayload {
  readonly status?: string
  readonly runId?: string
  readonly journalPath?: string
  readonly note?: string
  readonly provenanceTarget?: string
  readonly previewPath?: string
  readonly steps?: readonly PipelineStepSummary[]
  readonly failedAt?: { readonly i: number; readonly id: string }
  readonly message?: string
}

/** 工具结果 → JSON 载荷；jsonToolResult 把 JSON 放在 content[0].text */
export function parsePipelineRunResult(result: unknown): PipelineRunPayload | null {
  let text: string | undefined
  if (typeof result === 'string') text = result
  else if (result && typeof result === 'object') {
    const content = (result as { content?: unknown }).content
    if (Array.isArray(content)) {
      const first = content.find(
        (c): c is { type?: string; text: string } =>
          !!c && typeof c === 'object' && (c as { type?: string }).type === 'text' &&
          typeof (c as { text?: unknown }).text === 'string',
      )
      text = first?.text
    }
  }
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as PipelineRunPayload
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * `report` 步 output 里的「剩余差异 N 条」。
 * 口径以报告步的结构化尾行为准；解析不到返回 null，卡片降级成「见 README」。
 */
export function parseRemainingDifferences(payload: PipelineRunPayload): number | null {
  const report = payload.steps?.find((s) => s.id === 'report')
  const output = (report?.observed as { output?: unknown } | undefined)?.output
  if (typeof output !== 'string') return null
  const m = output.match(/剩余差异\D{0,12}(\d+)/)
  return m ? Number(m[1]) : null
}

/** 绝对路径 → 预览协议 URL（与主进程 buildLocalMediaFileUrl 同一形态） */
function toLocalFileUrl(absPath: string): string {
  return `lumii-local://local/${encodeURI(absPath.replace(/\\/g, '/'))}`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export const PipelineArtifactCard: React.FC<TimelineCardContext> = ({ part }) => {
  const payload = useMemo(() => parsePipelineRunResult(part.result), [part.result])
  const [compareOpen, setCompareOpen] = useState(false)

  const args = part.args ?? {}
  const pipelineId = typeof args.id === 'string' ? args.id : ''
  const mode = args.mode === 'record' ? '录制' : '彩排'

  if (!payload) {
    return <div className={styles.card}>流水线结果无法解析，请查看执行日志。</div>
  }

  const failed = payload.status !== 'ok'
  const steps = payload.steps ?? []
  const okCount = steps.filter((s) => s.ok).length
  const totalMs = steps.reduce((sum, s) => sum + (Number.isFinite(s.ms) ? s.ms : 0), 0)
  const remaining = parseRemainingDifferences(payload)
  const canCompare = Boolean(payload.previewPath && payload.provenanceTarget)

  return (
    <div className={styles.card} data-testid="pipeline-artifact-card">
      <div className={styles.header}>
        <span className={failed ? styles.badgeFailed : styles.badgeOk}>
          {failed ? '流水线失败' : '流水线完成'}
        </span>
        <span className={styles.title}>{pipelineId || 'pipeline'}</span>
        <span className={styles.meta}>
          {mode} · {okCount}/{steps.length} 步 · {formatDuration(totalMs)}
        </span>
      </div>

      {failed && (
        <div className={styles.error}>
          {payload.message ?? '失败'}
          {payload.failedAt ? `（第 ${payload.failedAt.i + 1} 步 ${payload.failedAt.id}）` : ''}
        </div>
      )}

      {!failed && (
        <div className={styles.stats}>
          <span>
            剩余差异：<strong>{remaining == null ? '见 README' : `${remaining} 条`}</strong>
          </span>
          {payload.note && <span className={styles.note}>{payload.note}</span>}
        </div>
      )}

      <div className={styles.actions}>
        {canCompare ? (
          <button type="button" className={styles.primary} onClick={() => setCompareOpen(true)}>
            对照预览
          </button>
        ) : (
          <span className={styles.hint}>
            {payload.previewPath
              ? '缺少源站地址（spec.provenance.target），无法双栏对照。'
              : '未生成静态导出：调试方式见项目 README（npm run dev）。'}
          </span>
        )}
        {payload.runId && <span className={styles.runId}>run {payload.runId}</span>}
      </div>

      {compareOpen && canCompare && (
        <ComparePreviewModal
          sourceUrl={payload.provenanceTarget!}
          localUrl={toLocalFileUrl(payload.previewPath!)}
          onClose={() => setCompareOpen(false)}
        />
      )}
    </div>
  )
}
