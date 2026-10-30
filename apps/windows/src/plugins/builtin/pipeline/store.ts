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

export function listPipelines(pipelinesRoot: string, knownTools: ReadonlySet<string>): PipelineSummary[] {
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
    const v = validateSpec(raw, knownTools)
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
): { spec: PipelineSpec; specHash: string } | { error: string } {
  const specPath = path.join(pipelinesRoot, pipelineId, 'spec.json')
  try {
    const raw = JSON.parse(fs.readFileSync(specPath, 'utf8'))
    const v = validateSpec(raw, knownTools)
    return v.ok ? { spec: v.spec, specHash: v.specHash } : { error: v.errors.join('; ') }
  } catch (err) {
    return { error: `读取失败: ${err instanceof Error ? err.message : String(err)}` }
  }
}
