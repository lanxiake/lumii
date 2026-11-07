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
   * 这一节每步要**讲出来**的话（旁白/字幕）。
   *
   * 与 `lectureLines` 分开：那是左侧的**要点标签**（短语，给眼睛看），
   * 这是**口播**（完整句子，给耳朵听）。拿要点当旁白会念成
   * 「负数 就是 取相反数」，而且会和左侧重复显示（实测底部出现两行同样的字）。
   */
  narrationLines?: string[]
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
  /**
   * 每一步各自的时长（秒），下标即步号。
   *
   * 有配音时由**真实语音时长**决定（见 `stepDurationsFromCues`），
   * 没有时才退回「均分」。这是「动画跟着声音走」与「声音跟着动画走」的分界。
   */
  stepSeconds?: number[]
}

export interface TeachingStoryboard {
  sections: StoryboardSection[]
}

/**
 * 画面底部留给字幕的高度（占画面高度的百分比）。
 *
 * 有配音时字幕烧在那里。模型不知道这件事，会把元素画到底部，
 * 于是出现「元素文字 + 同位置字幕」两行重复（实测）。
 *
 * 14% ≈ 100px / 720px，正好容纳一行 34px 的字幕加边距。
 */
export const SUB_BAND_PCT = 14

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
    const narration = asStringArray(item.narration_lines ?? item.narrationLines, LIMITS.maxLectureLines)
    // 动画数与讲义数对齐：多出来的丢掉（原版就是"每行讲义配一步动画"），
    // 少了就按最后一条补齐——不对称会让渲染时某一侧空着
    if (lectureLines.length === 0) continue
    const aligned: string[] = []
    for (let i = 0; i < lectureLines.length; i++) {
      aligned.push(animations[i] ?? animations[animations.length - 1] ?? lectureLines[i]!)
    }
    sections.push({
      id: `section_${sections.length + 1}`,
      title,
      lectureLines,
      animations: aligned,
      ...(narration.length ? { narrationLines: narration } : {}),
    })
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
      "animations": ["右侧画面第 1 步做什么", "第 2 步做什么"],
      "narration_lines": ["这一步口头讲的话（完整句子）", "…"]
    }
  ]
}

要求：
1. **lecture_lines 与 animations 数量必须相等且一一对应**——每一行讲义配一步动画。
2. **narration_lines 与 lecture_lines 同样一一对应**，但写法完全不同：
   - lecture_lines 是**给眼睛看的标签**：短语，≤${LIMITS.maxLectureLineChars} 字
   - narration_lines 是**给耳朵听的口播**：完整通顺的一句话，15~40 字
   - 口播要解释「为什么」，不是把标签念一遍
   - 例：标签「箭头 a 翻到 -a」→ 口播「把箭头整体翻个方向，长度不变，指向就反过来了」
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
   * 元素身份。**同一个 id 在不同步出现 = 同一个对象在动**。
   *
   * 这是「动画」与「幻灯片」的分界线。没有 id 时，每步只能重新画一遍，
   * 观众看到的是五张静态图；有 id 时，同一个三角形可以从左边滑到右边、
   * 变个颜色、被拆开——那才是讲解一个「变化」。
   *
   * 省略时按 `s{步}e{序号}` 生成，等于「只在这一步出现」。
   */
  id?: string
  /**
   * 在这一步之后消失。
   *
   * 实测的严重缺陷：元素只累积不消失，第 1 步画的图形一直堆到第 4 步，
   * 和后来的公式**撞在一起**（`pythagoras-three-proofs` 第 1 节整屏重叠）。
   *
   * `until: 2` = 显示到第 3 步开始前（步号从 0 起）。省略 = 一直留到本节结束。
   */
  until?: number
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
    for (let ei = 0; ei < Math.min(els.length, LIMITS.maxElementsPerStep); ei++) {
      const el = parseSceneElement(els[ei], i, ei)
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
function parseSceneElement(e: unknown, step: number, index: number): SceneElement | null {
  if (!isRecord(e)) return null
  const kind = typeof e.kind === 'string' && ELEMENT_KINDS.has(e.kind as SceneElement['kind'])
    ? (e.kind as SceneElement['kind'])
    : null
  if (!kind) return null

  const content = typeof e.content === 'string' ? e.content.slice(0, 40) : undefined
  const tex = typeof e.tex === 'string' ? e.tex.slice(0, 200) : undefined
  const color = typeof e.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(e.color) ? e.color : undefined
  // 元素 id：模型给了就用，没给按步号编一个（等于「只在这一步出现」）
  const id =
    typeof e.id === 'string' && e.id.trim()
      ? e.id.trim().slice(0, 32)
      : `s${step}e${index}`
  const untilRaw = anyNum(e.until)

  const base: SceneElement = {
    kind,
    id,
    // **`until` 只要给了就保留**，包括 `until === step`（只显示这一步）和
    // `until === 0`（第 0 步就退场）。初版写成 `untilRaw > step` 才收，
    // 于是「只在这一步显示」被当成没给——元素永远不消失，整屏重叠。
    ...(untilRaw !== null && untilRaw >= 0 ? { until: Math.floor(untilRaw) } : {}),
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
 * 一堆不存在的框。这里改成对真实元素的包围盒计算。
 *
 * **关键：按「屏幕上同时可见」判，不是按「同一步内」判。**
 * 元素会累积显示（第 1 步画的到第 4 步还在屏幕上），所以第 1 步的图形和第 4 步
 * 的公式完全可能撞在一起——而旧实现只比较同一步的内部，永远发现不了。
 * 实测 `pythagoras-three-proofs` 第 1 节整屏文字重叠，就是这样漏过去的。
 *
 * 判据只认几何，不认美观：
 * - `overlap`：同一步内元素互相压住
 * - `cross_step_overlap`：**不同步**的元素都还显示着，却压在一起
 * - `out_of_bounds`：元素伸出画面（会被裁掉，用户看到半截）
 * - `suspicious_span`：`w/h` 极扁/极长的矩形，是「拿 rect 当数轴/分隔线」的典型误用
 * - `highlight_over_text`：半透明色块盖住文字
 */
export type LayoutIssueKind =
  | 'overlap'
  | 'cross_step_overlap'
  | 'out_of_bounds'
  | 'suspicious_span'
  /**
   * `highlight` 半透明色块盖住了文字/公式。
   *
   * 实测：`pythagoras-three-proofs` 第 1 节，公式 `a²+2ab+b²` 正好被一个
   * `highlight` 块压住，白底上蓝色公式 + 浅蓝色块 → 读不出。
   *
   * 为什么在数据层判而不是看像素：像素层面「黑底白字」与「浅蓝块+蓝字」
   * 的颜色分布完全一样，区分不了；而这里知道哪个元素是色块、哪个是文字，
   * 判得准。
   */
  | 'highlight_over_text'

export interface LayoutIssue {
  step: number
  kind: LayoutIssueKind
  detail: string
  /** 涉及的元素下标（overlap 时为两个） */
  indexes: number[]
}

/**
 * 跨步重叠的判定阈值。
 *
 * **自动清理与门禁必须用同一个值**。实测教训：清理用 0.90、门禁用 0.35 时，
 * 0.35~0.90 之间的重叠既不会被清掉、又会被判失败，模型连改三版都过不去，
 * 最后整节退回纯文字模板——比有重叠还糟。
 *
 * 0.55 的依据：一个元素被盖住一半以上，视觉上已经不承载信息了。
 */
export const CROSS_STEP_OVERLAP_THRESHOLD = 0.55

/** `w/h` 超过这个倍数就当作「一条线」而不是一个形状 */
const SUSPICIOUS_SPAN_RATIO = 8

const TEXT_KINDS = new Set(['text', 'formula', 'tex', 'code'])

/** 一个元素在第 `step` 步时是否可见（它首次出现在第 `firstStep` 步） */
function visibleAt(el: SceneElement, firstStep: number, step: number): boolean {
  if (step < firstStep) return false
  return el.until === undefined || step <= el.until
}

/**
 * 同一步内的重复元素去重：位置几乎完全重合的，只留最后一个。
 *
 * 模型经常在同一个坐标连画两个东西（实测「第 1 步第 1 与第 2 个元素重叠 100%」）。
 * 这不是「框里放文字」——那种是部分重叠、是有意设计；**完全重合**只可能是重复。
 *
 * 保留最后一个：按「越后出现的越新」的直觉，模型后写的通常是它真想要的。
 */
export function dedupeSameStep(steps: readonly SceneStep[], sameThreshold = 0.95): SceneStep[] {
  /** 交并比：两边几乎完全一样才算重复。「小字落在框里」的交集=小字、并集=框，IoU 很小 */
  const iou = (a: SceneElement, b: SceneElement): number => {
    const ax = a.x ?? 30
    const ay = a.y ?? 40
    const aw = a.w ?? 24
    const ah = a.h ?? 14
    const bx = b.x ?? 30
    const by = b.y ?? 40
    const bw = b.w ?? 24
    const bh = b.h ?? 14
    const ix = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx))
    const iy = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by))
    const inter = ix * iy
    if (inter <= 0) return 0
    const union = aw * ah + bw * bh - inter
    return union > 0 ? inter / union : 0
  }

  return steps.map((step) => {
    const kept: SceneElement[] = []
    for (const el of step.elements) {
      const dup = kept.findIndex((k) => iou(k, el) >= sameThreshold)
      if (dup >= 0) kept[dup] = el // 后出现的替换先前的
      else kept.push(el)
    }
    return { elements: kept }
  })
}

/**
 * 把模型自造的 id 归到模板规定的角色上。
 *
 * 名册在提示词里给了，但模型仍可能写 `tri1` / `triangle` 这类名字。
 * 直接丢弃会让画面少东西，不丢弃又破坏了「同一对象跨步复用」。
 *
 * 归并规则（确定性）：
 * 1. id 已经在名册里 → 原样保留
 * 2. 不在名册里 → 找**同 kind 且还没被用掉**的角色，把 id 改成它
 * 3. 同 kind 的角色都用掉了 → 保留原 id（等于这一步多了一个临时对象）
 *
 * 之所以按 kind 归：`rect` 的对象被模型叫成 `box` 还是 `square` 无所谓，
 * 它要表达的都是「一个方块」。而 kind 不同的对象语义不同，不能混。
 */
export function normalizeRoleIds(
  steps: readonly SceneStep[],
  roles: ReadonlyArray<{ id: string; kind: string }>,
): SceneStep[] {
  if (roles.length === 0) return steps.map((s) => ({ elements: s.elements.map((e) => ({ ...e })) }))
  const known = new Set(roles.map((r) => r.id))
  const byKind = new Map<string, string[]>()
  for (const r of roles) {
    const list = byKind.get(r.kind) ?? []
    list.push(r.id)
    byKind.set(r.kind, list)
  }
  /** 已被用掉的角色（按出现顺序分配，保证稳定） */
  const used = new Set<string>()
  /** 自造 id → 归到的角色（同一个自造 id 在后续步要归到同一个角色） */
  const remap = new Map<string, string>()

  return steps.map((step) => ({
    elements: step.elements.map((el) => {
      const id = el.id ?? ''
      if (known.has(id)) {
        used.add(id)
        return { ...el }
      }
      const cached = remap.get(id)
      if (cached) return { ...el, id: cached }
      const candidates = byKind.get(el.kind) ?? []
      const free = candidates.find((c) => !used.has(c))
      if (!free) return { ...el }
      used.add(free)
      remap.set(id, free)
      return { ...el, id: free }
    }),
  }))
}

/**
 * 把元素从字幕禁区里挤出来。
 *
 * 提示词说了「底部 14% 是字幕区」，但模型仍会画到底（实测底部出现两行重复文字：
 * 元素一行、烧进去的字幕一行）。所以本地再压一道：底部越界的元素整体上移。
 *
 * 只在**有字幕**时才需要压——没有配音时底部可以随便用。
 */
export function liftOutOfSubtitleBand(
  steps: readonly SceneStep[],
  bandPct = SUB_BAND_PCT,
): SceneStep[] {
  const maxBottom = 100 - bandPct
  return steps.map((step) => ({
    elements: step.elements.map((el) => {
      const h = el.h ?? 14
      const y = el.y ?? 40
      if (y + h <= maxBottom) return { ...el }
      // 整体上移，但不越过顶部
      return { ...el, y: Math.max(0, maxBottom - h) }
    }),
  }))
}

/**
 * 自动给元素补 `until`：被后来者**完全覆盖**的元素自动退场。 *
 * ## 为什么不让模型自己写 until
 *
 * 实测：提示词里明确说了「不需要的东西要加 until 让它消失」，门禁也把
 * 跨步重叠打回重做三次，模型仍然改不对——它给出的每一版都还是「第 1 步画的
 * 东西一直留到第 5 步」。模型的注意力在「怎么讲」上，不在「哪块该清掉」上。
 *
 * 而这件事本地就能判死：**如果第 N 步在同一位置放了一个新元素，把第 M 步
 * （M<N）的元素完全盖住，那个旧元素在视觉上已经没用了**，让它退场不会有信息损失。
 * 这是几何事实，不需要理解语义。
 *
 * 只处理「被盖住一半以上」（默认重叠 ≥ 55%）这一类：那时旧元素在视觉上已经
 * 没用了。实测老是留下 50~80% 的部分重叠——完全覆盖的判断太严，模型画的
 * 新元素往往比旧的略大，把旧元素包住一大半但没全包住。
 *
 * 模型显式写了 `until` 的以模型为准——它可能知道某个元素虽然被盖住但还要回来。
 */
export function autoHideCovered(steps: readonly SceneStep[], coverThreshold = CROSS_STEP_OVERLAP_THRESHOLD): SceneStep[] {
  // 深拷贝：调用方可能还要用原数据结构做对比
  const out: SceneStep[] = steps.map((s) => ({
    elements: s.elements.map((el) => ({ ...el })),
  }))

  // 每个元素首次出现的步
  const firstSeen = new Map<string, number>()
  out.forEach((step, si) => {
    step.elements.forEach((el, ei) => {
      const id = el.id ?? `s${si}e${ei}`
      if (!firstSeen.has(id)) firstSeen.set(id, si)
    })
  })

  out.forEach((step, si) => {
    for (const cur of step.elements) {
      // 新元素出现时，检查它是否完全盖住了某个更早的元素
      for (const [id, from] of firstSeen) {
        if (from >= si) continue
        // 找到那个旧元素当前的状态
        const old = out[from]!.elements.find((e) => (e.id ?? '') === id)
        if (!old || old.until !== undefined) continue // 模型已指定，不动
        const ratio = overlapRatio(
          { x: old.x ?? 30, y: old.y ?? 40, w: old.w ?? 24, h: old.h ?? 14 },
          { x: cur.x ?? 30, y: cur.y ?? 40, w: cur.w ?? 24, h: cur.h ?? 14 },
        )
        if (ratio >= coverThreshold) {
          // 在「被盖住」的前一步退场。
          // **下限是它自己出现的步**：`si - 1` 在 si=1 时得 0，那是「第 0 步结束就消失」，
          // 也就是这个元素一次都没显示过（实测整屏空白）。
          // `until = from` 的语义是「显示到它出现的那一步结束」。
          old.until = Math.max(from, si - 1)
        }
      }
    }
  })
  return out
}

export function checkSceneLayout(
  steps: readonly SceneStep[],
  overlapThreshold = CROSS_STEP_OVERLAP_THRESHOLD,
): LayoutIssue[] {
  const issues: LayoutIssue[] = []

  // 收集每个元素首次出现在哪一步：同一步内可能重复 id，取最早的
  const firstSeen = new Map<string, number>()
  steps.forEach((step, si) => {
    for (const el of step.elements) {
      if (el.id && !firstSeen.has(el.id)) firstSeen.set(el.id, si)
    }
  })

  // ---- 逐个元素：出界、极扁 ----
  steps.forEach((step, si) => {
    step.elements.forEach((a, i) => {
      const ax = a.x ?? 30
      const ay = a.y ?? 40
      const aw = a.w ?? 24
      const ah = a.h ?? 14

      if (ax + aw > 100.5 || ay + ah > 100.5) {
        issues.push({
          step: si,
          kind: 'out_of_bounds',
          detail: `第 ${si + 1} 步第 ${i + 1} 个元素伸展到 (${Math.round(ax + aw)}, ${Math.round(ay + ah)})，超出画面`,
          indexes: [i],
        })
      }
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
    })
  })

  // ---- 同一步内重叠 ----
  steps.forEach((step, si) => {
    const els = step.elements
    for (let i = 0; i < els.length; i++) {
      for (let j = i + 1; j < els.length; j++) {
        const a = els[i]!
        const b = els[j]!
        const ratio = overlapRatio(
          { x: a.x ?? 30, y: a.y ?? 40, w: a.w ?? 24, h: a.h ?? 14 },
          { x: b.x ?? 30, y: b.y ?? 40, w: b.w ?? 24, h: b.h ?? 14 },
        )
        if (ratio < overlapThreshold) continue
        const aHl = a.kind === 'highlight'
        const bHl = b.kind === 'highlight'
        const hlOverText =
          (aHl && TEXT_KINDS.has(b.kind)) || (bHl && TEXT_KINDS.has(a.kind))
        issues.push({
          step: si,
          kind: hlOverText ? 'highlight_over_text' : 'overlap',
          detail: hlOverText
            ? `第 ${si + 1} 步的 highlight 色块盖住了文字（重叠 ${Math.round(ratio * 100)}%），文字会糊`
            : `第 ${si + 1} 步第 ${i + 1} 与第 ${j + 1} 个元素重叠 ${Math.round(ratio * 100)}%`,
          indexes: [i, j],
        })
      }
    }
  })

  // ---- 跨步重叠：屏幕上还显示着、但来自不同步的元素撞在一起 ----
  //
  // 这是旧实现**完全没查**的一类，而它正是实测最严重的问题：元素只累积不消失。
  // 对每一步，把所有仍在显示的元素收集起来两两比较。
  steps.forEach((step, si) => {
    if (si === 0) return // 第 0 步没有"之前还留着的"，已由同一步内检查覆盖
    // 收集 (元素, 首现步)
    const live: Array<{ el: SceneElement; from: number }> = []
    for (let s = 0; s <= si; s++) {
      for (const el of steps[s]!.elements) {
        const first = el.id ? (firstSeen.get(el.id) ?? s) : s
        // 只在它"首现那一步"记一次：同 id 在后续步是"更新"，不是新元素
        if (first === s && visibleAt(el, first, si)) live.push({ el, from: s })
      }
    }
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i]!
        const b = live[j]!
        if (a.from === b.from) continue // 同一步的已查过
        const ratio = overlapRatio(
          { x: a.el.x ?? 30, y: a.el.y ?? 40, w: a.el.w ?? 24, h: a.el.h ?? 14 },
          { x: b.el.x ?? 30, y: b.el.y ?? 40, w: b.el.w ?? 24, h: b.el.h ?? 14 },
        )
        if (ratio < overlapThreshold) continue
        issues.push({
          step: si,
          kind: 'cross_step_overlap',
          detail:
            `第 ${si + 1} 步时，第 ${a.from + 1} 步留下的元素与第 ${b.from + 1} 步的元素重叠 ` +
            `${Math.round(ratio * 100)}%（前面的元素没有消失）`,
          indexes: [],
        })
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
  /** 当前视觉风格；给了就把它的配色写进提示词，避免模型给的元素颜色与底冲突 */
  palette?: { name: string; bg: string; text: string; element: string; accent: string },
  /**
   * 模板规定的**对象名册**。
   *
   * 给了它，模型就只能用这几个 id——元素身份由模板决定，模型只填每步的位置。
   * 这是唯一可靠的做法：实测让模型自己起 id，提示词说了、门禁打回三次，
   * 它每一版都还是每步重新画。
   */
  roles?: ReadonlyArray<{ id: string; kind: string; purpose: string }>,
): string {
  const exampleBlock = example
    ? `\n## 样例（同模板的一节真实成品，照着这个密度和元素选择来）

小节：${example.title}
讲义行：${JSON.stringify(example.lectureLines)}
画面 JSON：
${JSON.stringify({ steps: example.scene })}
`
    : ''
  // 配色必须跟着风格走：实测选了黑板风，模型仍给 #93c5fd 的默认蓝，
  // 深墨绿底上的冷蓝字看着像贴上去的
  const paletteBlock = palette
    ? `\n## 这一版用的配色（风格：${palette.name}）

背景是 ${palette.bg}，正文是 ${palette.text}，强调色是 ${palette.accent}。
**元素的 color 必须从这套配色里取**，不要用默认的蓝色系——它会和背景冲突。
要区分多个元素时，在 ${palette.element} / ${palette.accent} 以及它们更亮/更暗的变体里挑。
`
    : ''
  // 名册是这一版最重要的约束：id 由模板定死，模型只填位置
  const rolesBlock = roles?.length
    ? `
## 这一版只有这几个对象（id 必须原样用）

${roles.map((r) => `- **${r.id}**（${r.kind}）：${r.purpose}`).join('\n')}

规则：
1. 只能出现上面这几个 id，**不要自己发明新的**。
2. 同一个 id 出现在多个步 = 那个东西在动。位置/内容变化，id 不变。
3. 某一步不需要某个对象 → 那一步就别列它（它会在那一步之后消失）。
4. 每一步最多 ${LIMITS.maxElementsPerStep} 个对象。
`
    : ''
  return `你在为一段教学动画设计每一帧的画面布局。只输出 JSON，不要解释。

小节：${section.title}
讲义行：${JSON.stringify(section.lectureLines)}
动画步骤：${JSON.stringify(section.animations)}
${exampleBlock}${paletteBlock}${rolesBlock}
右侧动画区是一个坐标系：x/y 是元素**左上角**在右区里的百分比（0~100），w/h 是宽高百分比。
每个动画步骤一组元素，元素逐个按出现顺序摆放，**不要互相重叠**。

**底部 ${SUB_BAND_PCT}% 是字幕区，不要在那里放东西**（有配音时那里会烧字幕，
放了会撞在一起、读不出来）。元素要完整落在 0~${100 - SUB_BAND_PCT} 的纵向范围内。

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
| **highlight** | 只给 x/y/w/h；给 content 就带标签 | 高亮一个区域（半透明色块）。**给 content 时会在块上写字**——空色块观众不知道它指什么，建议总给个短标签 |

## 选元素的判断

- 要画数轴、时间轴、任何带刻度的轴 → 用 **axis**，不要用很扁的 rect（那会变成空心长框）
- 要表示方向、因果、推导的下一步 → 用 **arrow**，不要用 text 写「→」
- 公式有分式、上下标、希腊字母 → 用 **tex**；只是简单一行「a²+b²=c²」用 formula 也行
- 要列几行数据做对比 → 用 **table**，不要用多个 text 硬拼
- 函数图像、趋势线 → 用 **curve**，给采样点

## 让东西动起来（**最重要的一条**）

同一个「id」出现在多个步 = **同一个东西在动**。渲染时它只创建一次，
之后每一步按新坐标/新颜色/新内容平滑过渡。

**这是「动画」和「幻灯片」的区别**：
- 幻灯片：每步画一批新东西 → 观众看到五个静态画面
- 动画：第一笔的东西一直在，位置/大小/颜色在变 → 观众看到**变化本身**

规则：
1. **讲「变化」时必须复用 id**。讲「三角形滑过去」→ 同一个 id 的两步只差 x。
   讲「数变大」→ 同一个 id 的两步只差 content。
2. **不需要的东西要让它消失**：给它 "until" 字段（值是步号）。不然它会一直堆在画面上，
   和后面的内容撞在一起（这是实测最严重的问题）。
   例：{"id":"tri","kind":"rect",...,"until":1} = 第 2 步开始前消失。
3. **画面同时最多 3~4 个东西**。超过就是该让旧的消失了。

## 输出格式

{"steps":[{"elements":[
  {"id":"a","kind":"tex","tex":"a^2+b^2=c^2","x":30,"y":20,"w":40,"h":12},
  {"id":"sq1","kind":"rect","color":"#93c5fd","x":20,"y":45,"w":18,"h":18}
]},{"elements":[
  {"id":"sq1","kind":"rect","color":"#86efac","x":60,"y":45,"w":18,"h":18},
  {"id":"arrow1","kind":"arrow","from":{"x":40,"y":54},"x":58,"y":54}
]}]}

（第二个元素 sq1 与第一个是**同一个方块**，它从左边移到了右边并变色）

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
