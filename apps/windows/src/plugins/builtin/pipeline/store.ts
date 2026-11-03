/**
 * 流水线目录扫描与 run 目录创建（计划 Task 4）。
 *
 * 用目录而非 sqlite（设计 §5.2）：引擎是可选插件，不给核心加表；journal 只追加、
 * 单次读一个 run，JSONL 比表适配；与录屏 `.lumii-subs` 侧车同构（文件即状态）。
 * **代价**：跨 run 统计要扫目录——单机几十~几千 run 足够，P2 有 dashboard 再加索引。
 */
import fs from 'node:fs'
import path from 'node:path'
import { validateSpec } from './spec'
import type { PipelineSpec, RunMeta } from './types'

export interface PipelineSummary {
  id: string
  name?: string
  description?: string
  stepCount: number
  narrationCount: number
  lastRun?: { runId: string; at: number; ok: boolean }
  /** spec 坏了（校验失败）：不抛，让 UI 显示「这条 spec 坏了」 */
  error?: string
}

function lastRunOf(pipelineDir: string): PipelineSummary['lastRun'] {
  const runsDir = path.join(pipelineDir, 'runs')
  let entries: string[]
  try {
    entries = fs.readdirSync(runsDir)
  } catch {
    return undefined
  }
  let best: RunMeta | null = null
  for (const name of entries) {
    try {
      const meta = JSON.parse(
        fs.readFileSync(path.join(runsDir, name, 'meta.json'), 'utf8'),
      ) as RunMeta
      if (!best || meta.startedAt > best.startedAt) best = meta
    } catch {
      /* 坏 meta 跳过 */
    }
  }
  return best ? { runId: best.runId, at: best.startedAt, ok: best.status === 'ok' } : undefined
}

export function listPipelines(
  pipelinesRoot: string,
  knownTools: ReadonlySet<string>,
  knownAgents: ReadonlySet<string>,
): PipelineSummary[] {
  let ids: string[]
  try {
    ids = fs
      .readdirSync(pipelinesRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return [] // 目录不存在 = 还没有流水线，不是错误
  }

  const out: PipelineSummary[] = []
  for (const id of ids) {
    const specPath = path.join(pipelinesRoot, id, 'spec.json')
    if (!fs.existsSync(specPath)) continue
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(specPath, 'utf8'))
    } catch (err) {
      out.push({ id, stepCount: 0, narrationCount: 0, error: `spec.json 不是合法 JSON: ${err instanceof Error ? err.message : err}` })
      continue
    }
    const v = validateSpec(raw, knownTools, knownAgents)
    if (!v.ok) {
      out.push({ id, stepCount: 0, narrationCount: 0, error: v.errors.join('; ') })
      continue
    }
    out.push({
      id,
      name: v.spec.name,
      description: v.spec.description,
      stepCount: v.spec.steps.length,
      narrationCount: v.spec.steps.filter((s) => s.narration).length,
      lastRun: lastRunOf(path.join(pipelinesRoot, id)),
    })
  }
  return out
}

/** `runs/<yyyymmdd-hhmmss>-<6位随机>/`，并写 spec 快照 + sha256（spec 后来被改也不影响回溯） */
export function createRunDir(
  pipelinesRoot: string,
  pipelineId: string,
  spec: PipelineSpec,
  specHash: string,
  now: Date = new Date(),
): { runDir: string } {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, '0')
  const runDir = path.join(pipelinesRoot, pipelineId, 'runs', `${stamp}-${rand}`)
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'spec.snapshot.json'), JSON.stringify(spec, null, 2), 'utf8')
  fs.writeFileSync(path.join(runDir, 'spec.sha256'), specHash, 'utf8')
  return { runDir }
}

/** 读单条 spec（detail 用） */
export function readSpec(
  pipelinesRoot: string,
  pipelineId: string,
  knownTools: ReadonlySet<string>,
  knownAgents: ReadonlySet<string>,
): { spec: PipelineSpec; specHash: string } | { error: string } {
  const specPath = path.join(pipelinesRoot, pipelineId, 'spec.json')
  try {
    const raw = JSON.parse(fs.readFileSync(specPath, 'utf8'))
    const v = validateSpec(raw, knownTools, knownAgents)
    return v.ok ? { spec: v.spec, specHash: v.specHash } : { error: v.errors.join('; ') }
  } catch (err) {
    return { error: `读取失败: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * 读 `{workspace}/pipelines/<id>/inputs.json`。
 *
 * 位置刻意与 spec.json 同级而不是放进 runs/：它是**下一次要跑的输入**，跟 spec 一样
 * 随工作区走 git 与云同步，换设备后填一次就能再跑。跟着 run 走就成了历史记录。
 *
 * 文件不存在**不算错误**——没变量的流水线压根不会有这个文件。
 * 但文件存在却读不动（坏 JSON / 不是对象）必须报错：静默当成「没有变量」
 * 会让引用它的步骤在跑到第 3 步时才炸，而真正的原因（文件写坏了）被埋掉。
 */
export function readInputsFile(
  pipelinesRoot: string,
  pipelineId: string,
): { ok: true; inputs: Record<string, string> } | { ok: false; error: string } {
  const p = path.join(pipelinesRoot, pipelineId, 'inputs.json')
  if (!fs.existsSync(p)) return { ok: true, inputs: {} }
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: `inputs.json 必须是对象 {"变量名": "值"}，实际是 ${Array.isArray(raw) ? '数组' : typeof raw}` }
    }
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      // 数字/布尔一并转成字符串：模板里它们最终都是拼进命令与提示词的文本，
      // 保留 JSON 类型只会在 resolveParams 的 `typeof got === 'string'` 分支里被 JSON.stringify。
      if (v == null) continue
      out[k] = typeof v === 'string' ? v : String(v)
    }
    return { ok: true, inputs: out }
  } catch (err) {
    return { ok: false, error: `inputs.json 解析失败: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** 缺哪些变量（spec 引用到的 - 已提供的）。空数组 = 齐了 */
export function missingInputs(spec: PipelineSpec, provided: Record<string, string>): string[] {
  return (spec.inputs ?? []).map((i) => i.name).filter((n) => !(n in provided))
}
