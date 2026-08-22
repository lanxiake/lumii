/**
 * 渐进式加载指南工具（a2ui_guide / cron_guide / weixin_send_guide）
 * 与 skill_list / skill_search / skill_invoke 覆盖注册。
 *
 * 从 bridge-tool-registrar.ts 抽离，纯函数式注册，仅依赖注入的 deps。
 */

import {
  createMtBotTool,
  type MtBotToolConfig,
  type SkillInfo,
  skillListToolConfig,
  skillSearchToolConfig,
  skillInvokeToolConfig,
} from '@mtbot/agent-runtime'
import { agentRuntimeLog as log, jsonToolResult } from './bridge-utils'
import type { BridgeToolRegistrarDeps } from './bridge-tool-registrar-types'

/**
 * 注册渐进式加载指南工具（a2ui_guide / cron_guide）。
 * 系统提示词只保留工具名+一句话描述，完整文档由工具调用时返回，节省每轮 ~150 tokens。
 */
export function registerGuideTools(deps: BridgeToolRegistrarDeps): void {
  const ctx = deps.toolContext
  if (!ctx) return

  // 空参数 schema（无需任何输入）
  const EmptyParams = { type: 'object' as const, properties: {}, required: [] }

  const a2uiGuide: MtBotToolConfig = {
    name: 'a2ui_guide',
    label: 'A2UI Guide',
    description: 'Get full A2UI component docs, JSON format and examples — call when you need to output UI components',
    parameters: EmptyParams as never,
    category: 'agent' as const,
    isReadOnly: true,
    needsPermission: false,
    execute: async () => {
      return jsonToolResult({
        overview: 'A2UI: output structured UI in ```a2ui JSON blocks. Wrap components in {"components":[...]}.',
        components: {
          Chart: 'chartType: "line"|"bar"|"pie"|"scatter"|"area", title?, data: {labels: string[], datasets: [{label, values: number[]}]}',
          DataTable: 'columns: [{key, label, sortable?}], rows: Record<string,unknown>[], pageSize?, filterable?',
          FilePreview: 'filename: string, src: string (relative path e.g. "outputs/file.pdf"), mimeType?, size?',
          MathVisualizer: 'expression: string, range?: {xMin?,xMax?,yMin?,yMax?}, animated?',
          Text: 'content: string, variant?: "body"|"caption"|"heading"',
          Card: 'title?, subtitle?, components?: A2UIComponent[]',
          Image: 'src: string, alt?, width?, height?',
          Button: 'label: string, variant?: "primary"|"secondary"|"outline", disabled?',
          List: 'items: A2UIComponent[], ordered?',
          AudioPlayer: 'src: string, title?',
          VideoPlayer: 'src: string, poster?, title?',
        },
        examples: {
          chart: '{"components":[{"type":"Chart","id":"c1","chartType":"bar","title":"销售","data":{"labels":["Q1","Q2","Q3"],"datasets":[{"label":"收入","values":[100,150,120]}]}}]}',
          table: '{"components":[{"type":"DataTable","id":"t1","columns":[{"key":"name","label":"名称"},{"key":"val","label":"值"}],"rows":[{"name":"项目A","val":42}]}]}',
          file_preview: '{"components":[{"type":"FilePreview","id":"fp1","filename":"报告.pdf","src":"outputs/报告.pdf"}]}',
        },
        artifact_sandbox: 'Output ```html / ```svg / ```javascript code blocks directly — client auto-renders in sandbox. CSP: no fetch/XHR, https images/fonts OK.',
        selection_guide: '数据可视化 → A2UI Chart/DataTable | 文件预览 → A2UI FilePreview | 代码运行/动画 → Artifact | 文本 → Markdown | 公式 → LaTeX',
      })
    },
  }
  deps.toolRegistry.register(createMtBotTool(a2uiGuide, ctx))

  const cronGuide: MtBotToolConfig = {
    name: 'cron_guide',
    label: 'Cron Guide',
    description: 'Get cron_create parameter format and examples — call before creating a scheduled task',
    parameters: EmptyParams as never,
    category: 'agent' as const,
    isReadOnly: true,
    needsPermission: false,
    execute: async () => {
      return jsonToolResult({
        tool: 'cron_create',
        params: {
          name: 'Human-readable name for the task',
          taskText: 'Message/instruction to execute when triggered',
          scheduleType: '"cron" | "every" | "at"',
          scheduleExpr: 'Expression matching scheduleType (see below)',
          agentId: '(optional) Agent ID to run the task',
        },
        scheduleExpr_guide: {
          cron: 'Standard 5-field cron expression. e.g. "0 9 * * 1-5" (weekdays 9am)',
          every: 'Repeat interval in milliseconds as integer string. e.g. "300000" (every 5 min)',
          at: 'One-time: PREFERRED use template expression: "${Date.now() + N}" where N is ms offset. e.g. "${Date.now() + 120000}" (2 min from now). Plain timestamp ms also accepted.',
        },
        cron_syntax: 'Fields: minute hour day-of-month month day-of-week | * = any | */5 = every 5 | 1-5 = range',
        examples: {
          weekday_morning: '{"name":"日报","taskText":"生成并发送今日工作日报","scheduleType":"cron","scheduleExpr":"0 9 * * 1-5"}',
          every_hour: '{"name":"每小时检查","taskText":"检查未读消息","scheduleType":"every","scheduleExpr":"3600000"}',
          in_30_min: '{"name":"提醒","taskText":"提醒用户开会","scheduleType":"at","scheduleExpr":"${Date.now() + 30 * 60 * 1000}"}',
        },
      })
    },
  }
  deps.toolRegistry.register(createMtBotTool(cronGuide, ctx))

  const weixinSendGuide: MtBotToolConfig = {
    name: 'weixin_send_guide',
    label: 'WeChat Send Guide',
    description: 'Get WeChat file/image delivery guide — call when you need to send files or images to a WeChat user',
    parameters: EmptyParams as never,
    category: 'agent' as const,
    isReadOnly: true,
    needsPermission: false,
    execute: async () => {
      return jsonToolResult({
        overview: '通过微信发送文本或文件给用户，使用 `message` 工具，channel 设为 "weixin"。channelUserId 由系统自动从当前会话获取，无需手动填写。',
        how_to_send_text: {
          description: '发送文本消息给当前微信用户',
          example: {
            tool: 'message',
            params: {
              action: 'send',
              channel: 'weixin',
              text: '你好，这是来自 AI 助手的消息',
            },
          },
        },
        how_to_send_file: {
          description: '发送文件或图片给当前微信用户',
          step1: '确定文件的绝对路径（可以是 outputs/ 目录、uploads/ 目录或任意本地路径）',
          step2: '调用 message 工具，将 mediaUrl 设为文件的绝对路径（无需提前复制文件）',
          example: {
            tool: 'message',
            params: {
              action: 'send',
              channel: 'weixin',
              text: '请查收文件',
              mediaUrl: 'C:/Users/Administrator/.lumii/workspace/uploads/20260419/报告.pdf',
            },
          },
          tip: 'uploads/ 目录下的文件可以直接发送，不需要先复制到 outputs/',
        },
        how_to_send_received_file_back: {
          description: '将用户发来的文件回发给用户（或发送经过处理后的版本）',
          format_in_message: '用户发来的文件路径格式：[media attached: uploads/20260419/文件名.ext (文件名.ext)]',
          get_absolute_path: '从消息中提取相对路径，拼接 workspace 根目录即为绝对路径',
          example_input: '[media attached: uploads/20260419/报告.pdf (报告.pdf)]',
          example_absolute: 'C:/Users/Administrator/.lumii/workspace/uploads/20260419/报告.pdf',
          how_to_send: {
            tool: 'message',
            params: {
              action: 'send',
              channel: 'weixin',
              text: '请查收您发来的文件',
              mediaUrl: 'C:/Users/Administrator/.lumii/workspace/uploads/20260419/报告.pdf',
            },
          },
        },
        how_to_read_received_file: {
          description: '用户通过微信发来的文件已自动下载到 workspace/uploads/ 目录。',
          format: '消息文本中会包含 `[media attached: uploads/YYYYMMDD/文件名.ext (文件名.ext)]`',
          example: '[media attached: uploads/20260419/报告.pdf (报告.pdf)]',
          read_it: '用 file_read 读取该路径（相对于 workspace 根目录）：file_read("uploads/20260419/报告.pdf")',
        },
        important_notes: [
          'channel 必须设为 "weixin"（全小写）',
          'channelUserId 由系统自动获取，无需手动填写',
          '文件发送：mediaUrl 设为文件的绝对路径（Windows 路径，如 C:/Users/...）',
          '图片、文档、视频等多媒体文件均支持发送',
          '发送成功后回复 NO_REPLY 避免重复投递',
        ],
      })
    },
  }
  deps.toolRegistry.register(createMtBotTool(weixinSendGuide, ctx))

  // 注册 skill_list / skill_search / skill_invoke
  // 覆盖 built-in 版本，注入 getSkills（从 instanceStates 按 instanceId 查找 skillsSnapshot）
  const getSkillsForCall = (toolCallId: string): readonly SkillInfo[] => {
    const instanceId = deps.toolCallInstanceMap.get(toolCallId) ?? deps.getCurrentToolExecutorInstanceId()
    if (!instanceId) return []
    return deps.instanceStates.get(instanceId)?.skillsSnapshot ?? []
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const skillListOverride: MtBotToolConfig<any> = {
    ...skillListToolConfig,
    execute: (toolCallId, params, toolCtx, signal, onUpdate) =>
      skillListToolConfig.execute(toolCallId, params, { ...toolCtx, getSkills: () => getSkillsForCall(toolCallId) }, signal, onUpdate),
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const skillSearchOverride: MtBotToolConfig<any> = {
    ...skillSearchToolConfig,
    execute: (toolCallId, params, toolCtx, signal, onUpdate) =>
      skillSearchToolConfig.execute(toolCallId, params, { ...toolCtx, getSkills: () => getSkillsForCall(toolCallId) }, signal, onUpdate),
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const skillInvokeOverride: MtBotToolConfig<any> = {
    ...skillInvokeToolConfig,
    execute: (toolCallId, params, toolCtx, signal, onUpdate) =>
      skillInvokeToolConfig.execute(toolCallId, params, { ...toolCtx, getSkills: () => getSkillsForCall(toolCallId) }, signal, onUpdate),
  }
  deps.toolRegistry.register(createMtBotTool(skillListOverride, ctx))
  deps.toolRegistry.register(createMtBotTool(skillSearchOverride, ctx))
  deps.toolRegistry.register(createMtBotTool(skillInvokeOverride, ctx))

  log.info('[registerGuideTools] a2ui_guide / cron_guide / weixin_send_guide / skill_list / skill_search / skill_invoke 已注册')
}
