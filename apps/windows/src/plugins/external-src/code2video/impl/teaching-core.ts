/**
 * 教学视频生成的**纯逻辑层**：提示词、规格校验、分镜解析、布局重叠检测。
 *
 * 与 Code2Video（showlab/Code2Video, NeurIPS 2025 DL4C）的三段式对齐：
 *   大纲 outline → 分镜 storyboard → 逐节代码/画面
 * 但渲染后端不用 Manim，而是自包含 HTML（零 Python 依赖，见 `render-backend.ts`）。
 *
 * 这个文件**不碰文件系统、不调模型、不碰 Electron**，所以能被单测完整覆盖——
 * 这里出错的代价是「生成了一段没法渲染的东西」，而不是「抛了个异常」。
 */

// ---------------------------------------------------------------
// 1. 教学规格（大纲 / 分镜）
// ---------------------------------------------------------------

export interface OutlineSection {
  id: string
  title: string
  /** 这一节讲什么（一句话，给后续分镜用） */
  content: string
}

export interface TeachingOutline {
  topic: string
  targetAudience: string
  sections: OutlineSection[]
}

export interface StoryboardSection {
  id: string
  title: string
  /** 左侧讲义要点，每行 ≤ 10 词（原版约束） */
  lectureLines: string[]
  /** 右侧动画步骤，与 lectureLines 一一对应 */
  animations: string[]
  /**
   * 这一节的**结构化画面**（模型只出 JSON，HTML 由 `buildSceneHtml` 拼）。
   * 缺省时渲染器退回纯文字模板。
   */
  scene?: SceneStep[]
  /**
   * 这一节的目标时长（秒）。由服务按用户给的期望总时长均分算出；
   * 缺省时渲染器按「每步 3 秒、至少 6 秒」自算。
   */
  targetSeconds?: number
}

export interface TeachingStoryboard {
  sections: StoryboardSection[]
}

/** 规模闸门：防止模型输出撑爆渲染与耗时 */
export const LIMITS = {
  maxSections: 8,
  maxLectureLines: 6,
  maxAnimations: 8,
  /** 单行讲义字数上限（原版是 10 words，中文按 24 字放宽） */
  maxLectureLineChars: 24,
  /**
   * 单步元素数上限。**超出的必须报错，不许静默丢弃**。
   *
   * 实测 9 个产物、55 步里模型给了 187 个元素，其中 33 个（18%）被旧的
   * `slice(0, 3)` 悄悄切掉——用户看到的是「这一步少了一个标签」，而日志里
   * 什么都没有。位置约束是本地能解的（`declutterSteps`），**要素数量不是**：
   * 少一个元素就是画面缺一块，只能让模型重新给。
   */
  maxElementsPerStep: 3,
} as const

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asStringArray(v: unknown, limit: number): string[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, limit)
}

/**
 * 归档大纲：模型给的 JSON 经常少字段/多层级，这里收窄成已知形状。
 * 收不出可用内容就返回 null（调用方应重试或降级），**不补默认值**——
 * 凭空补出来的大纲会让后面每一步都建在假数据上。
 */
export function parseOutline(raw: unknown): TeachingOutline | null {
  if (!isRecord(raw)) return null
  const sectionsRaw = raw.sections
  if (!Array.isArray(sectionsRaw) || sectionsRaw.length === 0) return null

  const sections: OutlineSection[] = []
  for (const item of sectionsRaw.slice(0, LIMITS.maxSections)) {
    if (!isRecord(item)) continue
    const title = typeof item.title === 'string' ? item.title.trim() : ''
    if (!title) continue
    const content =
      typeof item.content === 'string' && item.content.trim()
        ? item.content.trim()
        : typeof item.example === 'string'
          ? item.example.trim()
          : title
    sections.push({ id: `section_${sections.length + 1}`, title, content })
  }
  if (sections.length === 0) return null

  const topic =
    typeof raw.topic === 'string' && raw.topic.trim() ? raw.topic.trim() : sections[0]!.title
  const targetAudience =
    typeof raw.targetAudience === 'string' && raw.targetAudience.trim()
      ? raw.targetAudience.trim()
      : 'general audience'
  return { topic, targetAudience, sections }
}

/** 归档分镜；要求每节至少有 1 行讲义 + 1 步动画 */
export function parseStoryboard(raw: unknown): TeachingStoryboard | null {
  if (!isRecord(raw)) return null
  const sectionsRaw = raw.sections
  if (!Array.isArray(sectionsRaw) || sectionsRaw.length === 0) return null

  const sections: StoryboardSection[] = []
  for (const item of sectionsRaw.slice(0, LIMITS.maxSections)) {
    if (!isRecord(item)) continue
    const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : ''
    if (!title) continue
    const lectureLines = asStringArray(item.lecture_lines ?? item.lectureLines, LIMITS.maxLectureLines)
    const animations = asStringArray(item.animations, LIMITS.maxAnimations)
    // 动画数与讲义数对齐：多出来的丢掉（原版就是"每行讲义配一步动画"），
    // 少了就按最后一条补齐——不对称会让渲染时某一侧空着
    if (lectureLines.length === 0) continue
    const aligned: string[] = []
    for (let i = 0; i < lectureLines.length; i++) {
      aligned.push(animations[i] ?? animations[animations.length - 1] ?? lectureLines[i]!)
    }
    sections.push({ id: `section_${sections.length + 1}`, title, lectureLines, animations: aligned })
  }
  if (sections.length === 0) return null
  return { sections }
}

/**
 * 超长讲义行截断。
 *
 * 不截断的后果不是"字小一点"，而是**溢出到右侧动画区并与元素重叠**——
 * 那正是 Code2Video 用 6×6 网格想解决的问题。这里在数据层先收一道。
 */
export function clampLectureLine(line: string, maxChars: number = LIMITS.maxLectureLineChars): string {
  const t = line.trim()
  if (t.length <= maxChars) return t
  return t.slice(0, Math.max(1, maxChars - 1)) + '…'
}

// ---------------------------------------------------------------
// 2. 提示词（移植自 Code2Video prompts/stage1-3.py，改中文与 HTML 口径）
// ---------------------------------------------------------------

export function buildOutlinePrompt(
  topic: string,
  durationMinutes = 3,
  audience?: string,
  /** 结构模板的骨架；有它时按骨架生成，没有才自由发挥 */
  template?: { name: string; sections: Array<{ titleHint: string; lectureHints: string[]; sceneHint: string }> },
): string {
  // 受众必须进提示词：只在大纲生成后覆盖 targetAudience 字段，等于「标签写对了、
  // 内容仍按模型自己猜的受众写」（实测：要求初中生，模型按高中学生写了整份大纲）。
  const audienceLine = audience?.trim()
    ? `目标受众：${audience.trim()}（按这个水平组织内容：已掌握什么、哪些概念需要先补）`
    : '目标受众：由你判断，并在输出里说明理由'

  // 有模板时给骨架：模型不用重新发明分节，只填内容。这一条同时降低 token 与
  // 「同主题两次跑出完全不同结构」的不确定性。
  const skeleton = template
    ? `## 结构模板：${template.name}

按下面的骨架分节（**节数固定**，顺序固定；把 {…} 占位符换成这个主题的实内容）：

${template.sections
  .map(
    (s, i) =>
      `${i + 1}. ${s.titleHint}\n` +
      s.lectureHints.map((l) => `   - 讲义：${l}`).join('\n') +
      `\n   - 画面对应：${s.sceneHint}`,
  )
  .join('\n\n')}

每节的 content 字段写清「这一节把哪个问题讲明白了」，不要照抄上面的骨架文字。`
    : ''

  return `你是一位优秀的教学设计专家。请为下面这个知识点设计一份循序渐进、有例子的教学大纲。

知识点：${topic}
${audienceLine}
${skeleton}
必须输出 JSON（不要任何解释文字，不要 markdown 代码块外的内容）：
{
  "topic": "主题名",
  "targetAudience": "目标受众（与上面给定的受众一致）",
  "sections": [
    { "id": "section_1", "title": "小节标题", "content": "这一节讲什么，一句话" }
  ]
}

要求：
1. 总时长约 ${durationMinutes} 分钟${template ? `，按上面骨架拆成 ${template.sections.length} 节` : '，拆成 3~6 个小节'}。
2. 小节之间要有递进关系，先讲需要的前置知识。
3. 优先选择**适合视觉化**的表达方式（图、对比、逐步构建）。
4. 每节聚焦一个概念，不要在一节里塞多个主题。`
}

export function buildStoryboardPrompt(outline: TeachingOutline): string {
  return `你是专业的教学分镜师。请把下面这份教学大纲转写成可逐帧渲染的分镜脚本。

大纲：
${JSON.stringify(outline, null, 2)}

必须输出 JSON：
{
  "sections": [
    {
      "id": "section_1",
      "title": "小节标题",
      "lecture_lines": ["左侧讲义第 1 行", "第 2 行"],
      "animations": ["右侧画面第 1 步做什么", "第 2 步做什么"]
    }
  ]
}

要求：
1. **lecture_lines 与 animations 数量必须相等且一一对应**——每一行讲义配一步动画。
2. 每个小节 3~5 行讲义；重点小节可用 5 行。
3. 每行讲义不超过 ${LIMITS.maxLectureLineChars} 个字，必须是短语，不要整句。
4. 动画描述要具体到"什么元素、怎么出现/移动/变色"，因为后面会被直接翻译成画面。
   例："两条平行线从左侧平移进场，颜色由白变蓝"。
5. 不要出现 3D、外部图片、视频嵌入——只允许文字、形状、线条、坐标、公式。`
}

/**
 * 每步画面的**结构化描述**（模型只输出这个，由我们把 JSON 渲染成 HTML）。
 *
 * 为什么不让模型直接吐 HTML：实测 10 次单轮调用里，只要输出目标是「一整页
 * 100~200 行 HTML」，全部在 80~120 秒后返回**空字符串**；而同一批次里只出
 * JSON 的大纲/分镜调用 4~19 秒正常返回。也就是说瓶颈在**长文本单次输出**，
 * 不是内容难度。把画面拆成 JSON（每步 3~5 个元素），输出量降一个数量级，
 * 再用本地模板拼装 HTML——画面同样有形状、位置、颜色，且完全可复现。
 */
export interface SceneElement {
  /**
   * 这一步在右区展示什么。
   *
   * 前 5 种是首版就有的（保留以便旧 `storyboard.json` 仍能渲染）；后 8 种是
   * 「模型想画但表达不出来」的补丁——实测 187 个元素里有 6 个 `rect` 被当作
   * 数轴（`w:80 h:8`，渲染成空心长框）、另有多处拿 `text` 写 `→` 当箭头。
   *
   * | kind | 参数 | 替代的错误用法 |
   * |---|---|---|
   * | `tex` | `tex` | 用 `formula` 塞纯文本公式，没有真正的上下标与分式 |
   * | `axis` | `axis` | 用极扁 `rect` 冒充数轴 |
   * | `arrow` | `from`/`to` | 用 `text: "→"` 冒充箭头 |
   * | `table` | `table` | 用多个 text 拼表格，列对不齐 |
   * | `brace` | `from`/`to` | 用多条 line 拼花括号 |
   * | `curve` | `curve` | 用一串 circle 连成曲线 |
   * | `code` | `code` | 用 text 逐行写字，没有高亮 |
   * | `highlight` | `target` | 无法表达「强调上一个元素」 |
   */
  kind:
    | 'text'
    | 'rect'
    | 'circle'
    | 'line'
    | 'formula'
    | 'tex'
    | 'axis'
    | 'arrow'
    | 'table'
    | 'brace'
    | 'curve'
    | 'code'
    | 'highlight'
  /** 显示内容（text/formula/code 用），≤ 40 字 */
  content?: string
  /** LaTeX 源码（tex 用），如 `(-3)\\times(-2)=6` */
  tex?: string
  /** 数轴参数（axis 用） */
  axis?: AxisSpec
  /** 表格参数（table 用） */
  table?: TableSpec
  /** 曲线参数（curve 用） */
  curve?: CurveSpec
  /** 代码参数（code 用） */
  code?: CodeSpec
  /** 颜色的十六进制值，如 #93c5fd */
  color?: string
  /** 在右区的相对位置，0~100 的百分比 */
  x?: number
  y?: number
  /** 尺寸（相对右区宽高的百分比）；line 用 w 当长度，角度固定水平 */
  w?: number
  h?: number
  /** 箭头的起点（arrow 用，百分比坐标）；终点用 x/y */
  from?: Point
  /** 括号的覆盖范围（brace 从 from 到 x/y 所在行） */
  to?: Point
}

/** 百分比坐标点 */
export interface Point {
  x: number
  y: number
}

/**
 * 数轴：一条水平轴 + 若干刻度 + 可选标注。
 *
 * 这是 `rect` 冒充数轴的正式替代。`from`/`to` 是**数值范围**（不是百分比），
 * 渲染时按 `x`/`w` 给出的像素区域把数值映射到屏幕。
 */
export interface AxisSpec {
  /** 数值范围下限 */
  from: number
  /** 数值范围上限 */
  to: number
  /** 要标出来的刻度值 */
  marks?: number[]
  /** 原点（0）是否画出来；默认 marks 里含 0 就是 true */
  showZero?: boolean
}

export interface TableSpec {
  headers: string[]
  rows: string[][]
  /** 高亮某一行（0 起）。用于「这一步又多了一行」 */
  highlightRow?: number
}

export interface CurveSpec {
  /**
   * 采样点。模型只给少量控制点，渲染时按线性插值连线——不给公式，
   * 因为模型算不对 `sin` 的中段，而错曲线比没有曲线更糟。
   */
  points: Point[]
  /** 是否闭合（画多边形/填充） */
  closed?: boolean
}

export interface CodeSpec {
  /** 语言标签（仅显示，不做语法高亮——高亮靠 hl 行号） */
  language?: string
  /** 高亮哪几行（0 起） */
  hl?: number[]
}

export interface SceneStep {
  /** 与 lectureLines 下标对应的步骤 */
  elements: SceneElement[]
}

/**
 * 画面规格的解析结果。
 *
 * `issues` 非空 = 模型给的画面**能用但有毛病**。调用方要按它决定重试还是照渲染：
 * 元素超量必须重试（少一个元素就是画面缺一块），其余问题降级放行并如实回告。
 */
export interface SceneSpecResult {
  steps: SceneStep[]
  issues: SceneIssue[]
}

export interface SceneIssue {
  /** 出问题的是第几步（0 起） */
  step: number
  kind: 'too_many_elements' | 'dropped_element' | 'short_steps'
  detail: string
}

function num(v: unknown, def: number, lo = 0, hi = 100): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def
}

/** 任意有限数（用于数轴范围这类不受 0~100 约束的量） */
function anyNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function asPoint(v: unknown): Point | null {
  if (!isRecord(v)) return null
  const x = anyNum(v.x)
  const y = anyNum(v.y)
  return x === null || y === null ? null : { x, y }
}

function strArray(v: unknown, limit: number, maxChars = 24): string[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.slice(0, maxChars))
    .slice(0, limit)
}

function parseAxis(v: unknown): AxisSpec | null {
  if (!isRecord(v)) return null
  const from = anyNum(v.from)
  const to = anyNum(v.to)
  if (from === null || to === null || from === to) return null
  const marks = Array.isArray(v.marks)
    ? v.marks.filter((m): m is number => typeof m === 'number' && Number.isFinite(m)).slice(0, 12)
    : []
  return { from, to, marks, ...(typeof v.showZero === 'boolean' ? { showZero: v.showZero } : {}) }
}

function parseTable(v: unknown): TableSpec | null {
  if (!isRecord(v)) return null
  const headers = strArray(v.headers, 6, 16)
  if (headers.length === 0) return null
  const rowsRaw = Array.isArray(v.rows) ? v.rows : []
  const rows = rowsRaw
    .slice(0, 10)
    .map((r) => strArray(r, 6, 16))
    .filter((r) => r.length > 0)
  if (rows.length === 0) return null
  const hl = anyNum(v.highlightRow)
  return {
    headers,
    rows,
    ...(hl !== null && hl >= 0 && hl < rows.length ? { highlightRow: Math.floor(hl) } : {}),
  }
}

function parseCurve(v: unknown): CurveSpec | null {
  if (!isRecord(v)) return null
  const ptsRaw = Array.isArray(v.points) ? v.points : []
  const points = ptsRaw
    .slice(0, 60)
    .map(asPoint)
    .filter((p): p is Point => p !== null)
  if (points.length < 2) return null
  return { points, ...(v.closed === true ? { closed: true } : {}) }
}

function parseCode(v: unknown): CodeSpec | null {
  if (!isRecord(v)) return null
  const language = typeof v.language === 'string' ? v.language.slice(0, 16) : undefined
  const hl = Array.isArray(v.hl)
    ? v.hl.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0).map(Math.floor)
    : []
  return { ...(language ? { language } : {}), ...(hl.length ? { hl } : {}) }
}

/**
 * 收窄模型给的画面 JSON。
 *
 * 返回 null 表示**根本不能用**（不是对象、steps 为空、一步都收不出来）——
 * 调用方应重试。`issues` 非空表示能用但有毛病，判据见 `SceneSpecResult`。
 */
export function parseSceneSpec(raw: unknown, stepCount: number): SceneSpecResult | null {
  if (!isRecord(raw)) return null
  const stepsRaw = raw.steps
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) return null

  const steps: SceneStep[] = []
  const issues: SceneIssue[] = []
  for (let i = 0; i < Math.min(stepsRaw.length, stepCount); i++) {
    const item = stepsRaw[i]
    if (!isRecord(item)) continue
    const els = Array.isArray(item.elements) ? item.elements : []
    // 超量**报出来**再截断：截断本身不可避免（画面放不下），但静默截断会
    // 让「这一步少了个标签」变成无从追查的谜（实测 18% 的元素是这么没的）。
    if (els.length > LIMITS.maxElementsPerStep) {
      issues.push({
        step: i,
        kind: 'too_many_elements',
        detail: `第 ${i + 1} 步给了 ${els.length} 个元素，上限 ${LIMITS.maxElementsPerStep}，将保留前 ${LIMITS.maxElementsPerStep} 个`,
      })
    }
    const elements: SceneElement[] = []
    for (const e of els.slice(0, LIMITS.maxElementsPerStep)) {
      const el = parseSceneElement(e)
      if (el) elements.push(el)
    }
    // 元素被丢（未知 kind、缺必需参数）同样要报：模型以为自己画了，实际没有
    const dropped = Math.min(els.length, LIMITS.maxElementsPerStep) - elements.length
    if (dropped > 0 && els.length <= LIMITS.maxElementsPerStep) {
      issues.push({
        step: i,
        kind: 'dropped_element',
        detail: `第 ${i + 1} 步有 ${dropped} 个元素不合格被丢弃（未知 kind 或缺必需参数）`,
      })
    }
    if (elements.length === 0) continue
    steps.push({ elements })
  }
  if (steps.length === 0) return null
  // 步数不足会让后半段讲义没有画面，但渲染能跑——降级放行并回告
  if (steps.length < stepCount) {
    issues.push({
      step: steps.length,
      kind: 'short_steps',
      detail: `只有 ${steps.length} 步画面，讲义有 ${stepCount} 行；多出的讲义行会没有对应画面`,
    })
  }
  return { steps, issues }
}

/** 合法 kind 集合；新增 kind 必须同时在这里和 `SceneElement['kind']` 里加 */
const ELEMENT_KINDS = new Set<SceneElement['kind']>([
  'text',
  'rect',
  'circle',
  'line',
  'formula',
  'tex',
  'axis',
  'arrow',
  'table',
  'brace',
  'curve',
  'code',
  'highlight',
])

/** 收窄单个元素；不合格返回 null（由调用方计入 `dropped_element`） */
function parseSceneElement(e: unknown): SceneElement | null {
  if (!isRecord(e)) return null
  const kind = typeof e.kind === 'string' && ELEMENT_KINDS.has(e.kind as SceneElement['kind'])
    ? (e.kind as SceneElement['kind'])
    : null
  if (!kind) return null

  const content = typeof e.content === 'string' ? e.content.slice(0, 40) : undefined
  const tex = typeof e.tex === 'string' ? e.tex.slice(0, 200) : undefined
  const color = typeof e.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(e.color) ? e.color : undefined

  const base = {
    kind,
    ...(content ? { content } : {}),
    ...(color ? { color } : {}),
    x: num(e.x, 30),
    y: num(e.y, 40),
    w: num(e.w, 24, 1, 100),
    h: num(e.h, 14, 1, 100),
  }

  // 每种 kind 的必需参数：缺了就等于「模型想画但没给形状」，必须判不合格
  switch (kind) {
    case 'text':
    case 'formula':
      return content ? base : null
    case 'tex':
      return tex ? { ...base, tex } : null
    case 'axis': {
      const axis = parseAxis(e.axis)
      return axis ? { ...base, axis } : null
    }
    case 'table': {
      const table = parseTable(e.table)
      return table ? { ...base, table } : null
    }
    case 'curve': {
      const curve = parseCurve(e.curve)
      return curve ? { ...base, curve } : null
    }
    case 'code': {
      const code = parseCode(e.code)
      return content ? { ...base, ...(code ? { code } : {}) } : null
    }
    case 'arrow': {
      const from = asPoint(e.from)
      // 箭头必须有起点；终点沿用 x/y（已在 base 里收窄）
      return from ? { ...base, from } : null
    }
    case 'brace': {
      const from = asPoint(e.from)
      const to = asPoint(e.to)
      return from && to ? { ...base, from, to } : null
    }
    case 'highlight':
      // 强调一个色块，位置由 x/y/w/h 决定，不需要额外参数
      return base
    default:
      return base
  }
}

/**
 * 生成**人审用的审阅稿**（`review.md`）。
 *
 * 对应 Code2Video 草稿阶段的「只看两样东西」：分镜逻辑是否合理（推导有没有跳步）、
 * 结构是否清晰。所以这里刻意只放这两个维度，**不夹带渲染细节**——
 * 审阅者要在 30 秒内判断「要不要往下走」，多一个字都是噪音。
 */
export function buildReviewMarkdown(
  outline: TeachingOutline,
  storyboard: TeachingStoryboard,
): string {
  const totalSec = storyboard.sections.reduce(
    (n, s) => n + (s.targetSeconds ?? Math.max(6, s.animations.length * 3)),
    0,
  )
  const lines: string[] = [
    `# 审阅稿：${outline.topic}`,
    '',
    `> 受众：${outline.targetAudience} · ${storyboard.sections.length} 节 · 约 ${Math.round(totalSec / 60 * 10) / 10} 分钟`,
    '',
    '## 这一份是什么',
    '',
    '这是**草稿**：只跑到分镜为止，没有渲染画面。请先确认下面两件事，再决定要不要出片：',
    '',
    '1. **推导有没有跳步** —— 每节之间是否承接得上，有没有默认观众已经知道的东西。',
    '2. **分节是否合理** —— 有没有一节塞了多个概念，或者某节其实可以删。',
    '',
    '要出片：把这份稿子的目录传给 `teaching_video_generate` 的 `fromDir`（配 `stage: "produce"`），',
    '已生成的大纲与分镜会被复用，不会重复花 token。',
    '',
    '## 分镜',
    '',
  ]
  storyboard.sections.forEach((s, i) => {
    lines.push(`### ${i + 1}. ${s.title}`, '')
    s.lectureLines.forEach((line, j) => {
      lines.push(`- **${line}**`)
      const anim = s.animations[j]
      if (anim) lines.push(`  - 画面：${anim}`)
    })
    lines.push('')
  })
  const outlineMatch = outline.sections.length === storyboard.sections.length
  lines.push('## 自检', '')
  lines.push(`- 大纲 ${outline.sections.length} 节 / 分镜 ${storyboard.sections.length} 节：${outlineMatch ? '一致' : '**不一致，请检查**'}`)
  lines.push('- 讲义行与画面步骤：已逐条对齐（渲染时按步同步高亮）')
  return lines.join('\n')
}

/**
 * 把重叠的元素**自动挪开**。
 *
 * 实测模型不遵守「元素之间留间距」的约束：同一个位置会同时放「直角边 b」和
 * 「4→b」，渲染出来是两行字压在一起。这里不复用「让模型重试」这条路——
 * 位置是几何问题，本地就能解：逐个检查，撞了就往下挪一档，挪到不撞为止。
 *
 * 这是**确定性 Critic 的执行侧**：检测（`findOverlaps`）与修正（本函数）
 * 分开，前者用于如实回告，后者用于止损。
 */
export function declutterSteps(steps: SceneStep[], minGapPct = 3): SceneStep[] {
  const MIN_H = 8
  const MAX_Y = 92
  const MAX_X = 96
  /** 候选列：先试原位置，再按固定步长左右铺开，避免元素全挤在一条竖线上 */
  const COLUMNS = [0, -26, 26, -52, 52, 4]
  return steps.map((step) => {
    const placed: SceneElement[] = []
    for (const el of step.elements) {
      const cur: SceneElement = { ...el, h: Math.max(MIN_H, el.h ?? 14) }
      // 右边界按**元素自身宽度**算：只看 x <= MAX_X 会让宽元素伸到画面外
      const maxX = Math.max(4, 100 - (cur.w ?? 24))
      // 坐标先钳回画面内（模型偶尔给 x=120 这种越界值，直接渲染会被裁掉）
      cur.x = Math.min(maxX, Math.max(4, cur.x ?? 30))
      cur.y = Math.min(MAX_Y, Math.max(4, cur.y ?? 40))

      const free = (probe: SceneElement) =>
        !placed.some((p) => boxesOverlap(p, probe, minGapPct))

      // 原位置能放下就不动——模型给的坐标多数是对的，别为了整齐去改它
      if (free(cur)) {
        placed.push(cur)
        continue
      }

      // 否则按「原行 → 下一行 → …」逐行扫，每行试几列。分行扫描而不是像旧实现
      // 那样挪到底再换列：换列后从顶行重来会撞上刚放下的那批，扫不完就放弃，
      // 结果就是实测看到的公式叠在一起。
      const startX = cur.x ?? 30
      const startY = cur.y ?? 40
      let settled = false
      for (let y = startY; y <= MAX_Y && !settled; y += MIN_H + minGapPct) {
        for (const dx of COLUMNS) {
          const x = Math.min(maxX, Math.max(4, startX + dx))
          const probe = { ...cur, x, y }
          if (free(probe)) {
            cur.x = x
            cur.y = y
            settled = true
            break
          }
        }
      }
      // 实在放不下（元素太多）才接受重叠：少一个元素比整块画面崩掉更糟。
      // 但**坐标仍要钳回画面内**——越界元素在视频里就是直接被裁掉，
      // 比重叠更糟（用户看到半个公式）。
      if (!settled) {
        cur.x = Math.min(maxX, Math.max(4, cur.x ?? 30))
        cur.y = Math.min(MAX_Y, Math.max(4, cur.y ?? 40))
      }
      placed.push(cur)
    }
    return { elements: placed }
  })
}

function boxesOverlap(a: SceneElement, b: SceneElement, gap: number): boolean {
  const ax = a.x ?? 30
  const ay = a.y ?? 40
  const aw = a.w ?? 24
  const ah = a.h ?? 14
  const bx = b.x ?? 30
  const by = b.y ?? 40
  const bw = b.w ?? 24
  const bh = b.h ?? 14
  return ax < bx + bw + gap && bx < ax + aw + gap && ay < by + bh + gap && by < ay + ah + gap
}

/**
 * 检查一节**真实元素**的布局问题。
 *
 * 这是确定性 Critic 的正身。此前 `render-backend.checkSectionLayout` 算的是
 * `gridCell()` 的 3×3 文字模板面板——那个模板只在 `section.scene` 为空时才用，
 * 默认的 LLM 画面模式下**根本不存在这些面板**，于是「布局告警」一直在检查
 * 一堆不存在的框。这里改成对 `step.elements` 的真实包围盒计算。
 *
 * 判据只认几何，不认美观：
 * - `overlap`：两步之间元素互相压住（`declutterSteps` 之后仍残留）
 * - `out_of_bounds`：元素伸出画面（会被裁掉，用户看到半截）
 * - `suspicious_span`：`w/h` 极扁/极长的矩形，是「拿 rect 当数轴/分隔线」的
 *   典型误用（实测第 2 节把 `w:80 h:8` 的 rect 当数轴，渲染成空心长条）
 */
export type LayoutIssueKind = 'overlap' | 'out_of_bounds' | 'suspicious_span'

export interface LayoutIssue {
  step: number
  kind: LayoutIssueKind
  detail: string
  /** 涉及的元素下标（overlap 时为两个） */
  indexes: number[]
}

/** `w/h` 超过这个倍数就当作「一条线」而不是一个形状 */
const SUSPICIOUS_SPAN_RATIO = 8

export function checkSceneLayout(steps: readonly SceneStep[], overlapThreshold = 0.35): LayoutIssue[] {
  const issues: LayoutIssue[] = []
  steps.forEach((step, si) => {
    const els = step.elements
    for (let i = 0; i < els.length; i++) {
      const a = els[i]!
      const ax = a.x ?? 30
      const ay = a.y ?? 40
      const aw = a.w ?? 24
      const ah = a.h ?? 14

      // 出界：右/下越界会被渲染裁掉，左上越界在 CSS 里是负坐标（同样看不见）
      if (ax + aw > 100.5 || ay + ah > 100.5) {
        issues.push({
          step: si,
          kind: 'out_of_bounds',
          detail: `第 ${si + 1} 步第 ${i + 1} 个元素伸展到 (${Math.round(ax + aw)}, ${Math.round(ay + ah)})，超出画面`,
          indexes: [i],
        })
      }

      // 极扁/极长的 rect：模型想画线却用了 rect，渲染出来是空心长框
      if (a.kind === 'rect') {
        const ratio = Math.max(aw / Math.max(ah, 0.01), ah / Math.max(aw, 0.01))
        if (ratio >= SUSPICIOUS_SPAN_RATIO) {
          issues.push({
            step: si,
            kind: 'suspicious_span',
            detail: `第 ${si + 1} 步第 ${i + 1} 个 rect 的宽高比 ${ratio.toFixed(0)}:1，像是想画一条线`,
            indexes: [i],
          })
        }
      }

      for (let j = i + 1; j < els.length; j++) {
        const b = els[j]!
        const ratio = overlapRatio(
          { x: ax, y: ay, w: aw, h: ah },
          { x: b.x ?? 30, y: b.y ?? 40, w: b.w ?? 24, h: b.h ?? 14 },
        )
        if (ratio >= overlapThreshold) {
          issues.push({
            step: si,
            kind: 'overlap',
            detail: `第 ${si + 1} 步第 ${i + 1} 与第 ${j + 1} 个元素重叠 ${Math.round(ratio * 100)}%`,
            indexes: [i, j],
          })
        }
      }
    }
  })
  return issues
}

/**
 * 让模型输出画面 JSON 的提示词（输出量约 200 token/节，远低于整页 HTML）。
 *
 * `example` 是结构模板自带的**一节真实成品**。它是 few-shot：比十条规则更能
 * 让模型学会「这个模板的画面应该长什么样」。只在第一节传，避免每节都背一遍。
 */
export function buildSceneSpecPrompt(
  section: StoryboardSection,
  example?: { title: string; lectureLines: string[]; scene: SceneStep[] },
): string {
  const exampleBlock = example
    ? `\n## 样例（同模板的一节真实成品，照着这个密度和元素选择来）

小节：${example.title}
讲义行：${JSON.stringify(example.lectureLines)}
画面 JSON：
${JSON.stringify({ steps: example.scene })}
`
    : ''
  return `你在为一段教学动画设计每一帧的画面布局。只输出 JSON，不要解释。

小节：${section.title}
讲义行：${JSON.stringify(section.lectureLines)}
动画步骤：${JSON.stringify(section.animations)}
${exampleBlock}
右侧动画区是一个坐标系：x/y 是元素**左上角**在右区里的百分比（0~100），w/h 是宽高百分比。
每个动画步骤一组元素，元素逐个按出现顺序摆放，**不要互相重叠**。

## 能用哪些元素

| kind | 参数 | 用来画什么 |
|---|---|---|
| text | content | 普通文字标签（≤20 字） |
| rect / circle | color | 一个方框 / 一个圆（**宽高比别超过 5:1**） |
| line | color | 一条水平线段 |
| formula | content | 纯文本公式（没有真正的上下标，只能写 x² 这种） |
| **tex** | tex | **真正的数学公式**，LaTeX 语法：\`(-3)\\times(-2)=6\`、\`\\frac{1}{2}\`、\`x^2+y^2\` |
| **axis** | axis: {from,to,marks} | **数轴**：from/to 是数值范围，marks 是要标出的刻度值 |
| **arrow** | from:{x,y} + 自身 x/y | **箭头**：从 from 指向自己的 x/y |
| **table** | table: {headers,rows,highlightRow} | **表格**，可高亮一行 |
| **curve** | curve: {points:[{x,y}...]} | **折线/曲线**：给 2~10 个采样点，本地连线 |
| **brace** | from + to | **花括号**：把纵向一段括起来 |
| **code** | content + code:{hl:[行号]} | 代码块，可高亮几行 |
| **highlight** | 只给 x/y/w/h | 高亮一个区域（半透明色块） |

## 选元素的判断

- 要画数轴、时间轴、任何带刻度的轴 → 用 **axis**，不要用很扁的 rect（那会变成空心长框）
- 要表示方向、因果、推导的下一步 → 用 **arrow**，不要用 text 写「→」
- 公式有分式、上下标、希腊字母 → 用 **tex**；只是简单一行「a²+b²=c²」用 formula 也行
- 要列几行数据做对比 → 用 **table**，不要用多个 text 硬拼
- 函数图像、趋势线 → 用 **curve**，给采样点

## 输出格式

{"steps":[{"elements":[
  {"kind":"rect","color":"#3b82f6","x":20,"y":25,"w":18,"h":18},
  {"kind":"tex","tex":"a^2+b^2=c^2","x":30,"y":60,"w":40,"h":12}
]}]}

## 约束

1. steps 数量必须等于 ${Math.min(section.lectureLines.length, section.animations.length)}。
2. 每步 1~${LIMITS.maxElementsPerStep} 个元素（**超过会被打回重做**）。
3. 元素之间留出间距（同一行相邻元素 x 至少差 w+5），且都要完整落在 0~100 范围内。
4. 颜色用浅色（#93c5fd / #fca5a5 / #86efac / #fde68a 之类），背景是黑色。
5. **rect 必须同时有宽和高**（w/h 比值别超过 5:1）。要画线就用 line，要画轴就用 axis。`
}

/**
 * 流式接收时判断「看起来已经是一份完整 HTML」。
 *
 * 场景调用实测会 80~120 秒后返回空——不是模型不会写，而是长输出被上游流截断
 *（同批次 outline/storyboard 都正常，只有 HTML 这一类复现）。这里的兜底是：
 * 即便流末尾丢了，只要已经收到闭合的 `</html>` 或 `</body>`，就当作完整页面用。
 */
export function looksLikeCompleteHtml(text: string): boolean {
  const t = text.trim()
  if (t.length < 200) return false
  if (!/<\/html\s*>/i.test(t) && !/<\/body\s*>/i.test(t)) return false
  return /<html\b/i.test(t)
}

// ---------------------------------------------------------------
// 3. 确定性 Critic：布局重叠检测
// ---------------------------------------------------------------

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** 两框相交面积占较小者面积的比例（0~1）；任一框面积为 0 视为不相交 */
export function overlapRatio(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const inter = ix * iy
  if (inter <= 0) return 0
  const minArea = Math.min(a.w * a.h, b.w * b.h)
  if (minArea <= 0) return 0
  return inter / minArea
}

/**
 * 找出重叠超过阈值的元素对。
 *
 * 为什么用确定性判据而不是 VLM：原版用 Gemini 看渲染帧给美学建议，每轮一次多模态
 * 往返；而它想解决的首要问题是**元素互相遮挡**，这个问题几何上就能判死。
 * 确定性的好处是零成本、可复现、失败原因能直接回灌给模型改。
 */
export function findOverlaps(
  boxes: readonly { id: string; box: Box }[],
  threshold = 0.35,
): Array<{ a: string; b: string; ratio: number }> {
  const out: Array<{ a: string; b: string; ratio: number }> = []
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const ratio = overlapRatio(boxes[i]!.box, boxes[j]!.box)
      if (ratio >= threshold) {
        out.push({ a: boxes[i]!.id, b: boxes[j]!.id, ratio: Math.round(ratio * 100) / 100 })
      }
    }
  }
  return out.sort((x, y) => y.ratio - x.ratio)
}
