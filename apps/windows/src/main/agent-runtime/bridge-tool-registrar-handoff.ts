/**
 * 开发任务转交工具（F2）：propose_dev_handoff
 *
 * 主助手识别出「项目级工作」类请求（开发 / 分析 / 评审 / 调研）后，不自己动手、也不 spawn
 * （code-dev 是 ACP 会话型，无法作为子 Agent 委托），而是提出转交提案；用户点击消息卡片
 * 「交给灵栖开发」确认后，由 handoff:confirm 执行：新建或复用开发会话 → 把项目写进该会话的
 * dev-context（09-P2）→ 把背景包作为任务消息发出 → 直达绑定 CLI（或 pi 兜底）。
 */

import { Type } from '@sinclair/typebox'
import { createMtBotTool, type MtBotToolConfig, type ToolExecutionContext } from '@mtbot/agent-runtime'
import { agentRuntimeLog as log, jsonToolResult } from './bridge-utils'
import type { BridgeToolRegistrarDeps } from './bridge-tool-registrar-types'
import { isChannelSession, proposeHandoff } from './handoff-store'
import { getCodingDevConfig, resolveProjectPathByName, type CodingDevConfigSlice } from '../coding-dev-env'

/**
 * 解析转交的目标项目：显式参数 > 全局活动项目。
 *
 * 显式指定但未注册时返回错误——若放行，`projectName` 会被写进 dev-context 却解析不出路径，
 * `resolveDevContext` 静默回落到全局 workspace，任务就在错误目录里跑了（正是本计划要修的形态）。
 */
export function resolveHandoffProject(
  cfg: CodingDevConfigSlice,
  requested: string | undefined,
): { ok: true; projectName?: string } | { ok: false; error: string } {
  const name = typeof requested === 'string' ? requested.trim() : ''
  if (name) {
    if (!resolveProjectPathByName(cfg, name)) {
      const available = (cfg.codingDevProjects ?? []).map((p) => p.name).join('、') || '（无）'
      return {
        ok: false,
        error:
          `项目「${name}」不存在或未注册（当前已注册：${available}）。` +
          '请与用户确认项目名后重试，或省略 project 参数以使用当前活动项目。',
      }
    }
    return { ok: true, projectName: name }
  }
  const active = cfg.codingDevActiveProject?.trim()
  return { ok: true, ...(active ? { projectName: active } : {}) }
}

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
  project: Type.Optional(
    Type.String({
      description:
        '目标项目名，须已在本机注册（设置 → 开发 → 项目管理）。用户点名了项目就照抄其名称；省略时用当前活动项目。',
    }),
  ),
})

export function registerHandoffTools(deps: BridgeToolRegistrarDeps, ctx: ToolExecutionContext): void {
  const config: MtBotToolConfig = {
    name: 'propose_dev_handoff',
    label: 'Propose Dev Handoff',
    description:
      'Propose handing a project-level task to 灵栖开发 (code-dev), the resident dev specialist. ' +
      'Use when the user names a registered project and asks for work in it — bug fixes / features / refactors, ' +
      'AND project-scoped analysis, review or research (e.g. "根据这个项目的代码评审这份方案", "看看这个项目的架构"). ' +
      'For casual snippets outside any named project, handle them yourself with basic tools — do not over-escalate. ' +
      'This only creates a confirmation proposal — after calling it you MUST tell the user to click the ' +
      'confirm button on the handoff card; the dev session starts only after that click. ' +
      'Do NOT spawn code-dev via spawn_agent.',
    parameters: ProposeDevHandoffParams,
    category: 'agent',
    isReadOnly: false,
    needsPermission: false,
    execute: async (toolCallId, rawParams) => {
      const { task, summary, session_mode, project } = rawParams as {
        task: string
        summary: string
        session_mode?: 'new' | 'recent'
        project?: string
      }
      if (!task?.trim() || !summary?.trim()) {
        return jsonToolResult({ status: 'error', message: 'task 与 summary 均为必填' })
      }

      // 目标项目：项目名写进开发会话的 dev-context，是「转交后 cwd 落在项目目录」的唯一通道
      // （codingDevProjects 本身不参与 resolveDevContext 解析）。
      const resolved = resolveHandoffProject(getCodingDevConfig(), project)
      if (!resolved.ok) {
        return jsonToolResult({ status: 'error', message: resolved.error })
      }
      const projectName = resolved.projectName

      const instanceId =
        deps.toolCallInstanceMap.get(toolCallId) ?? deps.getCurrentToolExecutorInstanceId()
      const originSessionKey = (instanceId && deps.instanceToConversation.get(instanceId)) || ''

      const handoff = proposeHandoff({
        originSessionKey,
        task: task.trim(),
        summary: summary.trim(),
        sessionMode: session_mode === 'recent' ? 'recent' : 'new',
        ...(projectName ? { projectName } : {}),
      })
      log.info(
        `[propose_dev_handoff] 提案 handoffId=${handoff.id} mode=${handoff.sessionMode} project=${projectName ?? '(活动项目)'} origin=${originSessionKey || '(未知)'} summary="${handoff.summary}"`,
      )
      // 确认方式按会话渠道分流：渠道（QQ/微信/飞书/企微）无卡片按钮 → 回复 1；桌面 → 点卡片
      const inChannel = isChannelSession(originSessionKey)
      const projectHint = projectName ? `（目标项目：${projectName}）` : ''
      const message = inChannel
        ? `已生成转交提案${projectHint}。用户当前在渠道（没有卡片按钮）：请在回复中明确写「回复 1 确认」，确认后任务才会开始执行；用户回复其它内容则表示继续讨论。`
        : `已生成转交提案${projectHint}。请在回复中明确告诉用户：点击下方卡片上的「交给灵栖开发」按钮即可开始执行（点击前不会启动任何开发任务）。`
      return jsonToolResult({
        status: 'proposed',
        handoffId: handoff.id,
        summary: handoff.summary,
        ...(projectName ? { projectName } : {}),
        message,
      })
    },
  }
  deps.toolRegistry.register(createMtBotTool(config, ctx))
}
