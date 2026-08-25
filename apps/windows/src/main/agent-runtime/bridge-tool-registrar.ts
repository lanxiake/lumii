/**
 * BridgeToolRegistrar — 工具注册器
 *
 * 集中托管 AgentRuntimeBridge 中所有 register* 工具注册方法，
 * 包括内建工具覆盖（todo_write/spawn_agent/send_message）、指南工具、
 * 本地 Cron 工具、集成工具、客户端命令工具、Agent 管理工具与浏览器工具。
 *
 * 从 bridge.ts 抽离，仅依赖通过 BridgeToolRegistrarDeps 注入的协作对象，
 * 不持有 bridge 实例引用，便于独立演进。
 */

import { Type } from '@sinclair/typebox'
import {
  createMtBotTool,
  type MtBotToolConfig,
  type SpawnAgentParams,
  todoWriteToolConfig,
  spawnAgentToolConfig,
  sendMessageToolConfig,
  shouldNudgeVerification,
  VERIFICATION_NUDGE_TEXT,
} from '@mtbot/agent-runtime'
import { registerBrowserTools as registerBrowserToolsFn } from './bridge-browser-tools'
import { registerWikiTools } from './bridge-wiki-tools'
import { registerAppUiTools as registerAppUiToolsFn } from './bridge-app-ui-tools'
import { registerScreenRecordTools as registerScreenRecordToolsFn } from './bridge-screen-record-tools'
import { getScreenRecordService } from '../screen-record/accessor'
import { getNarrateService } from '../screen-record/narrate-accessor'
import { resizeImageIfNeeded } from './image-resizer'
import { agentRuntimeLog as log, jsonToolResult, parseTaskStatus } from './bridge-utils'
import { registerGuideTools } from './bridge-tool-registrar-guide'
import { registerLocalCronTools, registerDashboardFeedTool } from './bridge-tool-registrar-cron'
import { registerChannelTools, registerIntegrationTools } from './bridge-tool-registrar-integration'
import { registerClientCommandTools, registerAgentManagementTools } from './bridge-tool-registrar-client-cmd'
import type { BridgeToolRegistrarDeps } from './bridge-tool-registrar-types'

export type { BridgeToolRegistrarDeps, WeixinCtxAccessor } from './bridge-tool-registrar-types'
export { resolveChannelFromSessionKey } from './bridge-tool-registrar-cron'

export class BridgeToolRegistrar {
  constructor(private readonly deps: BridgeToolRegistrarDeps) {}

  /**
   * 在注册完内建 stub 后，用 Windows 本地实现覆盖 todo_write / spawn_agent / send_message
   * 并注册本地 cron 工具、指南工具，按需注册集成工具与浏览器工具。
   */
  registerAll(): void {
    this.registerTodoWriteOverride()
    this.registerSpawnAgentOverride()
    this.registerSendMessageOverride()
    // 本地 cron 工具无需 Gateway，始终注册
    registerLocalCronTools(this.deps)
    // 资讯卡片写入，供 Agent 驱动的资讯抓取任务落盘结构化结果
    registerDashboardFeedTool(this.deps)
    // 渠道出站：不依赖 Gateway，始终注册
    registerChannelTools(this.deps)
    // Agent 操作本客户端界面（Part A：app_screenshot），始终注册
    this.registerAppUiTools()
    // 录屏四工具（内部总开关由 screenRecord.enabled 决定）
    this.registerScreenRecordTools()
    // 渐进式加载指南工具（a2ui_guide / cron_guide）
    registerGuideTools(this.deps)
    // 客户端集成工具（message/memory/profile/system_prompt/tts/image），不依赖 Gateway，始终注册。
    // 原实现为链式调用（integration → clientCommand → agentManagement），摊平为显式调用；
    // 三者共享同一次 ctx 判空结果，ctx 为空时原链条整体不注册，此处保持一致。
    const ctx = this.deps.toolContext
    if (ctx) {
      registerIntegrationTools(this.deps)
      registerClientCommandTools(this.deps, ctx)
      registerAgentManagementTools(this.deps, ctx)
      // Wiki 知识库工具（P0）：wiki_overview/wiki_search/wiki_read/wiki_capture
      registerWikiTools(this.deps.toolRegistry, ctx, this.deps)
    }
    // 浏览器控制工具（getBrowserContext 配置存在时注册）
    if (this.deps.config.getBrowserContext) {
      this.registerBrowserTools()
    }
  }

  /**
   * 将 todo_write 绑定到本地 SQLite TaskRepo
   */
  private registerTodoWriteOverride(): void {
    const ctx = this.deps.toolContext
    const taskRepo = this.deps.getTaskRepo()
    if (!ctx || !taskRepo) return

    type BatchCreateItem = { subject: string; description?: string; owner?: string }
    type BatchUpdateItem = { taskId: string; status?: string; owner?: string }

    const realConfig: MtBotToolConfig = {
      ...todoWriteToolConfig,
      execute: async (_toolCallId, rawParams, _toolCtx) => {
        const params = rawParams as {
          action: string
          subject?: string
          description?: string
          owner?: string
          taskId?: string
          status?: string
          tasks?: BatchCreateItem[]
          updates?: BatchUpdateItem[]
        }
        // 获取当前会话 ID，实现任务列表会话隔离
        const currentInstanceId = this.deps.getCurrentToolExecutorInstanceId()
        const conversationId = currentInstanceId
          ? this.deps.instanceToConversation.get(currentInstanceId)
          : undefined

        // 主题5 P0-2：完成态 verification-nudge —— 在 mutating 动作后检查任务清单，
        // 若 3+ 任务全 done 且无验证步骤，则在结果中追加提醒（flag 包裹）。
        const withVerificationNudge = (result: ReturnType<typeof jsonToolResult>) => {
          if (!this.deps.getFeatureFlags().ENABLE_VERIFICATION_NUDGE) return result
          try {
            const tasks = taskRepo.list(conversationId)
            if (shouldNudgeVerification(tasks)) {
              return {
                ...result,
                content: [
                  ...result.content,
                  { type: 'text' as const, text: `\n${VERIFICATION_NUDGE_TEXT}` },
                ],
              }
            }
          } catch {
            // 列表读取失败不影响主流程
          }
          return result
        }
        switch (params.action) {
          case 'create': {
            const task = taskRepo.create({
              conversationId,
              subject: params.subject ?? 'Untitled task',
              description: params.description,
              owner: params.owner,
            })
            return jsonToolResult({ action: params.action, status: 'ok', task })
          }
          case 'batch_create': {
            const items = params.tasks
            if (!Array.isArray(items) || items.length === 0) {
              return jsonToolResult({ action: params.action, status: 'error', message: 'tasks array required for batch_create' })
            }
            const created = items.map((item) =>
              taskRepo.create({
                conversationId,
                subject: item.subject ?? 'Untitled task',
                description: item.description,
                owner: item.owner,
              })
            )
            return jsonToolResult({ action: params.action, status: 'ok', tasks: created, total: created.length })
          }
          case 'update': {
            if (!params.taskId) {
              return jsonToolResult({ action: params.action, status: 'error', message: 'taskId required' })
            }
            const status = parseTaskStatus(params.status)
            const updated = taskRepo.update(params.taskId, {
              status,
              owner: params.owner,
            })
            if (!updated) {
              return jsonToolResult({ action: params.action, status: 'error', message: 'task not found' })
            }
            return withVerificationNudge(jsonToolResult({ action: params.action, status: 'ok', task: updated }))
          }
          case 'batch_update': {
            const updates = params.updates
            if (!Array.isArray(updates) || updates.length === 0) {
              return jsonToolResult({ action: params.action, status: 'error', message: 'updates array required for batch_update' })
            }
            const results = updates.map((item) => {
              if (!item.taskId) return { taskId: '', status: 'error', message: 'taskId required' }
              const status = parseTaskStatus(item.status)
              const updated = taskRepo.update(item.taskId, { status, owner: item.owner })
              return updated
                ? { status: 'ok', task: updated }
                : { taskId: item.taskId, status: 'not_found' }
            })
            const failed = results.filter((r) => r.status !== 'ok')
            return withVerificationNudge(jsonToolResult({
              action: params.action,
              status: failed.length === 0 ? 'ok' : 'partial',
              tasks: results.filter((r) => r.status === 'ok').map((r) => (r as { task: unknown }).task),
              errors: failed.length > 0 ? failed : undefined,
              total: updates.length,
            }))
          }
          case 'list': {
            const tasks = taskRepo.list(conversationId)
            return jsonToolResult({ action: params.action, status: 'ok', tasks, total: tasks.length })
          }
          case 'delete': {
            if (!params.taskId) {
              return jsonToolResult({ action: params.action, status: 'error', message: 'taskId required' })
            }
            const deleted = taskRepo.delete(params.taskId)
            return jsonToolResult({ action: params.action, status: deleted ? 'ok' : 'not_found' })
          }
          default:
            return jsonToolResult({ action: params.action, status: 'error', message: `unknown action: ${String(params.action)}` })
        }
      },
    }

    this.deps.toolRegistry.register(createMtBotTool(realConfig, ctx))
    log.info('[registerToolOverrides] todo_write 已覆盖 stub')
  }

  /**
   * 将 spawn_agent 绑定到 AgentOrchestrator
   */
  private registerSpawnAgentOverride(): void {
    const ctx = this.deps.toolContext
    if (!ctx) return

    const realConfig: MtBotToolConfig = {
      ...spawnAgentToolConfig,
      execute: async (toolCallId, params, _toolCtx) => {
        // 优先从 toolCallInstanceMap 获取 instanceId，回退到 currentToolExecutorInstanceId
        const parentId = this.deps.toolCallInstanceMap.get(toolCallId) ?? this.deps.getCurrentToolExecutorInstanceId()
        const result = await this.deps.ensureOrchestrator().spawnAgent(
          params as SpawnAgentParams,
          parentId,
        )
        if (result.status === 'error') {
          return jsonToolResult({ status: 'error', message: result.message })
        }
        if (result.mode === 'sync') {
          // sync 返回时附带强制提示，避免主 Agent 收到 output 后仍然沉默、
          // 不把子 Agent 结果转达给用户（配合系统提示词的 Sub-agent Delegation 规则）。
          // verdict（主题5 P0-1）：builtin:verify 子 Agent 的结构化验证结论，
          // output 内已前置 [VERIFY RESULT: X] 机器可读摘要。
          return jsonToolResult({
            status: 'ok',
            instanceId: result.instanceId,
            mode: 'sync' as const,
            output: result.output,
            ...(result.verdict ? { verdict: result.verdict } : {}),
            note:
              "You MUST now summarize or integrate the above `output` into your " +
              "reply to the user. Do not end your turn without reporting the " +
              "sub-agent's result.",
          })
        }
        return jsonToolResult({
          status: 'ok',
          instanceId: result.instanceId,
          mode: 'async' as const,
          message: result.message,
        })
      },
    }

    this.deps.toolRegistry.register(createMtBotTool(realConfig, ctx))
    log.info('[registerToolOverrides] spawn_agent 已覆盖 stub')
  }

  /**
   * 将 send_message 绑定为 AgentOrchestrator（MessageBus + followUp）
   */
  private registerSendMessageOverride(): void {
    const ctx = this.deps.toolContext
    if (!ctx) return

    const realConfig: MtBotToolConfig = {
      ...sendMessageToolConfig,
      execute: async (toolCallId, params, _toolCtx) => {
        // 优先从 toolCallInstanceMap 获取 instanceId，回退到 currentToolExecutorInstanceId
        const currentInstanceId = this.deps.getCurrentToolExecutorInstanceId()
        log.info(`[DEBUG send_message] execute called: toolCallId=${toolCallId}, currentToolExecutorInstanceId=${currentInstanceId}, mapSize=${this.deps.toolCallInstanceMap.size}`)
        log.info(`[DEBUG send_message] toolCallInstanceMap keys: ${Array.from(this.deps.toolCallInstanceMap.keys()).join(', ')}`)
        const fromId = this.deps.toolCallInstanceMap.get(toolCallId) ?? currentInstanceId
        log.info(`[DEBUG send_message] resolved fromId=${fromId}`)
        if (!fromId) {
          log.error(`[DEBUG send_message] FAILED: No active agent context for send_message, toolCallId=${toolCallId}`)
          return jsonToolResult({ status: 'error', message: 'No active agent context for send_message' })
        }

        const p = params as { to: string; message: string; summary?: string }
        const result = await this.deps.ensureOrchestrator().sendMessage({
          to: p.to,
          message: p.message,
          summary: p.summary,
          fromInstanceId: fromId,
        })

        if (result.status === 'error') {
          return jsonToolResult({ status: 'error', message: result.message })
        }
        if (result.broadcast) {
          return jsonToolResult({ status: 'ok', broadcast: true, recipientCount: result.recipientCount })
        }
        return jsonToolResult({ status: 'ok', to: result.to, delivered: result.delivered })
      },
    }

    this.deps.toolRegistry.register(createMtBotTool(realConfig, ctx))
    log.info('[registerToolOverrides] send_message 已覆盖 stub')
  }

  private registerBrowserTools(): void {
    const getBrowserContext = this.deps.config.getBrowserContext
    if (!this.deps.toolContext || !getBrowserContext) return
    registerBrowserToolsFn(this.deps.toolRegistry, this.deps.toolContext, getBrowserContext)
  }

  /** 注册 Agent App UI 控制工具（app_screenshot 等） */
  private registerAppUiTools(): void {
    const getMainWindow = this.deps.config.getWindow
    if (!this.deps.toolContext || !getMainWindow) return
    registerAppUiToolsFn(this.deps.toolRegistry, this.deps.toolContext, {
      getWindow: (target) => (target === 'main' ? getMainWindow() : null),
      resizeImageIfNeeded,
      readSettingsJson: async () => {
        const win = getMainWindow()
        if (!win || win.isDestroyed()) return null
        try {
          return await win.webContents.executeJavaScript(
            `localStorage.getItem('mtbot-assistant-settings')`,
          )
        } catch {
          return null
        }
      },
    })
  }

  /** 注册录屏工具（含 pause/resume/narrate） */
  private registerScreenRecordTools(): void {
    if (!this.deps.toolContext) return
    registerScreenRecordToolsFn(this.deps.toolRegistry, this.deps.toolContext, {
      getService: () => getScreenRecordService(),
      getNarrateService: () => getNarrateService(),
    })
  }
}
