/**
 * 开发任务转交工具（F2）：propose_dev_handoff
 *
 * 主助手识别出「绑定项目的代码开发」类请求后，不自己动手、也不 spawn（code-dev 是 ACP 会话型，
 * 无法作为子 Agent 委托），而是提出转交提案；用户点击消息卡片「交给灵栖开发」确认后，
 * 由 handoff:confirm 执行：新建或复用开发会话 → 把背景包作为任务消息发出 → 直达绑定 CLI（或 pi 兜底）。
 */

import { Type } from '@sinclair/typebox'
import { createMtBotTool, type MtBotToolConfig, type ToolExecutionContext } from '@mtbot/agent-runtime'
import { agentRuntimeLog as log, jsonToolResult } from './bridge-utils'
import type { BridgeToolRegistrarDeps } from './bridge-tool-registrar-types'
import { proposeHandoff } from './handoff-store'

const ProposeDevHandoffParams = Type.Object({
  task: Type.String({
    description:
      '完整任务描述（背景包），将作为开发任务的原文发给编码 CLI：目标、已知上下文（文件/模块/现象）、期望产出与边界。自包含，不要引用当前对话。',
  }),
  summary: Type.String({
    description: '一句话任务摘要（不超过 60 字），用于确认卡片展示。',
  }),
  session_mode: Type.Optional(
    Type.Union([Type.Literal('new'), Type.Literal('recent')], {
      description:
        "new=为新任务开新会话（默认）；recent=接着灵栖开发最近的会话继续（用户明确说「接着上次改」等延续场景时用）。",
    }),
  ),
})

export function registerHandoffTools(deps: BridgeToolRegistrarDeps, ctx: ToolExecutionContext): void {
  const config: MtBotToolConfig = {
    name: 'propose_dev_handoff',
    label: 'Propose Dev Handoff',
    description:
      'Propose handing a code-development task to 灵栖开发 (code-dev), the resident dev specialist. ' +
      'Use ONLY for project-level development in a registered/bound project — the user names a project ' +
      '(e.g. "帮我把 X 项目里的 Y 修了") and asks for bug fixes / features / refactors in that repository. ' +
      'For small one-off snippets or casual file edits outside a project dev workflow, handle them yourself ' +
      'with basic tools — do not over-escalate. ' +
      'This only creates a confirmation proposal — after calling it you MUST tell the user to click the ' +
      'confirm button on the handoff card; the dev session starts only after that click. ' +
      'Do NOT spawn code-dev via spawn_agent.',
    parameters: ProposeDevHandoffParams,
    category: 'agent',
    isReadOnly: false,
    needsPermission: false,
    execute: async (toolCallId, rawParams) => {
      const { task, summary, session_mode } = rawParams as {
        task: string
        summary: string
        session_mode?: 'new' | 'recent'
      }
      if (!task?.trim() || !summary?.trim()) {
        return jsonToolResult({ status: 'error', message: 'task 与 summary 均为必填' })
      }

      const instanceId =
        deps.toolCallInstanceMap.get(toolCallId) ?? deps.getCurrentToolExecutorInstanceId()
      const originSessionKey = (instanceId && deps.instanceToConversation.get(instanceId)) || ''

      const handoff = proposeHandoff({
        originSessionKey,
        task: task.trim(),
        summary: summary.trim(),
        sessionMode: session_mode === 'recent' ? 'recent' : 'new',
      })
      log.info(
        `[propose_dev_handoff] 提案 handoffId=${handoff.id} mode=${handoff.sessionMode} origin=${originSessionKey || '(未知)'} summary="${handoff.summary}"`,
      )
      // 确认方式分渠道：微信/渠道无卡片按钮 → 回复 1；桌面 → 点卡片按钮
      const inChannel = !!deps.weixinCtx.getCurrent()
      const message = inChannel
        ? '已生成转交提案。用户在微信渠道（无卡片按钮）：请在回复中明确写「回复 1 确认」，确认后任务才会开始执行；用户回复其它内容则表示继续讨论。'
        : '已生成转交提案。请在回复中明确告诉用户：点击下方卡片上的「交给灵栖开发」按钮即可开始执行（点击前不会启动任何开发任务）。'
      return jsonToolResult({
        status: 'proposed',
        handoffId: handoff.id,
        summary: handoff.summary,
        message,
      })
    },
  }
  deps.toolRegistry.register(createMtBotTool(config, ctx))
}
