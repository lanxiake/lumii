/**
 * spec 加载与三道校验（计划 Task 1）。
 *
 * 核心原则（计划约束 4）：**加载期拒绝优于运行期失败**。工具名不存在、前向引用、
 * 空 steps……都在这里拒掉，不允许跑到第 7 步才炸。
 *
 * 校验**一次报全部错误**——用户改 spec 时最烦的是挤牙膏（一轮只报一条）。
 */
import { createHash } from 'node:crypto'
import {
  REF_PATTERN,
  type PipelineSpec,
  type PipelineStep,
  type PipelinePrecondition,
  type CleanupStep,
} from './types'

export type ValidateResult =
  | { ok: true; spec: PipelineSpec; specHash: string }
  | { ok: false; errors: string[] }

const DEFAULT_HOLD_MS = 800

/** 收集一行里所有 `{{ref}}` 的 stepId（引用只能向后；路径本身运行期再解析） */
function refsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    for (const m of value.matchAll(REF_PATTERN)) out.push(m[1]!)
  } else if (Array.isArray(value)) {
    for (const v of value) refsIn(v, out)
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) refsIn(v, out)
  }
  return out
}

/**
 * 归一化 JSON：键排序 + 无空白。**不含任何运行时字段**（时间戳等），
 * 所以同一 spec 两次加载 hash 必然相等（计划 Task 1 用例）。
 */
function normalize(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      return Object.fromEntries(
        Object.keys(o)
          .sort()
          .map((k) => [k, walk(o[k])]),
      )
    }
    return v
  }
  return JSON.stringify(walk(value))
}

export function hashSpec(spec: PipelineSpec): string {
  return createHash('sha256').update(normalize(stripDefaults(spec))).digest('hex')
}

/** 去掉「实现填的缺省值」，让 hash 只反映作者写的字节 */
function stripDefaults(spec: PipelineSpec): unknown {
  return {
    ...spec,
    steps: spec.steps.map((s) => (s.holdMs === DEFAULT_HOLD_MS ? { ...s, holdMs: undefined } : s)),
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export function validateSpec(raw: unknown, knownTools: ReadonlySet<string>): ValidateResult {
  const errors: string[] = []

  if (!isObj(raw)) return { ok: false, errors: ['spec 必须是一个 JSON 对象'] }

  if (typeof raw.id !== 'string' || !raw.id.trim()) errors.push('缺少非空的 id')
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    errors.push('steps 必须是非空数组（空流水线没有意义；需要条件分支说明它不该是流水线）')
    // steps 空就不必往下查引用了
    return { ok: false, errors }
  }

  // ── 逐 step 校验 ──
  const steps: PipelineStep[] = []
  const seen = new Set<string>()
  raw.steps.forEach((s, i) => {
    if (!isObj(s)) {
      errors.push(`steps[${i}] 不是对象`)
      return
    }
    const id = typeof s.id === 'string' ? s.id.trim() : ''
    if (!id) {
      errors.push(`steps[${i}] 缺少非空的 id`)
      return
    }

    const tool = typeof s.tool === 'string' ? s.tool : ''
    if (!tool) errors.push(`steps[${i}] (${id}) 缺少 tool`)
    else if (!knownTools.has(tool)) errors.push(`steps[${i}] (${id}) unknown tool: ${tool}`)

    // 重复 id：记错误后**继续校验这个 step 的其余字段**，再跳过入表。
    // 提前 return 会让「id 重复」这一步的工具名校验被吞掉——那正是「一次报全部错误」要防的挤牙膏。
    if (seen.has(id)) {
      errors.push(`steps[${i}] 的 id "${id}" 重复（id 在同一 spec 内必须唯一）`)
      return
    }
    seen.add(id)

    steps.push({
      id,
      tool,
      label: typeof s.label === 'string' ? s.label : undefined,
      narration: typeof s.narration === 'string' ? s.narration : undefined,
      params: isObj(s.params) ? s.params : undefined,
      holdMs: typeof s.holdMs === 'number' ? s.holdMs : DEFAULT_HOLD_MS,
      expect: isObj(s.expect) ? (s.expect as PipelineStep['expect']) : undefined,
    })
  })

  // ── 引用完整性：只能向后 + 无环 ──
  const order = new Map(steps.map((s, i) => [s.id, i]))
  steps.forEach((s, i) => {
    for (const ref of refsIn(s.params)) {
      const at = order.get(ref)
      if (at === undefined) {
        errors.push(`steps[${i}] (${s.id}) 引用了不存在的 step "${ref}"`)
      } else if (at >= i) {
        errors.push(`steps[${i}] (${s.id}) 前向引用 "${ref}"（引用只能向后，循环在加载期就拒）`)
      }
    }
  })

  // ── preconditions / postCleanup：同样要 id 与已知工具 ──
  const preconditions: PipelinePrecondition[] = []
  if (raw.preconditions !== undefined) {
    if (!Array.isArray(raw.preconditions)) errors.push('preconditions 必须是数组')
    else
      raw.preconditions.forEach((p, i) => {
        if (!isObj(p)) return errors.push(`preconditions[${i}] 不是对象`)
        const id = typeof p.id === 'string' ? p.id.trim() : ''
        if (!id) errors.push(`preconditions[${i}] 缺少非空的 id`)
        const tool = typeof p.tool === 'string' ? p.tool : ''
        if (!tool) errors.push(`preconditions[${i}] 缺少 tool`)
        else if (!knownTools.has(tool)) errors.push(`preconditions[${i}] unknown tool: ${tool}`)
        if (id && tool) {
          preconditions.push({
            kind: 'toolOk',
            id,
            tool,
            params: isObj(p.params) ? p.params : undefined,
            expect: isObj(p.expect) ? (p.expect as PipelinePrecondition['expect']) : undefined,
            hint: typeof p.hint === 'string' ? p.hint : undefined,
          })
        }
      })
  }

  const postCleanup: CleanupStep[] = []
  if (raw.postCleanup !== undefined) {
    if (!Array.isArray(raw.postCleanup)) errors.push('postCleanup 必须是数组')
    else
      raw.postCleanup.forEach((c, i) => {
        if (!isObj(c)) return errors.push(`postCleanup[${i}] 不是对象`)
        const id = typeof c.id === 'string' ? c.id.trim() : ''
        if (!id) errors.push(`postCleanup[${i}] 缺少非空的 id`)
        const tool = typeof c.tool === 'string' ? c.tool : ''
        if (!tool) errors.push(`postCleanup[${i}] 缺少 tool`)
        else if (!knownTools.has(tool)) errors.push(`postCleanup[${i}] unknown tool: ${tool}`)
        if (id && tool) {
          postCleanup.push({ id, tool, params: isObj(c.params) ? c.params : undefined })
        }
      })
  }

  if (errors.length > 0) return { ok: false, errors }

  const spec: PipelineSpec = {
    id: String(raw.id),
    name: typeof raw.name === 'string' ? raw.name : undefined,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    source: isObj(raw.source) ? (raw.source as PipelineSpec['source']) : undefined,
    record: isObj(raw.record) ? (raw.record as unknown as PipelineSpec['record']) : undefined,
    preconditions: preconditions.length ? preconditions : undefined,
    steps,
    postCleanup: postCleanup.length ? postCleanup : undefined,
  }
  return { ok: true, spec, specHash: hashSpec(spec) }
}
