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
    'Generate a narrated teaching video (MP4) for a knowledge point, 3Blue1Brown style: ' +
    'an outline is planned, a storyboard is written, each section is rendered as an animated ' +
    'scene, and the sections are merged into one video. ' +
    'Use this when the user asks for an explainer/teaching video about a concept. ' +
    'Takes 1-5 minutes to run; the result is a video file path.',
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
