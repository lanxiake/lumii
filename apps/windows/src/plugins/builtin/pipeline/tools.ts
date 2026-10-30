/**
 * 三个 `pipeline_*` 工具（计划 Task 5）。
 *
 * 与技能同一套动词（设计 §4.3）：search↔list、invoke↔inspect、execute↔run。**不发明第五个概念**。
 * 这里只做参数校验 + 把结果塞进 content；真正的执行在 `index.ts` 装配时注入的 service 里。
 *
 * 契约要点（`types/tool.ts`）：`details` 会被清空，**模型只能看到 content**。
 * 所以失败原因、`failedAt/expected/observed` 必须写进 content 的人话里。
 */
import { Type, type Static } from '@sinclair/typebox'
import type { PipelineService, PipelineDetail } from './service-api'

/** 工具名（桥接与测试共用一份） */
export const PIPELINE_TOOL_NAMES = ['pipeline_list', 'pipeline_run', 'pipeline_inspect'] as const

/** 这三个工具的 execute 形态（与 MtBotToolConfig 的 execute 同形，但不依赖具体泛型） */
export interface PipelineToolConfig {
  readonly name: string
  readonly label: string
  readonly description: string
  readonly parameters: unknown
  execute(id: string, params: unknown, ctx: unknown): Promise<{
    content: { type: 'text'; text: string }[]
    details?: unknown
    isError?: boolean
  }>
}

/** §7.4 的三条判据——写进描述，因为模型只读描述 */
const WHEN_TO_USE =
  '什么时候用：路径能预先枚举、每步有可断言结果、且会重复跑——三条全中才做流水线。' +
  '不满足就留在对话里（Agent 自己做），硬套会变成「写死的不够用的脚本」，比 Agent 更糟。'

const ListInput = Type.Object({})
type ListInputT = Static<typeof ListInput>

const RunInput = Type.Object({
  id: Type.String({ description: '流水线 id（`{workspace}/pipelines/<id>/`）' }),
  mode: Type.Optional(
    Type.Union([Type.Literal('rehearsal'), Type.Literal('record')], {
      description: 'rehearsal=彩排（不录、跳过需授权工具、仍跑断言）；record=正式跑并录制。缺省 rehearsal',
    }),
  ),
  resumeRunId: Type.Optional(Type.String({ description: '从某次失败的 run 续跑（跳过已 ok 的步骤）' })),
})
type RunInputT = Static<typeof RunInput>

const InspectInput = Type.Object({
  id: Type.String({ description: '流水线 id' }),
})
type InspectInputT = Static<typeof InspectInput>

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], details: undefined }
}
function fail(message: string, extra: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ status: 'error', message, ...extra }) }],
    details: undefined,
    isError: true,
  }
}

export function createPipelineToolConfigs(service: PipelineService): PipelineToolConfig[] {
  const list: PipelineToolConfig = {
    name: 'pipeline_list',
    label: 'List Pipelines',
    description:
      '列出本机已定义的确定性流水线（id / 名称 / 步数 / 最近一次结果）。' +
      '回答「有哪些自动化」用这个，别猜。坏掉的 spec 会带 error 字段而不是消失。' +
      WHEN_TO_USE,
    parameters: ListInput,
    async execute() {
      try {
        const all = await service.list()
        return ok({ total: all.length, pipelines: all })
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    },
  }

  const run: PipelineToolConfig = {
    name: 'pipeline_run',
    label: 'Run Pipeline',
    description:
      '按 spec 逐步执行一条流水线。**一次工具调用跑完全程**（不占多轮，不会撞 maxTurns）。' +
      '任一步失败即停，返回 {failedAt, expected, observed, journalPath}。' +
      '先用 rehearsal 彩排（不录、跳过需授权工具、仍验断言），确认选择器都还命中再 record。' +
      WHEN_TO_USE,
    parameters: RunInput,
    async execute(_id, raw) {
      const p = (raw ?? {}) as RunInputT
      const id = typeof p.id === 'string' ? p.id.trim() : ''
      if (!id) return fail('缺少 id —— 要知道跑哪一条。先用 pipeline_list 看有哪些。')
      const mode = p.mode ?? 'rehearsal'
      if (mode !== 'rehearsal' && mode !== 'record') {
        return fail(`mode 只能是 rehearsal 或 record，收到 "${String(p.mode)}"`)
      }
      try {
        const res = await service.run(id, { mode, resumeRunId: p.resumeRunId })
        if (!res.ok) {
          return fail(res.error ?? `流水线在第 ${(res.failedAt?.i ?? -1) + 1} 步失败`, {
            runId: res.runId,
            journalPath: res.journalPath,
            failedAt: res.failedAt,
            steps: res.steps,
          })
        }
        return ok({ status: 'ok', runId: res.runId, journalPath: res.journalPath, steps: res.steps })
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    },
  }

  const inspect: PipelineToolConfig = {
    name: 'pipeline_inspect',
    label: 'Inspect Pipeline',
    description:
      '看一条流水线的 spec 摘要与最近一次 run 的 journal（每步耗时 / 断言结果 / 失败点）。' +
      '排「上次为什么失败」用这个——报错文本在 journal 的 failedAt 里，不在别处。' +
      WHEN_TO_USE,
    parameters: InspectInput,
    async execute(_id, raw) {
      const p = (raw ?? {}) as InspectInputT
      const id = typeof p.id === 'string' ? p.id.trim() : ''
      if (!id) return fail('缺少 id —— 要知道看哪一条。')
      try {
        const d: PipelineDetail | null = await service.detail(id)
        if (!d) return fail(`找不到流水线 "${id}"。用 pipeline_list 看有哪些。`)
        return ok({
          specId: id,
          stepCount: d.spec.steps.length,
          runs: d.runs.length,
          journal: d.lastJournal ?? [],
        })
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    },
  }

  return [list, run, inspect]
}
