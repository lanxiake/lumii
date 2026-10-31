import type { JournalLine, PipelineSpec, RunMeta } from './types'

/**
 * 确定性流水线对核心暴露的能力（type-only 契约，核心不 import 实现）。
 *
 * 核心在三处用到它：bridge 注册 `pipeline_*` 工具、IPC 表的 list/detail/run/cancel、
 * 插件停用后 `S.pipeline` 消失 ⇒ 这些路径自动变成 no-op。
 * 面与计划 Task 5 写死的一致——不得增删。
 */
export interface PipelineSummary {
  readonly id: string
  readonly name?: string
  /** 一句人话说明；提示词与页面都直接用它 */
  readonly description?: string
  readonly stepCount: number
  readonly narrationCount?: number
  readonly lastRun?: { runId: string; at: number; ok: boolean }
  /** spec 坏了（校验失败）时带原因；不抛，让 UI 显示「这条 spec 坏了」 */
  readonly error?: string
}

export interface PipelineDetail {
  readonly spec: PipelineSpec
  readonly specHash: string
  readonly runs: readonly RunMeta[]
  readonly lastJournal?: readonly JournalLine[]
}

export interface PipelineRunResult {
  readonly ok: boolean
  readonly runId: string
  readonly journalPath: string
  readonly failedAt?: { i: number; id: string; expected?: unknown; observed?: unknown }
  readonly steps: readonly { id: string; ok: boolean; ms: number; observed?: unknown }[]
  /**
   * 录制产物。**必须透出到工具返回与页面**：
   * 用户点了「录制运行」、run 也报成功，却看不到视频——闭环就断在这里。
   * `mode:'record'` 却没有 artifact 时，`error` 会说明原因（spec 禁用录制 / 录屏服务不可用）。
   */
  readonly artifact?: {
    mp4Path?: string
    burned?: boolean
    dubbed?: boolean
    durationMs?: number
    cueCount?: number
  }
  readonly error?: string
}

export interface PipelineService {
  list(): Promise<PipelineSummary[]>
  detail(id: string): Promise<PipelineDetail | null>
  run(
    id: string,
    opts: { mode: 'record' | 'rehearsal'; resumeRunId?: string },
  ): Promise<PipelineRunResult>
  cancel(runId: string): void
}
