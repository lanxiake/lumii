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
  /** `<pipelines>/<id>/inputs.json` 的当前内容（文件不存在时为 undefined） */
  readonly inputs?: Readonly<Record<string, string>>
  /** 缺哪些变量：跑之前必须先补上，否则引用它的那一步会失败 */
  readonly missingInputs?: readonly string[]
}

/** 端口：IPC 与工具两条路都用它，保证「跑的是同一份 inputs」 */
export interface PipelineRunOptions {
  readonly mode: 'record' | 'rehearsal'
  readonly resumeRunId?: string
  /** 覆盖 inputs.json 的变量（缺省读 inputs.json） */
  readonly inputs?: Record<string, string>
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
   * `mode:'record'` 却没有 artifact 时：录屏服务不可用 → `error`；spec 自己否决录制 →
   * 不算失败（见 `note`）。veto 若判失败，这类流水线就只剩彩排，而彩排会跳过
   * 需授权工具与 agent 节点——等于根本没法跑（2026-11-01 真机）。
   */
  readonly note?: string
  /** spec 声明的源站地址（复刻类）；对照视图左栏用它 */
  readonly provenanceTarget?: string
  /** spec.preview.htmlPath 解析出的存在文件（绝对路径）；不存在则缺省 */
  readonly previewPath?: string
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
  run(id: string, opts: PipelineRunOptions): Promise<PipelineRunResult>
  cancel(runId: string): void
}
