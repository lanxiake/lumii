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
  readonly stepCount: number
  readonly lastRun?: { runId: string; at: number; ok: boolean }
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
