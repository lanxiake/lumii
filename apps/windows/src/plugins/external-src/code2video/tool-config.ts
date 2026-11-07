/**
 * 教学视频的三个工具定义（纯配置，无副作用）。
 *
 * ## 为什么拆成三个而不是一个带 `stage` 的参数
 *
 * 原来的 `teaching_video_generate({ stage })` 有三个问题：
 *
 * 1. **默认值救不了模型**。`stage` 缺省是 `draft`，但模型只要传了
 *    `stage: "produce"` 就能跳过草稿——实测它经常这么干，用户没看过讲法就出片。
 * 2. **一次调用占 7 分钟**，对话里没有任何交互点。
 * 3. **工具描述的约束力弱**。「先 draft 再 produce」写在 description 里，
 *    模型读完还要自己记得；拆成三个工具，它必须在**调用选择**上做决定。
 *
 * 拆开后每个工具只做一件事，耗时差一个数量级（40 秒 / 6 分钟 / 1 分钟），
 * 用户能清楚知道「现在在等什么」。
 *
 * ## 人工审核的三个点
 *
 * | 阶段 | 用户看什么 | 决定什么 |
 * |---|---|---|
 * | `plan` | 分节结构 + 每节讲什么 + 旁白草稿 | 讲法对不对 |
 * | `produce` 前的 `preview` | 首节画面（缩略图） | 风格/密度行不行 |
 * | `revise` | 具体哪一节 | 改哪里 |
 */

import { Type } from '@sinclair/typebox'
import type { MtBotTool, MtBotToolConfig, MtBotToolResult, ToolExecutionContext } from '@mtbot/agent-runtime'

/** 三个工具共用的参数 */
const TopicParam = Type.String({
  description:
    '要讲清楚的知识点，如「线性变换与矩阵」「为什么 0.999… = 1」「TCP 三次握手」。' +
    '写具体概念，不要写「做个数学视频」这种泛泛的话。',
})

const AudienceParam = Type.Optional(
  Type.String({ description: '目标受众，如「高中生」「大学新生」「零基础职场人」。留空由模型判断。' }),
)

const DurationParam = Type.Optional(
  Type.Number({ description: '期望时长（分钟），默认 3。1~10 之间。', minimum: 1, maximum: 10 }),
)

const StyleParam = Type.Optional(
  Type.String({
    description:
      '视觉风格。可选：3b1b（近黑深蓝底、细亮线，数学/物理默认）、' +
      'chalkboard（绿黑板粉笔，课堂推导）、clean（白底深线，产品/商业）、' +
      'metro（线路图，决策/分岔）、tech-dark（暗色青绿，技术/代码）。' +
      '留空时按用户的话自动选；用户说了「黑板」「白底」「科技感」这类词就直接传对应的。',
  }),
)

const FromDirParam = Type.Optional(
  Type.String({
    description:
      '上一次 plan 返回的 outputDir。produce 与 revise **必须带上**——' +
      '不带会新建目录、重新生成大纲与分镜，用户刚确认的内容就白确认了。',
  }),
)

// ---------------------------------------------------------------
// 1. plan —— 出草稿，等用户确认
// ---------------------------------------------------------------

export const PlanParams = Type.Object({
  topic: TopicParam,
  audience: AudienceParam,
  durationMinutes: DurationParam,
  style: StyleParam,
})

// ---------------------------------------------------------------
// 2. produce —— 出片
// ---------------------------------------------------------------

export const ProduceParams = Type.Object({
  fromDir: FromDirParam,
  /**
   * 略过首帧预览。**只有用户明确说「不用看了，直接出」时才传**。
   * 默认会先渲首节并返回一张预览图，让用户确认风格。
   */
  skipPreview: Type.Optional(
    Type.Boolean({
      description:
        '跳过首帧预览。仅当用户明确表示「不用看预览、直接出片」时才设为 true。' +
        '默认 false：会先渲第一节、返回一张预览图让你给用户看，确认后再出全片。',
    }),
  ),
})

// ---------------------------------------------------------------
// 3. revise —— 只重做指定节
// ---------------------------------------------------------------

export const ReviseParams = Type.Object({
  fromDir: FromDirParam,
  sectionIds: Type.Array(Type.Number(), {
    description: '要重做的小节序号（1 起）。**必须给**——整条重跑要多花十几分钟。',
  }),
  /** 这一节哪里不对，用自然语言描述，会进场景生成的提示词 */
  feedback: Type.Optional(
    Type.String({
      description:
        '这一节哪里不对，自然语言即可（「公式太挤」「没讲清楚为什么翻两次」）。' +
        '会作为修正要求传给场景生成，比重新点名更有效。',
    }),
  ),
})

/**
 * 把 JSON 载荷包成工具返回。
 *
 * 与 `bridge-utils.jsonToolResult` 同一口径：失败载荷提到顶层 `isError`——
 * 那才是 ToolRunner / ToolRegistry / 模型认得的失败信号。这里内联一份是因为
 * 运行时 import 会把整个 agent-runtime 打进扩展 bundle。
 */
export function toolResult(data: unknown): MtBotToolResult<unknown> {
  const status = (data as { status?: unknown } | null)?.status
  const failed = status === 'error' || status === 'not_found' || status === 'partial'
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    details: undefined,
    ...(failed ? { isError: true } : {}),
  }
}

/**
 * 与 `@mtbot/agent-runtime` 的 `createMtBotTool` 等价的最小实现。
 *
 * 为什么不直接用那个：它在 agent-runtime 的运行时入口里，import 会把整个包
 * 打进扩展 bundle（实测 5.2MB）。它本身只是把 config 的几个字段摊平并把
 * context 绑进 execute，内联三行代码就能省下整包体积。
 */
export function createTool<T extends MtBotToolConfig>(
  config: T,
  context: ToolExecutionContext,
): MtBotTool {
  return {
    name: config.name,
    label: config.label,
    description: config.description,
    parameters: config.parameters,
    category: config.category,
    isReadOnly: config.isReadOnly,
    needsPermission: config.needsPermission,
    isEnabled: config.isEnabled ?? (() => true),
    execute: (toolCallId, params, signal?, onUpdate?) =>
      config.execute(toolCallId, params, context, signal, onUpdate),
  } as MtBotTool
}

/** 三个工具的公共字段 */
const COMMON = {
  category: 'agent' as const,
  isReadOnly: false,
  // 会跑模型、写文件、起渲染窗口、调 ffmpeg——有副作用且耗资源，要用户点同意
  needsPermission: true,
  async execute(): Promise<MtBotToolResult<unknown>> {
    // 真实实现由 index.ts 覆盖（那里才有桥与 workspace 的引用）
    return toolResult({ status: 'not_implemented' })
  },
}

// ---------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------

export const teachingVideoPlanTool: MtBotToolConfig<typeof PlanParams> = {
  // @wiring-ignore 由 code2video 插件运行时注册，不进静态工具清单
  name: 'teaching_video_plan',
  label: '教学视频·出草稿',
  description:
    '**教学视频的第一步，永远从这里开始。** 只出大纲、分镜和一份人读的 review.md，' +
    '**不渲染、不配音**，约 40 秒返回。\n\n' +
    '拿到结果后**必须**做两件事：\n' +
    '1. 用中文列出这几节讲什么（节标题 + 每节一句话）\n' +
    '2. 主动挑毛病：推导有没有跳步？有没有漏掉的前提？某节是不是可以删？\n' +
    '然后问用户「这个讲法对不对，要不要调」。**不要**直接调 produce。\n\n' +
    '返回的 outputDir 必须记住，produce 要用。',
  parameters: PlanParams,
  ...COMMON,
}

export const teachingVideoProduceTool: MtBotToolConfig<typeof ProduceParams> = {
  // @wiring-ignore 由 code2video 插件运行时注册，不进静态工具清单
  name: 'teaching_video_produce',
  label: '教学视频·出片',
  description:
    '把已确认的草稿做成成片：逐节生成画面 → 配音 → 字幕 → 合成，约 5~8 分钟。\n\n' +
    '**前置条件**：必须先调过 `teaching_video_plan` 且用户确认了讲法。' +
    '`fromDir` 传 plan 返回的 outputDir。\n\n' +
    '**默认会先渲首节、返回一张预览图**（字段 `previewPath`）。除非用户明确说' +
    '「不用看预览、直接出」，否则先给用户看这张图、问风格与密度行不行，' +
    '用户点头后再带 `skipPreview: true` 调一次出全片。\n\n' +
    '**绝不自己写渲染脚本。** 工具产出的 section_N.html 是中间产物，' +
    '自己拼截图+ffmpeg 会绕过配音、字幕、动画与布局门禁。',
  parameters: ProduceParams,
  ...COMMON,
}

export const teachingVideoReviseTool: MtBotToolConfig<typeof ReviseParams> = {
  // @wiring-ignore 由 code2video 插件运行时注册，不进静态工具清单
  name: 'teaching_video_revise',
  label: '教学视频·返工',
  description:
    '只重做指定的几节，其余复用已渲染的 mp4，约 1~2 分钟。\n\n' +
    '**用于用户指出某一节有问题**（「第 2 节的公式太挤」「第 3 节没讲清楚」）。' +
    '把用户的原话放进 `feedback`，它会进场景生成的提示词。\n\n' +
    '**不要为了改一节重跑全片**——那要多花十几分钟，而且其余节会被无谓地重渲。',
  parameters: ReviseParams,
  ...COMMON,
}

/** 三个工具放在一起供 index.ts 注册 */
export const TEACHING_VIDEO_TOOLS = [
  teachingVideoPlanTool,
  teachingVideoProduceTool,
  teachingVideoReviseTool,
] as const
