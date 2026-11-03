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
  type PipelineInput,
} from './types'

/** `{{input.repoUrl}}` 的提取器；与 REF_PATTERN 同形，靠 stepId === 'input' 区分 */
const INPUT_REF = /\{\{\s*input\.([A-Za-z0-9_-]+)\s*\}\}/g

/**
 * 从 spec 里出现的所有 `{{input.xxx}}` 推出变量名，并给每个变量找一个「格式样例」。
 *
 * **作者不用声明变量**：写一次引用就算声明过了，少一处能忘的地方。样例取自该变量
 * 第一次出现时的原样文本（`{{input.repoUrl}}` → 模板里是字符串 `{{input.repoUrl}}`），
 * 因为作者看到自己的写法才知道该填成什么形状。
 *
 * 递归遍历整份 raw，所以 `params` / `prompt` / `postCleanup` / `preconditions` 都覆盖到。
 */
export function collectInputNames(raw: unknown): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(INPUT_REF)) if (!out.has(m[1]!)) out.set(m[1]!, m[0])
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x)
    } else if (v && typeof v === 'object') {
      for (const x of Object.values(v)) walk(x)
    }
  }
  walk(raw)
  return out
}

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

type StepBase = Omit<PipelineStep, 'kind' | 'tool' | 'params' | 'prompt'>

function parseToolStep(
  s: Record<string, unknown>,
  i: number,
  id: string,
  base: StepBase,
  knownTools: ReadonlySet<string>,
  errors: string[],
): PipelineStep | undefined {
  const tool = typeof s.tool === 'string' ? s.tool : ''
  if (!tool) errors.push(`steps[${i}] (${id}) 缺少 tool`)
  else if (!knownTools.has(tool)) errors.push(`steps[${i}] (${id}) unknown tool: ${tool}`)
  return {
    ...base,
    tool,
    params: isObj(s.params) ? s.params : undefined,
  }
}

/**
 * agent 节点校验。
 *
 * **未知 agentType 必须拒绝，不能回落**：`orchestrator.spawnAgent` 对未知 id 是
 * 静默回落 `assistant`（善意兜底）。对交互对话没问题；对流水线是灾难——作者以为跑的是
 * 专用 Agent（提示词与工具都不同），实际跑成通用 Agent，结果不可复现且毫无提示。
 * 所以这里与 `knownTools` 同一原则：加载期拒，错误文案直接告诉用户怎么修。
 */
function parseAgentStep(
  s: Record<string, unknown>,
  i: number,
  id: string,
  base: StepBase,
  knownAgents: ReadonlySet<string>,
  errors: string[],
): PipelineStep | undefined {
  if (nonBlank(s.tool)) {
    errors.push(`steps[${i}] (${id}) agent 节点不能同时写 tool（歧义：到底跑工具还是跑回合）`)
  }
  const prompt = typeof s.prompt === 'string' ? s.prompt : ''
  if (!prompt.trim()) errors.push(`steps[${i}] (${id}) agent 节点缺少非空的 prompt`)

  const agentType = typeof s.agentType === 'string' && s.agentType.trim() ? s.agentType.trim() : 'assistant'
  if (!knownAgents.has(agentType)) {
    errors.push(
      `steps[${i}] (${id}) 未知或未启用的 Agent "${agentType}"：请先在 Agents 页启用它` +
        `（可用：${[...knownAgents].join(', ') || '无'}）`,
    )
  }

  const allowedTools = Array.isArray(s.allowedTools)
    ? s.allowedTools.filter((t): t is string => typeof t === 'string' && !!t.trim())
    : undefined

  // 回合上限写错别静默忽略——它决定这一步能不能跑完
  const maxTurnsOk =
    typeof s.maxTurns === 'number' && Number.isInteger(s.maxTurns) && s.maxTurns > 0
  if (s.maxTurns !== undefined && !maxTurnsOk) {
    errors.push(`steps[${i}] (${id}) maxTurns 必须是正整数`)
  }

  return {
    ...base,
    kind: 'agent',
    agentType,
    prompt,
    ...(allowedTools && allowedTools.length ? { allowedTools } : {}),
    ...(typeof s.model === 'string' && s.model.trim() ? { model: s.model.trim() } : {}),
    ...(maxTurnsOk ? { maxTurns: s.maxTurns as number } : {}),
    ...(s.rehearsal === 'run' ? { rehearsal: 'run' as const } : {}),
  }
}

/** 空串与纯空白都算「没写」 */
function nonBlank(v: unknown): boolean {
  return typeof v === 'string' && v.trim() !== ''
}

export function validateSpec(
  raw: unknown,
  knownTools: ReadonlySet<string>,
  knownAgents: ReadonlySet<string>,
): ValidateResult {
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

    const kind = s.kind === undefined ? 'tool' : s.kind
    if (kind !== 'tool' && kind !== 'agent') {
      errors.push(`steps[${i}] (${id}) 未知的 kind: ${String(s.kind)}（只支持 tool / agent）`)
    }

    // 重复 id：记错误后**继续校验这个 step 的其余字段**，再跳过入表。
    // 提前 return 会让「id 重复」这一步的工具名校验被吞掉——那正是「一次报全部错误」要防的挤牙膏。
    const duplicated = seen.has(id)
    if (duplicated) errors.push(`steps[${i}] 的 id "${id}" 重复（id 在同一 spec 内必须唯一）`)
    seen.add(id)

    const base = {
      id,
      label: typeof s.label === 'string' ? s.label : undefined,
      narration: typeof s.narration === 'string' ? s.narration : undefined,
      holdMs: typeof s.holdMs === 'number' ? s.holdMs : DEFAULT_HOLD_MS,
      expect: isObj(s.expect) ? (s.expect as PipelineStep['expect']) : undefined,
    }

    let parsed: PipelineStep | undefined
    if (kind === 'agent') {
      parsed = parseAgentStep(s, i, id, base, knownAgents, errors)
    } else if (kind === 'tool') {
      parsed = parseToolStep(s, i, id, base, knownTools, errors)
    }
    if (duplicated) return
    if (parsed) steps.push(parsed)
  })

  // ── 引用完整性：只能向后 + 无环 ──
  // `input` 是运行时变量，不是步骤：不参与向后校验，否则每个变量引用都会被判成坏引用。
  const isInputRef = (ref: string) => ref === 'input'
  const order = new Map(steps.map((s, i) => [s.id, s]))
  steps.forEach((s, i) => {
    // agent 节点的 prompt 同样能引用上游；两边一起查，否则 prompt 里的坏引用会跑到运行期才炸
    const refs = [...refsIn(s.kind === 'agent' ? s.prompt : s.params)]
    for (const ref of refs) {
      if (isInputRef(ref)) continue
      if (!order.has(ref)) {
        errors.push(`steps[${i}] (${s.id}) 引用了不存在的 step "${ref}"`)
      } else if (steps.findIndex((x) => x.id === ref) >= i) {
        errors.push(`steps[${i}] (${s.id}) 前向引用 "${ref}"（引用只能向后，循环在加载期就拒）`)
      }
    }
  })

  // postCleanup / preconditions 的引用校验放在它们声明之后（见下方 checkRefs）

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

  // postCleanup / preconditions 的引用同样要校验 —— 一个坏引用会在收尾或预条件阶段抛，
  // 那时 run 已经跑过、异常会盖住原本的失败原因（preconditions 抛出去更糟：
  // 整条 run reject，而非干净的 precondition 失败）。
  const checkRefs = (where: string, id: string, params: Record<string, unknown> | undefined) => {
    for (const ref of refsIn(params)) {
      if (isInputRef(ref)) continue
      if (!order.has(ref)) errors.push(`${where} (${id}) 引用了不存在的 step "${ref}"`)
    }
  }
  postCleanup.forEach((c) => checkRefs('postCleanup', c.id, c.params))
  preconditions.forEach((p) => checkRefs('preconditions', p.id, p.params))

  // provenance.target 是双栏对照左栏的唯一来源：写了却是空的，预览会静默少一半，加载期就拒。
  // 允许它引用 `{{input.*}}`（复刻类 spec 的源站地址本来就是每次不同的变量）——
  // 此时不做非空判断，因为值要到 run 时才解析；解析不出来会在运行期显式失败。
  let provenance: PipelineSpec['provenance']
  if (raw.provenance !== undefined) {
    if (!isObj(raw.provenance)) errors.push('provenance 必须是对象')
    else if (!nonBlank(raw.provenance.target)) errors.push('provenance.target 必须是非空字符串')
    else provenance = { target: String(raw.provenance.target).trim() }
  }

  // 同理：preview.htmlPath 决定产物卡能不能打开预览
  let preview: PipelineSpec['preview']
  if (raw.preview !== undefined) {
    if (!isObj(raw.preview)) errors.push('preview 必须是对象')
    else if (!nonBlank(raw.preview.htmlPath)) errors.push('preview.htmlPath 必须是非空字符串')
    else preview = { htmlPath: String(raw.preview.htmlPath).trim() }
  }

  if (errors.length > 0) return { ok: false, errors }

  // ── 运行时变量 ──
  // 名字集合 = 显式声明 ∪ 代码里实际引用到的。两边都算，是因为：
  // 声明了却没用是作者的自述（UI 照实显示），用了却没声明是常态（作者只写引用）。
  const referenced = collectInputNames(raw)
  const declared: PipelineInput[] = []
  if (raw.inputs !== undefined) {
    if (!Array.isArray(raw.inputs)) errors.push('inputs 必须是数组')
    else
      raw.inputs.forEach((v, i) => {
        if (!isObj(v)) return errors.push(`inputs[${i}] 不是对象`)
        if (!nonBlank(v.name)) return errors.push(`inputs[${i}] 缺少非空的 name`)
        declared.push({
          name: String(v.name).trim(),
          ...(nonBlank(v.description) ? { description: String(v.description).trim() } : {}),
        })
      })
  }
  if (errors.length > 0) return { ok: false, errors }
  const inputs: PipelineInput[] = [...declared]
  for (const name of referenced.keys()) {
    if (!declared.some((d) => d.name === name)) inputs.push({ name })
  }

  // 模板：显式声明优先，缺的从引用里的原样文本补。没有变量就不写这个字段。
  let inputTemplate: Record<string, string> | undefined
  if (inputs.length > 0) {
    inputTemplate = {}
    for (const inp of inputs) {
      const explicit = isObj(raw.inputTemplate) ? raw.inputTemplate[inp.name] : undefined
      inputTemplate[inp.name] = typeof explicit === 'string' ? explicit : (referenced.get(inp.name) ?? '')
    }
  }

  const spec: PipelineSpec = {
    id: String(raw.id),
    name: typeof raw.name === 'string' ? raw.name : undefined,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    source: isObj(raw.source) ? (raw.source as PipelineSpec['source']) : undefined,
    ...(inputs.length ? { inputs } : {}),
    ...(inputTemplate ? { inputTemplate } : {}),
    provenance,
    preview,
    record: isObj(raw.record) ? (raw.record as unknown as PipelineSpec['record']) : undefined,
    preconditions: preconditions.length ? preconditions : undefined,
    steps,
    postCleanup: postCleanup.length ? postCleanup : undefined,
  }
  return { ok: true, spec, specHash: hashSpec(spec) }
}
