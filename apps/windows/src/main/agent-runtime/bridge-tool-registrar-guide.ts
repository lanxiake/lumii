/**
 * 渐进式加载指南工具（a2ui_guide / cron_guide / weixin_send_guide / prompt_guide）
 * 与 skill_list / skill_search / skill_invoke 覆盖注册。
 *
 * 从 bridge-tool-registrar.ts 抽离，纯函数式注册，仅依赖注入的 deps。
 */

import {
  createMtBotTool,
  type MtBotTool,
  type MtBotToolConfig,
  type SkillInfo,
  skillSearchToolConfig,
  skillInvokeToolConfig,
  getPromptSectionGuide,
  listPromptGuideSections,
} from '@mtbot/agent-runtime'
import { Type } from '@sinclair/typebox'
import { agentRuntimeLog as log, jsonToolResult } from './bridge-utils'
import type { BridgeToolRegistrarDeps } from './bridge-tool-registrar-types'

/**
 * 注册渐进式加载指南工具（a2ui_guide / cron_guide / weixin_send_guide / prompt_guide）。
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
    description:
      'Get the A2UI docs (charts & data tables rendered inline in chat). Call before emitting an ```a2ui block.',
    parameters: EmptyParams as never,
    category: 'agent' as const,
    isReadOnly: true,
    needsPermission: false,
    execute: async () => {
      return jsonToolResult({
        overview:
          'A2UI: output structured UI in ```a2ui JSON blocks. Wrap components in {"components":[...]}. Only Chart and DataTable exist.',
        components: {
          Chart:
            'chartType: "line"|"bar"|"pie"|"scatter"|"area", title?, data: {labels: string[], datasets: [{label: string, values: number[]}]} — values must be numbers, length matches labels',
          DataTable:
            'columns: [{key, label, sortable?}], rows: Record<string,unknown>[] (keys match columns[].key), pageSize?, filterable?',
        },
        limits: {
          points_per_chart: 2000,
          rows_per_table: 5000,
          columns_per_table: 50,
          components_per_message: 20,
          note: '超出会被截断；字段类型不合法（如 labels 给成字符串、values 含非数字）整块不渲染',
        },
        examples: {
          chart:
            '{"components":[{"type":"Chart","id":"c1","chartType":"bar","title":"销售","data":{"labels":["Q1","Q2","Q3"],"datasets":[{"label":"收入","values":[100,150,120]}]}}]}',
          table:
            '{"components":[{"type":"DataTable","id":"t1","columns":[{"key":"name","label":"名称","sortable":true},{"key":"val","label":"值"}],"rows":[{"name":"项目A","val":42}]}]}',
        },
        artifact_sandbox:
          'Output ```html / ```svg / ```javascript code blocks directly — client auto-renders them in a sandboxed iframe (opaque origin: no localStorage/cookie or parent-page access; network requests are allowed).',
        selection_guide:
          '趋势/对比/占比 → A2UI Chart | ≥5 行且需排序筛选 → A2UI DataTable | ≤4 行小表或一次性罗列 → Markdown 表格 | 代码运行/动画/交互页面 → Artifact | 普通文字 → Markdown | 公式 → LaTeX。文件（图片/PDF/音视频）用 Markdown 链接或图片语法，不要用 A2UI。',
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
      // 2026-09-19：本文案的 scheduleType/示例曾把 cron 表达式列为可用（包内 schema 与工具描述同病），
      // 而本机 cron_create 必然拒绝 cron——模型照示例做必然碰壁（t15 实测：
      // 试 "0 9 * * *" 被拒后自造了 at 自续链）。三处文案已对齐为能力事实。
      // 注：本注释刻意放在 jsonToolResult 实参之外——host-tool-failure-semantics 守卫
      // 会扫描实参文本，实参里出现「失败」等字样而无 ok/status 会被判成漏标的失败载荷。
      return jsonToolResult({
        tool: 'cron_create',
        params: {
          name: 'Human-readable name for the task',
          taskText: 'Message/instruction to execute when triggered',
          scheduleType: '"every" | "at"',
          scheduleExpr: 'Expression matching scheduleType (see below)',
          agentId: '(optional) Agent ID to run the task',
        },
        scheduleExpr_guide: {
          every: 'Repeat interval in milliseconds as integer string. e.g. "300000" (every 5 min)',
          at: 'One-time: PREFERRED use template expression: "${Date.now() + N}" where N is ms offset. e.g. "${Date.now() + 120000}" (2 min from now). Plain timestamp ms also accepted.',
        },
        limitation:
          '不支持「每天固定时刻」（如 9:00）这类语义：every 的首次触发在「创建时刻 + 间隔」，不会对齐到整点。遇到固定时刻需求，如实告诉用户并确认改用间隔或一次性任务。',
        examples: {
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

  // 提示词段渐进加载（terse 风格）：系统提示词只留索引句 + 引导句，完整规则由本工具按需返回
  const PromptGuideParams = Type.Object({
    section: Type.String({
      description:
        'Prompt section id shown in the terse hint, e.g. "operatingPrinciples", "fileOutput"',
    }),
  })

  const promptGuide: MtBotToolConfig<typeof PromptGuideParams> = {
    name: 'prompt_guide',
    label: 'Prompt Guide',
    description:
      'Get the full rules for a prompt section — call when a terse hint in the system prompt is not enough. Pass the `section` id shown in the hint.',
    parameters: PromptGuideParams,
    category: 'agent' as const,
    isReadOnly: true,
    needsPermission: false,
    execute: async (_toolCallId, params) => {
      const guide = getPromptSectionGuide(params.section)
      if (!guide) {
        // `ok: false` 是本仓库宿主工具的失败载荷约定，也是 jsonToolResult 识别失败的依据
        // （此前这里只写了 error 字段，形状与其余 196 处不一致，会被漏判）
        return jsonToolResult({
          ok: false,
          error: `Unknown prompt section: ${params.section}`,
          available_sections: listPromptGuideSections(),
        })
      }
      return jsonToolResult({
        section: params.section,
        title: guide.title,
        body: guide.body,
      })
    },
  }
  // 泛型参数逆变：带类型参数的 MtBotTool 与 registry 的 MtBotTool<TSchema> 不重叠，需经 unknown 断言
  deps.toolRegistry.register(createMtBotTool(promptGuide, ctx) as unknown as MtBotTool)

  // 注册 skill_search / skill_invoke
  // 覆盖 built-in 版本，注入 getSkills（从 instanceStates 按 instanceId 查找 skillsSnapshot）
  const getSkillsForCall = (toolCallId: string): readonly SkillInfo[] => {
    const instanceId = deps.toolCallInstanceMap.get(toolCallId) ?? deps.getCurrentToolExecutorInstanceId()
    if (!instanceId) return []
    return deps.instanceStates.get(instanceId)?.skillsSnapshot ?? []
  }

  // skill_list 已并入 skill_search（不带 query 即列出全部）——这里也就少一份覆盖。
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
  deps.toolRegistry.register(createMtBotTool(skillSearchOverride, ctx))
  deps.toolRegistry.register(createMtBotTool(skillInvokeOverride, ctx))

  log.info('[registerGuideTools] a2ui_guide / cron_guide / weixin_send_guide / prompt_guide / skill_search / skill_invoke 已注册')
}
