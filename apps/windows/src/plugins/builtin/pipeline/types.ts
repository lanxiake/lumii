/**
 * 确定性流水线的数据契约。
 *
 * 设计依据：`docs/design/流水线/2026-10-29-确定性流水线设计.md` §4，
 * 以及 `docs/design/逆向与复刻/2026-11-01-逆向复刻与流水线编排设计.md` §4.2/§4.3（agent 节点）。
 * spec 是**数据**（`{workspace}/pipelines/<id>/spec.json`），引擎是插件；
 * 加一条流水线 = 加一个 JSON，不改代码。
 *
 * 三条写死的约束（设计 §4.3）：
 * - 不做条件分支、循环、并发。**需要分支说明路径不能枚举，那就不该做成流水线**。
 * - `{{}}` 引用只能**向后**（引用先前步骤），循环在加载期拒。
 * - `postCleanup` 无论成败都跑，失败只记日志不抛。
 *
 * agent 节点不改变这三条：**路径仍由 spec 写死**，agent 的产出只是数据，不参与路由。
 * 「下一步要不要跑」不属于 agent 能决定的事——需要分支时，把整段循环收进**一个** agent 节点内部。
 */

/** `{{stepId.a.b[0].c}}` —— JSONPath 极简子集 */
export const REF_PATTERN = /\{\{\s*([A-Za-z0-9_-]+)((?:\.[A-Za-z0-9_-]+|\[\d+\])*)\s*\}\}/g

interface BaseStep {
  /** 同一 spec 内唯一；`{{}}` 引用与 journal 都用它 */
  readonly id: string
  readonly label?: string
  /** 有它才在录制里打点；**没有旁白就不该有画面停留**（设计 §4.3） */
  readonly narration?: string
  /** 动作返回后停留时长；缺省 800 */
  readonly holdMs: number
  /** 断言；缺省 = 只断言返回 `isError !== true` */
  readonly expect?: StepExpect
}

/** 一次工具调用。`kind` 缺省即 tool —— 老 spec 零改动 */
export interface ToolStep extends BaseStep {
  readonly kind?: 'tool'
  readonly tool: string
  readonly params?: Record<string, unknown>
}

/**
 * 一次 LLM 回合：不可枚举部分的封装。
 *
 * `prompt` 必须自包含——子 Agent 看不到父对话。它同样支持 `{{}}` 向后引用，
 * 所以能把上游工具/agent 的结构化产出直接嵌进提示词。
 */
export interface AgentStep extends BaseStep {
  readonly kind: 'agent'
  /** 通用（缺省 assistant / builtin:explore）或专用（security）。**加载期校验，不回落** */
  readonly agentType?: string
  readonly prompt: string
  readonly allowedTools?: readonly string[]
  readonly model?: string
  /** 彩排时是否真的执行。缺省 'skip'——agent 可能有副作用，默认保守 */
  readonly rehearsal?: 'run' | 'skip'
}

export type PipelineStep = ToolStep | AgentStep

/** 断言：`fields` 子集匹配 + 路径寻址；`viewState` 全等匹配（设计 §4.5） */
export interface StepExpect {
  readonly fields?: Record<string, unknown>
  readonly viewState?: { view?: string; hub?: Record<string, unknown> }
}

export interface PipelinePrecondition {
  readonly kind: 'toolOk'
  readonly tool: string
  /** 预条件也常需要参数（`list_dir` 的 path 必填）；缺省空对象 */
  readonly params?: Record<string, unknown>
  readonly expect?: StepExpect
  readonly hint?: string
  /** preconditions 也需要 id 参与 journal（Task 1 用例要求缺 id 即拒） */
  readonly id: string
}

export interface CleanupStep {
  readonly id: string
  readonly tool: string
  readonly params?: Record<string, unknown>
}

export interface RecordBlock {
  readonly enabled: boolean
  readonly sourceHint?: string
  readonly includeMic?: boolean
  readonly narrate?: { dub?: boolean; subtitleMode?: string; exportMp4?: boolean }
}

export interface PipelineSpec {
  readonly id: string
  readonly name?: string
  readonly description?: string
  /** 从哪条轨迹蒸馏而来（`pipeline_draft` 写的），便于回溯（计划风险表） */
  readonly source?: { sessionKey: string; range: { fromMessageId: string; toMessageId: string } }
  readonly record?: RecordBlock
  readonly preconditions?: readonly PipelinePrecondition[]
  readonly steps: readonly PipelineStep[]
  readonly postCleanup?: readonly CleanupStep[]
}

/** journal 单行（设计 §5.2） */
export interface JournalLine {
  readonly i: number
  readonly id: string
  /** agent 节点没有工具名，记空串 */
  readonly tool: string
  /** 缺省 'tool' —— 老 journal 照常可读 */
  readonly kind?: 'tool' | 'agent'
  readonly startedAt: number
  readonly ms: number
  readonly ok: boolean
  /** 录制打点时刻；由 `screenRecord.mark()` 给，执行器不自算（计划约束 3） */
  readonly markAtMs?: number
  readonly observed?: unknown
  readonly assertOk?: boolean
  readonly holdMs?: number
  /** 失败行才有 */
  readonly error?: string
  readonly expected?: unknown
  readonly skipped?: 'rehearsal'
}

export interface RunMeta {
  readonly runId: string
  readonly specId: string
  readonly mode: 'record' | 'rehearsal'
  readonly specHash: string
  readonly startedAt: number
  endedAt?: number
  status?: 'running' | 'ok' | 'failed' | 'cancelled'
  artifact?: { mp4Path?: string; burned?: boolean; dubbed?: boolean; durationMs?: number; cueCount?: number }
}

/** agent 节点一次执行的入参（与 bridge 的 spawnAgent 对齐，但不含编排层细节） */
export interface RunAgentStageParams {
  readonly stepId: string
  readonly agentType?: string
  readonly prompt: string
  readonly allowedTools?: readonly string[]
  readonly model?: string
}

/** agent 节点的产出。模板里按 `{{stepId.output}}` 取 */
export interface RunAgentStageData {
  readonly output: string
  readonly agentDefinitionId?: string
  readonly agentName?: string
}

/** 执行器依赖（写死，单测只 mock 这几个 —— 计划 Task 3）
 *
 * `runAgentStage` 是**可选**的：宿主没注入时，含 agent 节点的 spec 会在该步明确失败，
 * 而不是静默按 tool 处理（那样会报「unknown tool」这种看不懂的错）。
 */
export interface RunnerDeps {
  callTool(
    name: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; data?: unknown; error?: string }>
  /** 执行一个 agent 回合（同步阻塞到子 Agent 收尾） */
  runAgentStage?(
    params: RunAgentStageParams,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; data?: RunAgentStageData; error?: string }>
  screenRecord: {
    start(p: { sourceId: string; includeMic?: boolean }): Promise<{ ok: boolean; error?: string }>
    stop(): Promise<{ ok: boolean; data?: unknown; error?: string }>
    mark(p: { label: string }): Promise<{ ok: boolean; data?: { atMs: number }; error?: string }>
    /**
     * 列出可录源。runner 用它挑默认源——`start` 要的是 `sourceId`，
     * 而 spec 只写 `sourceHint`（人话），两者不是一个东西。
     */
    listSources(): Promise<readonly { sourceId: string; name?: string; kind?: string }[]>
    /**
     * 旁白合成。cues 的 `startMs` 必须来自**同一步的 markAtMs**（设计 §4.6 的
     * 「同源」保证）——执行器不重算融合规则，`endMs` 交给 narrate 自己按
     * 「下一段起点 − 200ms」算（narrate-service 已有逻辑）。
     */
    narrate(p: {
      path: string
      cues: { startMs: number; text: string }[]
      dub?: boolean
      writeSrt?: boolean
      subtitleMode?: 'soft' | 'burn'
      exportMp4?: boolean
    }): Promise<{ ok: boolean; data?: { mp4Path?: string; burned?: boolean; dubbed?: boolean; cueCount?: number }; error?: string }>
  } | null
  readViewState(): Promise<{
    view: string | null
    hub?: { open: boolean; tab?: string; category?: string }
  }>
  now(): number
}
