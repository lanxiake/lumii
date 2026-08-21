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
  ToolRegistry,
  AgentDefinitionStore,
  AgentOrchestrator,
  TaskRepo,
  MemoryManager,
  ConversationRepo,
  LocalDatabase,
  createMtBotTool,
  isKnownImageGenerationModel,
  normalizeImageModelId,
  type ToolExecutionContext,
  type MtBotToolConfig,
  type MtBotTool,
  type SkillInfo,
  type SpawnAgentParams,
  todoWriteToolConfig,
  spawnAgentToolConfig,
  sendMessageToolConfig,
  cronCreateToolConfig,
  cronListToolConfig,
  cronDeleteToolConfig,
  dashboardFeedWriteToolConfig,
  messageToolConfig,
  channelListToolConfig,
  channelSendToolConfig,
  memorySearchToolConfig,
  memoryReadToolConfig,
  profileMemoryToolConfig,
  systemPromptToolConfig,
  speechGenerateToolConfig,
  imageGenerateToolConfig,
  skillListToolConfig,
  skillSearchToolConfig,
  skillInvokeToolConfig,
  sessionCreateToolConfig,
  sessionClearToolConfig,
  sessionCompactToolConfig,
  sessionResumeToolConfig,
  settingsThinkToolConfig,
  settingsBackendToolConfig,
  infoStatusToolConfig,
  memoryManageToolConfig,
  agentTeamGenerateToolConfig,
  agentTeamOptimizeToolConfig,
  agentRemoveToolConfig,
  shouldNudgeVerification,
  VERIFICATION_NUDGE_TEXT,
  type AgentRuntimeFeatureFlags,
} from '@mtbot/agent-runtime'
import type { AgentRuntimeBridgeConfig } from './bridge-types'
import type { InstanceStateStore } from './bridge-instance-state'
import type { BridgeRendererIpcChannel } from './bridge-renderer-ipc'
import type { CronScheduler } from './cron-scheduler'
import { registerBrowserTools as registerBrowserToolsFn } from './bridge-browser-tools'
import { registerAppUiTools as registerAppUiToolsFn } from './bridge-app-ui-tools'
import { registerScreenRecordTools as registerScreenRecordToolsFn } from './bridge-screen-record-tools'
import { getScreenRecordService } from '../screen-record/accessor'
import { getNarrateService } from '../screen-record/narrate-accessor'
import { resizeImageIfNeeded } from './image-resizer'
import {
  writeDashboardFeedSnapshot,
  DEFAULT_DASHBOARD_FEED_ID,
  uniqueDashboardFeedItemId,
} from '../dashboard-feed-store'
import {
  agentRuntimeLog as log,
  jsonToolResult,
  parseAtScheduleExpr,
  parseStrictMs,
  parseTaskStatus,
  removeMarkdownSection,
} from './bridge-utils'

/**
 * 微信会话上下文（与 AgentRuntimeBridge 共享）
 */
export interface WeixinCtxAccessor {
  /** 读取当前活跃的微信会话上下文 */
  getCurrent: () => { channelUserId: string; contextToken: string; botToken?: string; ilinkBaseUrl?: string } | null
  /** 标记本轮已通过 message 工具发送微信消息 */
  markSentViaTool: () => void
}

/**
 * 从 sessionKey 前缀解析出创建定时任务时所在的渠道，用作 notify_targets 默认值。
 * 微信/企微是被动回复模式，没有主动推送渠道，回落系统通知；只有飞书有主动推送能力。
 */
export function resolveChannelFromSessionKey(sessionKey: string | undefined): string {
  if (sessionKey?.startsWith('feishu:')) return 'feishu'
  return 'system'
}

/**
 * 注册器依赖集合。所有字段都是只读引用，注册器不创建/销毁这些对象。
 */
export interface BridgeToolRegistrarDeps {
  toolRegistry: ToolRegistry
  toolContext: ToolExecutionContext
  config: AgentRuntimeBridgeConfig
  /** 惰性获取 cronScheduler（构造注册器时调度器可能尚未初始化，工具运行时再取） */
  getCronScheduler: () => CronScheduler
  localDb: LocalDatabase
  getTaskRepo: () => TaskRepo | null
  getMemoryManager: () => MemoryManager | null
  getConversationRepo: () => ConversationRepo | null
  /** 读取当前 feature flags（主题5：verification-nudge / task_complete 门禁 killswitch） */
  getFeatureFlags: () => AgentRuntimeFeatureFlags
  ipcChannel: BridgeRendererIpcChannel
  instanceStates: InstanceStateStore
  instanceToConversation: Map<string, string>
  /** 当前正在执行工具的 instance ID（来自 bridge.currentToolExecutorInstanceId） */
  getCurrentToolExecutorInstanceId: () => string | undefined
  /** 由 instanceId 解析 Agent 定义 ID（= 工作记忆的 agentId），用于 memory_manage 精确命中 */
  getDefinitionIdByInstanceId: (instanceId: string) => string | undefined
  toolCallInstanceMap: Map<string, string>
  getDefinitionStore: () => AgentDefinitionStore | null
  /** 惰性获取 orchestrator（首次调用时创建） */
  ensureOrchestrator: () => AgentOrchestrator
  /** 微信会话上下文访问器（message 工具用） */
  weixinCtx: WeixinCtxAccessor
  /** 惰性获取渠道出站 Router（channel_list / channel_send） */
  getChannelRouter: () => import('../channel/channel-outbound-router').ChannelOutboundRouter | null
  /** 图片生成（image_generate 工具用） */
  generateImage: (params: {
    prompt: string
    modelId?: string
    width?: number
    height?: number
    filename?: string
    referenceImagePaths?: string[]
    signal?: AbortSignal
  }) => Promise<{ filePath: string; width: number; height: number; model: string; revisedPrompt: string }>
}

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
    this.registerLocalCronTools()
    // 资讯卡片写入，供 Agent 驱动的资讯抓取任务落盘结构化结果
    this.registerDashboardFeedTool()
    // 渠道出站：不依赖 Gateway，始终注册
    this.registerChannelTools()
    // Agent 操作本客户端界面（Part A：app_screenshot），始终注册
    this.registerAppUiTools()
    // 录屏四工具（内部总开关由 screenRecord.enabled 决定）
    this.registerScreenRecordTools()
    // 渐进式加载指南工具（a2ui_guide / cron_guide）
    this.registerGuideTools()
    // 客户端集成工具（message/memory/profile/system_prompt/tts/image），不依赖 Gateway，始终注册
    this.registerIntegrationTools()
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

  /**
   * 注册渐进式加载指南工具（a2ui_guide / cron_guide）。
   * 系统提示词只保留工具名+一句话描述，完整文档由工具调用时返回，节省每轮 ~150 tokens。
   */
  private registerGuideTools(): void {
    const ctx = this.deps.toolContext
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
    this.deps.toolRegistry.register(createMtBotTool(a2uiGuide, ctx))

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
    this.deps.toolRegistry.register(createMtBotTool(cronGuide, ctx))

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
    this.deps.toolRegistry.register(createMtBotTool(weixinSendGuide, ctx))

    // 注册 skill_list / skill_search / skill_invoke
    // 覆盖 built-in 版本，注入 getSkills（从 instanceStates 按 instanceId 查找 skillsSnapshot）
    const getSkillsForCall = (toolCallId: string): readonly SkillInfo[] => {
      const instanceId = this.deps.toolCallInstanceMap.get(toolCallId) ?? this.deps.getCurrentToolExecutorInstanceId()
      if (!instanceId) return []
      return this.deps.instanceStates.get(instanceId)?.skillsSnapshot ?? []
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
    this.deps.toolRegistry.register(createMtBotTool(skillListOverride, ctx))
    this.deps.toolRegistry.register(createMtBotTool(skillSearchOverride, ctx))
    this.deps.toolRegistry.register(createMtBotTool(skillInvokeOverride, ctx))

    log.info('[registerGuideTools] a2ui_guide / cron_guide / weixin_send_guide / skill_list / skill_search / skill_invoke 已注册')
  }

  /**
   * 注册本地定时任务工具（cron_create / cron_list / cron_delete），完全不依赖 Gateway。
   */
  private registerLocalCronTools(): void {
    const ctx = this.deps.toolContext
    if (!ctx) return

    const cronCreate: MtBotToolConfig = {
      ...cronCreateToolConfig,
      execute: async (_id, rawParams) => {
        const p = rawParams as {
          name: string
          taskText: string
          scheduleType: 'at' | 'every' | 'cron'
          scheduleExpr: string
          agentId?: string
          notifyTargets?: string
        }
        const scheduleExpr = p.scheduleExpr?.trim() ?? ''
        if (!p.name?.trim()) {
          return jsonToolResult({ status: 'error', message: 'name is required' })
        }
        if (!p.taskText?.trim()) {
          return jsonToolResult({ status: 'error', message: 'taskText is required' })
        }
        if (!scheduleExpr) {
          return jsonToolResult({ status: 'error', message: 'scheduleExpr is required' })
        }
        if (!this.deps.localDb.isOpen) {
          return jsonToolResult({ status: 'error', message: 'database not initialized' })
        }

        const now = Date.now()
        let nextRunAt = now
        let intervalMs: number | null = null

        if (p.scheduleType === 'every') {
          const everyMs = parseStrictMs(scheduleExpr)
          if (everyMs === undefined || everyMs <= 0) {
            return jsonToolResult({
              status: 'error',
              message: 'Invalid scheduleExpr for every. Use integer milliseconds string, e.g. "60000".',
            })
          }
          intervalMs = everyMs
          nextRunAt = now + everyMs
        } else if (p.scheduleType === 'at') {
          const atMs = parseAtScheduleExpr(scheduleExpr)
          if (atMs === undefined) {
            return jsonToolResult({
              status: 'error',
              message: 'Invalid scheduleExpr for at. Use unix timestamp ms or `${Date.now() + ...}`.',
            })
          }
          nextRunAt = atMs
        } else {
          // 独立版无 Gateway，cron 表达式调度目前无本地实现，明确报错
          return jsonToolResult({
            status: 'error',
            message: 'Local mode currently supports only "at" and "every" schedule types, not "cron".',
          })
        }

        // 未显式指定推送渠道时，默认使用当前对话所在渠道（sessionKey 前缀解析）—
        // 微信/企微是被动回复模式没有主动推送能力，回落系统通知
        const currentInstanceId = this.deps.getCurrentToolExecutorInstanceId()
        const sessionKey = currentInstanceId
          ? this.deps.instanceToConversation.get(currentInstanceId)
          : undefined
        const notifyTargets = p.notifyTargets?.trim() || resolveChannelFromSessionKey(sessionKey)

        // 未指定执行 Agent 时回落到当前 Agent：任务文本本就是写给 Agent 的指令，
        // agent_id 为空会让调度器把指令原文当通知正文推送，任务实际从未执行
        const fallbackAgentId = currentInstanceId
          ? this.deps.getDefinitionIdByInstanceId(currentInstanceId)
          : undefined
        const agentId = p.agentId?.trim() || fallbackAgentId || null

        const jobId = `local-cron-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const row = {
          id: jobId,
          name: p.name.trim(),
          task_text: p.taskText,
          agent_id: agentId,
          schedule_type: p.scheduleType,
          schedule_expr: scheduleExpr,
          next_run_at: nextRunAt,
          interval_ms: intervalMs,
          enabled: 1,
          created_at: now,
          notify_targets: notifyTargets,
        } as const

        this.deps.localDb.db.prepare(
          `INSERT INTO local_cron_jobs
           (id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at, notify_targets)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          row.id,
          row.name,
          row.task_text,
          row.agent_id,
          row.schedule_type,
          row.schedule_expr,
          row.next_run_at,
          row.interval_ms,
          row.enabled,
          row.created_at,
          row.notify_targets,
        )

        this.deps.getCronScheduler().scheduleJob(row)
        return jsonToolResult({
          status: 'ok',
          job: {
            id: row.id,
            name: row.name,
            scheduleType: row.schedule_type,
            scheduleExpr: row.schedule_expr,
            nextRunAt: row.next_run_at,
            intervalMs: row.interval_ms ?? undefined,
            enabled: true,
          },
        })
      },
    }
    this.deps.toolRegistry.register(createMtBotTool(cronCreate, ctx))

    const cronList: MtBotToolConfig = {
      ...cronListToolConfig,
      execute: async (_id, rawParams) => {
        const p = rawParams as { includeDisabled?: boolean }
        const includeDisabled = p.includeDisabled ?? true
        if (!this.deps.localDb.isOpen) {
          return jsonToolResult({ status: 'error', message: 'database not initialized' })
        }
        const rows = this.deps.localDb.db.prepare<{
          id: string
          name: string
          task_text: string
          agent_id: string | null
          schedule_type: 'at' | 'every' | 'cron'
          schedule_expr: string
          next_run_at: number
          interval_ms: number | null
          enabled: number
          created_at: number
        }>(
          `SELECT id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at
           FROM local_cron_jobs
           ${includeDisabled ? '' : 'WHERE enabled = 1'}
           ORDER BY created_at DESC`
        ).all()

        return jsonToolResult({
          status: 'ok',
          jobs: rows.map((job) => ({
            id: job.id,
            name: job.name,
            taskText: job.task_text,
            agentId: job.agent_id ?? undefined,
            scheduleType: job.schedule_type,
            scheduleExpr: job.schedule_expr,
            nextRunAt: job.next_run_at,
            intervalMs: job.interval_ms ?? undefined,
            enabled: job.enabled === 1,
            createdAt: job.created_at,
          })),
          total: rows.length,
        })
      },
    }
    this.deps.toolRegistry.register(createMtBotTool(cronList, ctx))

    const cronDelete: MtBotToolConfig = {
      ...cronDeleteToolConfig,
      execute: async (_id, rawParams) => {
        const p = rawParams as { id: string }
        const id = p.id?.trim()
        if (!id) {
          return jsonToolResult({ status: 'error', message: 'id is required' })
        }
        this.deps.getCronScheduler().clearLocalCronTimer(id)
        const result = this.deps.localDb.db
          .prepare(`DELETE FROM local_cron_jobs WHERE id = ?`)
          .run(id)
        return jsonToolResult({
          status: result.changes > 0 ? 'ok' : 'not_found',
          id,
        })
      },
    }
    this.deps.toolRegistry.register(createMtBotTool(cronDelete, ctx))
    log.info('[registerToolOverrides] local cron tools registered: cron_create/cron_list/cron_delete')
  }

  /**
   * 注册 dashboard_feed_write：Agent 抓取资讯后落盘结构化结果到概览页资讯卡片。
   * feedId 固定用 DEFAULT_DASHBOARD_FEED_ID（'news'）—— 当前仅有这一个 feed 在用。
   */
  private registerDashboardFeedTool(): void {
    const ctx = this.deps.toolContext
    if (!ctx) return

    const dashboardFeedWrite: MtBotToolConfig = {
      ...dashboardFeedWriteToolConfig,
      execute: async (_id, rawParams) => {
        const p = rawParams as {
          title: string
          summary?: string
          items: Array<{ title: string; summary?: string; href?: string; source?: string }>
        }
        if (!p.title?.trim()) {
          return jsonToolResult({ status: 'error', message: 'title is required' })
        }
        if (!Array.isArray(p.items) || p.items.length === 0) {
          return jsonToolResult({ status: 'error', message: 'items must be a non-empty array' })
        }
        try {
          await writeDashboardFeedSnapshot({
            feedId: DEFAULT_DASHBOARD_FEED_ID,
            title: p.title.trim(),
            updatedAt: Date.now(),
            ...(p.summary?.trim() ? { summary: p.summary.trim() } : {}),
            items: (() => {
              const seenIds = new Map<string, number>()
              return p.items.map((item, index) => ({
                id: uniqueDashboardFeedItemId(
                  { href: item.href?.trim(), title: item.title },
                  index,
                  seenIds,
                ),
                title: item.title,
                ...(item.summary ? { summary: item.summary } : {}),
                ...(item.href ? { href: item.href } : {}),
                ...(item.source ? { source: item.source } : {}),
                timestamp: Date.now(),
                kind: 'news',
              }))
            })(),
          })
          return jsonToolResult({ status: 'ok', itemCount: p.items.length })
        } catch (err) {
          return jsonToolResult({
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
          })
        }
      },
    }
    this.deps.toolRegistry.register(createMtBotTool(dashboardFeedWrite, ctx))
    log.info('[registerDashboardFeedTool] dashboard_feed_write registered')
  }

  /**
   * 注册渠道出站工具 channel_list / channel_send（走 ChannelOutboundRouter）。
   */
  private registerChannelTools(): void {
    const ctx = this.deps.toolContext
    if (!ctx) return

    const channelList: MtBotToolConfig = {
      ...channelListToolConfig,
      execute: async () => {
        const router = this.deps.getChannelRouter()
        if (!router) {
          return jsonToolResult({
            ok: false,
            errorCode: 'HUB_NOT_READY',
            message: '渠道出站 Hub 尚未就绪，请稍后再试（非未登录）',
            channels: [],
          })
        }
        const channels = await router.list()
        return jsonToolResult({ channels })
      },
    }
    this.deps.toolRegistry.register(createMtBotTool(channelList, ctx))

    const channelSend: MtBotToolConfig = {
      ...channelSendToolConfig,
      execute: async (_id, rawParams) => {
        const router = this.deps.getChannelRouter()
        if (!router) {
          return jsonToolResult({
            ok: false,
            errorCode: 'HUB_NOT_READY',
            message: '渠道出站 Hub 尚未就绪，请稍后再试（非未登录）',
          })
        }
        const p = rawParams as {
          channel?: string
          to?: string
          text?: string
          mediaPath?: string
          fileName?: string
        }
        const channel = String(p.channel ?? '').trim() as 'feishu' | 'weixin' | 'wecom'
        if (channel !== 'feishu' && channel !== 'weixin' && channel !== 'wecom') {
          return jsonToolResult({
            ok: false,
            errorCode: 'PEER_NOT_FOUND',
            message: "channel 必须是 'feishu' | 'weixin' | 'wecom'",
          })
        }
        const result = await router.send({
          channel,
          to: String(p.to ?? ''),
          text: String(p.text ?? ''),
          ...(p.mediaPath ? { mediaPath: String(p.mediaPath) } : {}),
          ...(p.fileName ? { fileName: String(p.fileName) } : {}),
        })
        return jsonToolResult(result)
      },
    }
    this.deps.toolRegistry.register(createMtBotTool(channelSend, ctx))
    log.info('[registerChannelTools] channel_list/channel_send registered')
  }

  /**
   * 注册客户端集成工具（message / memory_search / profile_memory / system_prompt）
   */
  private registerIntegrationTools(): void {
    const ctx = this.deps.toolContext
    if (!ctx) return

    const messageTool: MtBotToolConfig = {
      ...messageToolConfig,
      execute: async (_id, rawParams) => {
        const p = rawParams as Record<string, unknown>
        const channel = String(p.channel ?? '').toLowerCase()

        // 微信通道发送判定：
        // 1. agent 显式指定 channel='weixin'，或
        // 2. 当前对话本就是活跃微信会话，且 agent 未指定其它真实通道（默认即微信）
        // 后者让 agent 无需显式设 channel/to 即可回当前微信用户，避免被 'to' 必填误导。
        const isImplicitWeixin =
          channel === '' || channel === 'windows-agent-runtime'
        const weixinCtx = this.deps.weixinCtx.getCurrent()
        if (channel === 'weixin' || (isImplicitWeixin && weixinCtx)) {
          if (!weixinCtx) {
            log.warn('[message tool] channel=weixin 但无活跃微信会话上下文，无法发送')
            return jsonToolResult({ status: 'error', message: '当前没有活跃的微信会话，无法发送消息。请先在微信发送消息建立会话后再试。' })
          }
          const router = this.deps.getChannelRouter()
          if (!router) {
            return jsonToolResult({ status: 'error', message: '渠道出站 Hub 尚未就绪，请稍后再试' })
          }
          const text = p.text ? String(p.text) : ''
          const filePath = p.mediaUrl ? String(p.mediaUrl) : undefined
          log.info(`[message tool] 微信本地发送（经 ChannelOutboundRouter）channelUserId=${weixinCtx.channelUserId} text=${text.slice(0, 50)} filePath=${filePath}`)
          const result = await router.send({
            channel: 'weixin',
            to: weixinCtx.channelUserId,
            text,
            ...(filePath ? { mediaPath: filePath } : {}),
          })
          if (result.ok) {
            this.deps.weixinCtx.markSentViaTool()
          }
          return jsonToolResult(result.ok
            ? {
                status: 'ok',
                message: '消息已发送',
                note: '消息已通过微信投递给用户。本轮请回复 NO_REPLY，避免对话流再次重复发送相同内容。',
              }
            : { status: 'error', message: result.message ?? '发送失败' })
        }

        // 非微信通道：message 工具不再支持主动出站（原 Gateway send RPC 为迁移遗留代码，已移除）
        return jsonToolResult({
          status: 'error',
          message: '该场景请改用 channel_list 查询可发送的 peer，再调用 channel_send 发送；message 工具仅用于回复当前会话（含隐式回微信）。',
        })
      },
    }
    this.deps.toolRegistry.register(createMtBotTool(messageTool, ctx))

    const memorySearchTool: MtBotToolConfig = {
      ...memorySearchToolConfig,
      execute: async (_id, rawParams) => {
        const p = rawParams as { query?: string; maxResults?: number; sessionKey?: string }
        const query = (p.query ?? '').trim()
        if (!query) {
          return jsonToolResult({ status: 'error', message: 'query is required' })
        }
        const limit = Math.max(1, Math.min(p.maxResults ?? 10, 50))
        const sessionKey = (p.sessionKey ?? '').trim()

        /**
         * 取某会话已归档段的 palace drawer_id 集合，用于 memory_search 会话级过滤。
         */
        const drawerIdsForSession = (conversationId: string): Set<string> => {
          const rows = this.deps.localDb.db
            .prepare(
              `SELECT palace_drawer_id FROM memory_segments
               WHERE conversation_id = ? AND palace_drawer_id IS NOT NULL`,
            )
            .all(conversationId) as { palace_drawer_id: string }[]
          return new Set(rows.map((r) => r.palace_drawer_id).filter(Boolean))
        }

        // 优先使用 MemPalace 语义搜索
        if (this.deps.config.searchMempalace) {
          try {
            let items = await this.deps.config.searchMempalace(query, limit)
            if (items !== null) {
              if (sessionKey) {
                const allowed = drawerIdsForSession(sessionKey)
                if (allowed.size > 0) {
                  items = items.filter((item) => allowed.has(item.drawer_id))
                }
              }
              const results = items.map((item) => ({
                content: item.text,
                score: item.similarity,
                source: `${item.wing}/${item.room}`,
                drawer_id: item.drawer_id,
              }))
              return jsonToolResult({
                results,
                provider: 'mempalace',
                query,
                ...(sessionKey ? { sessionKey, sessionScoped: true } : {}),
              })
            }
          } catch {
            // MemPalace 不可用，降级到 user_memory
          }
        }

        // 降级：从 user_memory 文本文档做关键词搜索
        const memory = await this.deps.config.getUserMemory?.()
        const content = memory?.content ?? ''
        if (!content.trim()) {
          return jsonToolResult({ results: [], provider: 'user-memory', note: 'empty memory document' })
        }
        const lines = content.split(/\r?\n/)
        const q = query.toLowerCase()
        const matched = lines
          .map((line, idx) => ({ line, idx }))
          .filter((row) => row.line.toLowerCase().includes(q))
          .slice(0, limit)
          .map((row) => ({
            content: row.line.trim(),
            line: row.idx + 1,
            score: 0.8,
            source: 'user_memory',
          }))
        return jsonToolResult({ results: matched, provider: 'user-memory', updatedAt: memory?.updatedAt })
      },
    }
    this.deps.toolRegistry.register(createMtBotTool(memorySearchTool, ctx))

    const memoryReadTool: MtBotToolConfig = {
      ...memoryReadToolConfig,
      execute: async (_id, rawParams) => {
        const drawerId = String((rawParams as { drawerId?: string }).drawerId ?? '').trim()
        if (!drawerId) {
          return jsonToolResult({ ok: false, message: 'drawerId is required' })
        }
        // MemPalace drawer_id 为内容寻址 16 位 hex（见 content-address.ts）
        if (!/^[a-f0-9]{16}$/i.test(drawerId)) {
          return jsonToolResult({ ok: false, message: 'drawerId 格式无效（应为 16 位十六进制）' })
        }
        const readDrawer = this.deps.config.readMempalaceDrawer
        if (!readDrawer) {
          return jsonToolResult({
            ok: false,
            message: 'MemPalace 未配置或不可用，无法读取归档原文',
          })
        }
        try {
          const detail = await readDrawer(drawerId)
          if (!detail) {
            return jsonToolResult({
              ok: false,
              drawerId,
              message: '未找到该 drawer，或 MemPalace 未安装/未运行',
            })
          }
          return jsonToolResult({
            ok: true,
            drawerId: detail.drawer_id,
            wing: detail.wing,
            room: detail.room,
            content: detail.content,
            metadata: detail.metadata,
            provider: 'mempalace',
          })
        } catch (err) {
          return jsonToolResult({
            ok: false,
            drawerId,
            message: err instanceof Error ? err.message : String(err),
          })
        }
      },
    }
    this.deps.toolRegistry.register(createMtBotTool(memoryReadTool, ctx))

    const profileMemoryTool: MtBotToolConfig = {
      ...profileMemoryToolConfig,
      execute: async (_id, rawParams) => {
        const p = rawParams as { action?: string; content?: string; section?: string }
        const action = (p.action ?? '').trim()
        if (action === 'read_memory') {
          const memory = await this.deps.config.getUserMemory?.()
          return jsonToolResult({
            ok: true,
            content: memory?.content ?? '',
            updatedAt: memory?.updatedAt,
          })
        }
        if (action === 'update_memory') {
          const content = (p.content ?? '').trim()
          if (!content) {
            return jsonToolResult({ ok: false, message: 'content is required for update_memory' })
          }
          const updated = await this.deps.config.updateUserMemory?.(content)
          return jsonToolResult({ ok: true, updatedAt: updated?.updatedAt })
        }
        if (action === 'append') {
          const block = (p.content ?? '').trim()
          if (!block) {
            return jsonToolResult({ ok: false, message: 'content is required for append' })
          }
          const existing = (await this.deps.config.getUserMemory?.())?.content ?? ''
          const next = existing.trim() ? `${existing.trimEnd()}\n\n${block}\n` : `${block}\n`
          const updated = await this.deps.config.updateUserMemory?.(next)
          return jsonToolResult({ ok: true, updatedAt: updated?.updatedAt })
        }
        if (action === 'remove_section') {
          const section = (p.section ?? '').trim()
          if (!section) {
            return jsonToolResult({ ok: false, message: 'section is required for remove_section' })
          }
          const existing = (await this.deps.config.getUserMemory?.())?.content ?? ''
          if (!existing.trim()) {
            return jsonToolResult({ ok: false, message: 'memory document is empty' })
          }
          const { content: next, removed } = removeMarkdownSection(existing, section)
          if (!removed) {
            return jsonToolResult({ ok: false, message: `section not found: ${section}` })
          }
          const updated = await this.deps.config.updateUserMemory?.(next)
          return jsonToolResult({ ok: true, removed: true, updatedAt: updated?.updatedAt })
        }
        if (action === 'get_preferences') {
          // 客户端 Runtime 暂无独立偏好配置，返回空偏好让 AI 直接使用记忆文档中的信息
          return jsonToolResult({
            ok: true,
            preferences: null,
            message: '暂无偏好配置，请参考用户记忆文档中的沟通规则章节',
          })
        }
        return jsonToolResult({ ok: false, message: `unknown action: ${action}` })
      },
    }
    this.deps.toolRegistry.register(createMtBotTool(profileMemoryTool, ctx))

    const systemPromptTool: MtBotToolConfig = {
      ...systemPromptToolConfig,
      execute: async (_id, rawParams) => {
        const p = rawParams as { action?: string; content?: string }
        const action = (p.action ?? '').trim()
        if (action === 'read' || action === 'soul_read') {
          const content = (await this.deps.config.getSoulContent?.()) ?? ''
          return jsonToolResult({ ok: true, isDefault: !content.trim(), content })
        }
        if (action === 'update' || action === 'soul_update') {
          const content = (p.content ?? '').trim()
          if (!content) {
            return jsonToolResult({ ok: false, message: 'content is required for update' })
          }
          // 写入用户 SOUL 内容（人格/风格/边界）
          const updated = await this.deps.config.updateSoulContent?.(content)
          return jsonToolResult({ ok: true, updatedAt: updated?.updatedAt })
        }
        if (action === 'reset') {
          const updated = await this.deps.config.updateSoulContent?.('')
          return jsonToolResult({ ok: true, updatedAt: updated?.updatedAt })
        }
        return jsonToolResult({ ok: false, message: `unknown action: ${action}` })
      },
    }
    this.deps.toolRegistry.register(createMtBotTool(systemPromptTool, ctx))

    const speechGenerateTool: MtBotToolConfig = {
      ...speechGenerateToolConfig,
      execute: async (_id, rawParams) => {
        const p = rawParams as { text?: string; speaker?: string; speed?: number }
        const text = String(p.text ?? '').trim()
        if (!text) {
          return jsonToolResult({ status: 'error', message: 'text 参数不能为空' })
        }
        if (!this.deps.config.generateVoiceFile) {
          return jsonToolResult({ status: 'error', message: 'TTS 功能未初始化，请确保语音模型已就绪' })
        }
        try {
          const speed =
            typeof p.speed === 'number' ? Math.max(0.8, Math.min(1.3, p.speed)) : undefined
          const filePath = await this.deps.config.generateVoiceFile(text, {
            speaker: p.speaker?.trim() || undefined,
            speed,
          })
          // 与 image_generate 同风格：防止路径编造
          const result = {
            status: 'ok' as const,
            filePath,
            note:
              `语音文件已生成。文件的唯一有效路径是 "${filePath}"。` +
              `引用、预览、发送或写入文档时，必须原样使用这个路径——` +
              `严禁根据语义自行编造文件名。`,
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            details: { filePath },
          }
        } catch (e) {
          return jsonToolResult({ status: 'error', message: `语音合成失败: ${(e as Error).message}` })
        }
      },
    }
    this.deps.toolRegistry.register(createMtBotTool(speechGenerateTool, ctx))

    const imageGenerateTool: MtBotToolConfig = {
      ...imageGenerateToolConfig,
      execute: async (_id, rawParams, _ctx, signal) => {
        const params = rawParams as {
          prompt?: string
          modelId?: string
          width?: number
          height?: number
          filename?: string
          referenceImagePaths?: string[]
        }
        if (!params.prompt || typeof params.prompt !== 'string') {
          return jsonToolResult({ status: 'error', message: 'prompt 参数不能为空' })
        }
        try {
          // 未显式指定模型时交给 bridge 按 image 槽配置决定（槽内可能是 rightapi 等自有命名空间的模型）；
          // 显式指定但不在已知白名单内的，同样原样透传，避免把自定义模型强行改写成 gpt-image-2。
          const requestedModelId = params.modelId?.trim()
          const resolvedModelId = requestedModelId
            ? isKnownImageGenerationModel(requestedModelId)
              ? normalizeImageModelId(requestedModelId)
              : requestedModelId
            : undefined
          const result = await this.deps.generateImage({
            prompt: params.prompt,
            modelId: resolvedModelId,
            width: params.width,
            height: params.height,
            filename: params.filename,
            referenceImagePaths: Array.isArray(params.referenceImagePaths)
              ? params.referenceImagePaths
              : undefined,
            signal,
          })
          // 在返回给模型的文本里强制回显真实路径并禁止编造文件名——
          // 弱模型常无视工具返回的 hash 文件名，自行编造 k8s-01-cover.png 之类语义路径写进文档。
          const echo = {
            status: 'ok' as const,
            ...result,
            note:
              `图片已生成并保存。文件的唯一有效路径是 "${result.filePath}"。` +
              `引用、预览、发送或写入文档时，必须原样使用这个路径——` +
              `严禁根据语义自行编造文件名（如 cover.png / img-01.png）。` +
              `如需迭代修改，请把上面的 revisedPrompt 与用户修改指令合并后再次调用本工具。`,
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(echo) }],
            details: result,
          }
        } catch (e) {
          const code = (e as { code?: string }).code ?? 'PROVIDER_ERROR'
          const message = (e as Error).message
          const aborted = code === 'ABORTED' || signal?.aborted || (e as Error).name === 'AbortError'
          if (aborted) {
            throw Object.assign(new Error('图片生成已被用户中断'), { code: 'ABORTED' })
          }
          // 必须 throw：pi-agent-core 只有异常才标记 isError，否则 UI 不报错且 LLM 可能再次调用本工具
          throw Object.assign(
            new Error(`图片生成失败（请勿自动重试）：${message}`),
            { code },
          )
        }
      },
    }
    this.deps.toolRegistry.register(createMtBotTool(imageGenerateTool, ctx))

    log.info('[registerToolOverrides] integration tools registered: message/memory/profile/system_prompt/tts_generate/image_generate')

    this.registerClientCommandTools(ctx)
  }

  /** 注册客户端命令工具（斜杠命令的 Agent 可调用版本） */
  private registerClientCommandTools(ctx: ToolExecutionContext): void {
    const ipcChannel = this.deps.ipcChannel
    const forwardIpcEvent = ipcChannel.forwardIpcEvent.bind(ipcChannel)
    const getConversationRepo = this.deps.getConversationRepo
    const getMemoryManager = this.deps.getMemoryManager

    // session_create — 通知渲染进程新建会话
    const sessionCreateConfig: MtBotToolConfig = {
      ...sessionCreateToolConfig,
      execute: async () => {
        forwardIpcEvent({ type: 'session:create-request' })
        return jsonToolResult({ ok: true, message: '已请求创建新会话' })
      },
    }
    this.deps.toolRegistry.register(createMtBotTool(sessionCreateConfig, ctx))

    // session_clear — 删除指定会话的所有消息
    const sessionClearConfig: MtBotToolConfig = {
      ...sessionClearToolConfig,
      execute: async (_id, rawParams) => {
        const { sessionKey } = rawParams as { sessionKey: string }
        const conversationRepo = getConversationRepo()
        if (!conversationRepo) return jsonToolResult({ ok: false, message: 'conversationRepo not initialized' })
        const messages = conversationRepo.loadRecentMessages(sessionKey, 5000)
        for (const msg of messages) {
          conversationRepo.deleteMessage(msg.id, sessionKey)
        }
        forwardIpcEvent({ type: 'session:cleared', sessionKey })
        return jsonToolResult({ ok: true, deletedCount: messages.length })
      },
    }
    this.deps.toolRegistry.register(createMtBotTool(sessionClearConfig, ctx))

    // session_compact — 压缩上下文
    const sessionCompactConfig: MtBotToolConfig = {
      ...sessionCompactToolConfig,
      execute: async (_id, rawParams) => {
        const { sessionKey, keepRecentTurns = 6 } = rawParams as { sessionKey: string; keepRecentTurns?: number }
        forwardIpcEvent({ type: 'session:compact-request', sessionKey, keepRecentTurns })
        return jsonToolResult({ ok: true, message: `已请求压缩会话 ${sessionKey}，保留最近 ${keepRecentTurns} 轮` })
      },
    }
    this.deps.toolRegistry.register(createMtBotTool(sessionCompactConfig, ctx))

    // session_resume — 切换到指定会话
    const sessionResumeConfig: MtBotToolConfig = {
      ...sessionResumeToolConfig,
      execute: async (_id, rawParams) => {
        const { sessionKey } = rawParams as { sessionKey: string }
        forwardIpcEvent({ type: 'session:switch-request', sessionKey })
        return jsonToolResult({ ok: true, message: `已请求切换到会话 ${sessionKey}` })
      },
    }
    this.deps.toolRegistry.register(createMtBotTool(sessionResumeConfig, ctx))

    // settings_think — 设置思考级别
    const settingsThinkConfig: MtBotToolConfig = {
      ...settingsThinkToolConfig,
      execute: async (_id, rawParams) => {
        const { level } = rawParams as { level: string }
        forwardIpcEvent({ type: 'settings:think-level', level })
        return jsonToolResult({ ok: true, level })
      },
    }
    this.deps.toolRegistry.register(createMtBotTool(settingsThinkConfig, ctx))

    // settings_backend — 切换 ACP 后端
    const settingsBackendConfig: MtBotToolConfig = {
      ...settingsBackendToolConfig,
      execute: async (_id, rawParams) => {
        const { backendId } = rawParams as { backendId: string }
        if (this.deps.config.setAcpBackend) {
          const result = await this.deps.config.setAcpBackend(backendId)
          if (!result.ok) return jsonToolResult({ ok: false, error: result.error })
        }
        forwardIpcEvent({ type: 'settings:backend-changed', backendId })
        return jsonToolResult({ ok: true, backendId })
      },
    }
    this.deps.toolRegistry.register(createMtBotTool(settingsBackendConfig, ctx))

    // info_status — 查询会话状态
    const infoStatusConfig: MtBotToolConfig = {
      ...infoStatusToolConfig,
      execute: async (_id, rawParams) => {
        const { sessionKey } = rawParams as { sessionKey: string }
        const conversationRepo = getConversationRepo()
        if (!conversationRepo) return jsonToolResult({ ok: false, message: 'conversationRepo not initialized' })
        const messages = conversationRepo.loadRecentMessages(sessionKey, 5000)
        const conv = conversationRepo.getConversation(sessionKey)
        return jsonToolResult({
          ok: true,
          sessionKey,
          messageCount: messages.length,
          title: conv?.title ?? null,
        })
      },
    }
    this.deps.toolRegistry.register(createMtBotTool(infoStatusConfig, ctx))

    // memory_manage — 工作记忆单条增删改 + list/clear
    const resolveAgentId = (toolCallId: string): string => {
      const instanceId =
        this.deps.toolCallInstanceMap.get(toolCallId) ?? this.deps.getCurrentToolExecutorInstanceId()
      return (instanceId && this.deps.getDefinitionIdByInstanceId(instanceId)) ?? 'default'
    }
    const memoryManageConfig: MtBotToolConfig = {
      ...memoryManageToolConfig,
      execute: async (toolCallId, rawParams) => {
        const p = rawParams as {
          action: string
          id?: string
          content?: string
          category?: 'project' | 'reference' | 'general'
          importance?: number
        }
        const memoryManager = getMemoryManager()
        if (!memoryManager) return jsonToolResult({ ok: false, message: 'memoryManager not initialized' })
        const agentId = resolveAgentId(toolCallId)
        const userId = 'local-user'

        switch (p.action) {
          case 'list': {
            const entries = memoryManager.listActive(agentId, userId)
            return jsonToolResult({
              ok: true,
              agentId,
              count: entries.length,
              entries: entries.map((e) => ({ id: e.id, category: e.category, content: e.content })),
            })
          }
          case 'add': {
            const content = (p.content ?? '').trim()
            if (!content) return jsonToolResult({ ok: false, message: 'content is required for add' })
            const entry = memoryManager.addMemory({
              agentId,
              userId,
              category: p.category ?? 'general',
              content,
              importance: p.importance,
            })
            return jsonToolResult({ ok: true, id: entry.id, category: entry.category })
          }
          case 'update': {
            const id = (p.id ?? '').trim()
            const content = (p.content ?? '').trim()
            if (!id) return jsonToolResult({ ok: false, message: 'id is required for update' })
            if (!content) return jsonToolResult({ ok: false, message: 'content is required for update' })
            memoryManager.updateMemory(id, content)
            return jsonToolResult({ ok: true, id })
          }
          case 'delete': {
            const id = (p.id ?? '').trim()
            if (!id) return jsonToolResult({ ok: false, message: 'id is required for delete' })
            memoryManager.deleteMemory(id)
            return jsonToolResult({ ok: true, id })
          }
          case 'archive': {
            const id = (p.id ?? '').trim()
            if (!id) return jsonToolResult({ ok: false, message: 'id is required for archive' })
            memoryManager.archiveMemory(id)
            return jsonToolResult({ ok: true, id })
          }
          case 'clear': {
            const deletedCount = memoryManager.clearAllForAgent(agentId, userId)
            return jsonToolResult({ ok: true, agentId, deletedCount })
          }
          default:
            return jsonToolResult({ ok: false, message: `unknown action: ${p.action}` })
        }
      },
    }
    this.deps.toolRegistry.register(createMtBotTool(memoryManageConfig, ctx))

    log.info('[registerClientCommandTools] client command tools registered')
    this.registerAgentManagementTools(ctx)
  }

  /** 注册 Agent 团队管理工具（生成/优化/移除自定义 Agent） */
  private registerAgentManagementTools(ctx: ToolExecutionContext): void {
    // agent_team_generate — 批量 fork 系统 Agent 创建团队
    const agentTeamGenerateConfig: MtBotToolConfig = {
      ...agentTeamGenerateToolConfig,
      execute: async (_id, rawParams) => {
        const { agents } = rawParams as {
          teamDescription: string
          agents: Array<{ systemAgentId: string; name: string; description?: string }>
        }
        if (!this.deps.config.forkAgent) return jsonToolResult({ ok: false, error: 'forkAgent not configured' })
        const results: Array<{ name: string; agentId?: string; ok: boolean; error?: string }> = []
        for (const agent of agents) {
          const res = await this.deps.config.forkAgent(agent.systemAgentId, {
            name: agent.name,
            description: agent.description,
          })
          results.push({ name: agent.name, agentId: res.agentId, ok: res.ok, error: res.error })
        }
        const succeeded = results.filter(r => r.ok).length
        this.deps.ipcChannel.forwardIpcEvent({ type: 'agent:team:generated', agents: results })
        return jsonToolResult({ ok: true, created: succeeded, total: agents.length, results })
      },
    }
    this.deps.toolRegistry.register(createMtBotTool(agentTeamGenerateConfig, ctx))

    // agent_team_optimize — 批量更新 Agent 配置
    const agentTeamOptimizeConfig: MtBotToolConfig = {
      ...agentTeamOptimizeToolConfig,
      execute: async (_id, rawParams) => {
        const { agentUpdates, reason } = rawParams as {
          agentUpdates: Array<{ agentId: string; name?: string; description?: string; soulContent?: string }>
          reason?: string
        }
        if (!this.deps.config.updateAgent) return jsonToolResult({ ok: false, error: 'updateAgent not configured' })
        const results: Array<{ agentId: string; ok: boolean; error?: string }> = []
        for (const update of agentUpdates) {
          const { agentId, ...data } = update
          const res = await this.deps.config.updateAgent(agentId, data as Record<string, unknown>)
          results.push({ agentId, ok: res.ok, error: res.error })
        }
        const succeeded = results.filter(r => r.ok).length
        this.deps.ipcChannel.forwardIpcEvent({ type: 'agent:team:optimized', agentIds: results.filter(r => r.ok).map(r => r.agentId) })
        return jsonToolResult({ ok: true, updated: succeeded, total: agentUpdates.length, reason, results })
      },
    }
    this.deps.toolRegistry.register(createMtBotTool(agentTeamOptimizeConfig, ctx))

    // agent_remove — 删除自定义 Agent
    const agentRemoveConfig: MtBotToolConfig = {
      ...agentRemoveToolConfig,
      execute: async (_id, rawParams) => {
        const { agentId, agentName } = rawParams as { agentId: string; agentName?: string }
        if (!this.deps.config.deleteAgent) return jsonToolResult({ ok: false, error: 'deleteAgent not configured' })
        const res = await this.deps.config.deleteAgent(agentId)
        if (res.ok) {
          this.deps.ipcChannel.forwardIpcEvent({ type: 'agent:removed', agentId })
        }
        return jsonToolResult({ ok: res.ok, agentId, agentName, error: res.error })
      },
    }
    this.deps.toolRegistry.register(createMtBotTool(agentRemoveConfig, ctx))

    log.info('[registerAgentManagementTools] agent management tools registered')
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
