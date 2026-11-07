/**
 * `teaching_video_generate` 工具定义（纯配置，无副作用）。
 *
 * 放在独立文件里是为了让 index.ts 只管接线：工具 schema 是这个能力**对模型暴露的
 * 全部契约**，值得单独看。
 *
 * 注意 `@mtbot/agent-runtime` 只做 **type-only** import：运行时 import 会把这个包
 * 整个打进扩展 bundle（实测 5.2MB → 只留类型后几百 KB）。
 */

import { Type } from '@sinclair/typebox'
import type { MtBotTool, MtBotToolConfig, MtBotToolResult, ToolExecutionContext } from '@mtbot/agent-runtime'

export const TeachingVideoParams = Type.Object({
  topic: Type.String({
    description:
      '要讲清楚的知识点，如「线性变换与矩阵」「为什么 0.999… = 1」「TCP 三次握手」。' +
      '写具体概念，不要写「做个数学视频」这种泛泛的话。',
  }),
  audience: Type.Optional(
    Type.String({ description: '目标受众，如「高中生」「大学新生」「零基础职场人」。留空由模型判断。' }),
  ),
  durationMinutes: Type.Optional(
    Type.Number({ description: '期望时长（分钟），默认 3。1~10 之间。', minimum: 1, maximum: 10 }),
  ),
  stage: Type.Optional(
    Type.Union([Type.Literal('draft'), Type.Literal('produce'), Type.Literal('revise')], {
      description:
        '工作阶段。**默认 draft**：只出大纲+分镜和一份 review.md，几十秒返回、不渲染，' +
        '让用户先确认讲得对不对。确认后再用 produce 出片（会复用 draft 的成果，不重复花 token）。' +
        'revise 用于只重做某几节（配合 sectionIds + fromDir），不必整条重跑。',
    }),
  ),
  style: Type.Optional(
    Type.String({
      description:
        '视觉风格。可选：3b1b（近黑深蓝底、细亮线，数学/物理默认）、' +
        'chalkboard（绿黑板粉笔，课堂推导）、clean（白底深线，产品/商业）、' +
        'metro（线路图，决策/分岔）、tech-dark（暗色青绿，技术/代码）。' +
        '留空时按用户的话自动选；用户说了「黑板」「白底」「科技感」这类词就直接传对应的。',
    }),
  ),
  sectionIds: Type.Optional(
    Type.Array(Type.Number(), {
      description: '仅 `revise` 阶段使用：要重做的小节序号（1 起）。留空 = 全部重做。',
    }),
  ),
  fromDir: Type.Optional(
    Type.String({
      description:
        '复用上一次的产物目录（就是上一次返回里的 outputDir）。' +
        'draft → produce、以及 revise 都应当带上它，否则会新建目录并重新生成大纲/分镜。',
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

export const teachingVideoToolConfig: MtBotToolConfig<typeof TeachingVideoParams> = {
  // @wiring-ignore 由 code2video 插件运行时注册，不进静态工具清单
  name: 'teaching_video_generate',
  label: 'Generate Teaching Video',
  description:
    'Generate a teaching/explainer video (MP4) with narration and burned-in subtitles. ' +
    '**Always call this tool — never hand-write a render script.** ' +
    'The section_N.html files it produces are intermediate artifacts; writing your own ' +
    'screenshot+ffmpeg pipeline around them bypasses narration, subtitles, element ' +
    'animation and layout gates, and yields a silent video with overlapping text. ' +
    '**Recommended flow — do NOT jump straight to a final video.** ' +
    '(1) Call with `stage: "draft"` first: it returns in under a minute with an outline, ' +
    'a storyboard, and a human-readable `review.md`, without rendering anything. ' +
    'Show the user the section structure and ask whether the explanation is right. ' +
    '(2) Only after they confirm, call again with `stage: "produce"` and `fromDir` set to the ' +
    'previous `outputDir` — the outline and storyboard are reused, so no tokens are wasted. ' +
    '(3) If the user then says a specific section is wrong or looks bad, call with ' +
    '`stage: "revise"`, `sectionIds: [n]`, and the same `fromDir` — only that section is ' +
    're-rendered and the video is re-merged. ' +
    'Never regenerate the whole thing just to fix one section.',
  parameters: TeachingVideoParams,
  category: 'agent',
  isReadOnly: false,
  // 会跑模型、写文件、起渲染窗口、调 ffmpeg——是"有副作用且耗资源"的那类，要用户点同意
  needsPermission: true,
  async execute() {
    // 真实实现由 index.ts 覆盖（那里才有桥与 workspace 的引用）
    return toolResult({ status: 'not_implemented' })
  },
}
