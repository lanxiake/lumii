/**
 * AgentRuntimeBridge prompt 分发器
 *
 * 拆自 bridge.ts。封装 prompt / steer / abort / abortWithChildren / abortSession
 * 以及微信会话上下文（currentWeixinCtx / weixinMessageSentViaTool）。
 *
 * 不持有数据库/Agent 实例的拥有权，全部通过 deps 注入引用。
 */

import crypto from 'node:crypto'
import {
  type AgentRegistry,
  type AgentRuntimeFeatureFlags,
  type ConversationRepo,
  type FileChangeEntry,
  type ModelRouter,
  type PromptSectionStat,
  type SkillActivationHint,
  type SkillInfo,
  type CustomAgentInfo,
  type PromptStyle,
  applyToolDefinitionStyle,
  resolveSkillActivations,
  estimateTokenCount,
  microcompactToolResults,
  proactivePrune,
  DEFAULT_COMPACTION_TRIGGER_RATIO,
  diffTurnSnapshots,
} from '@mtbot/agent-runtime'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ContextUsageBreakdownEntry } from '../../shared/agent-runtime-events'
import { computeContextBudget } from '../../shared/context-budget'
import { recordToolExposure } from '../tool-exposure-store'
import { UNKNOWN_CHANNEL } from '../tool-usage-store'
import { estimateToolTokens, type ToolDefinitionLite } from './context-usage-breakdown'
import { resolveChannelIdentity } from '../channel/channel-identity'
import type { AgentRuntimeBridgeConfig } from './bridge'
import type { InstanceState, InstanceStateStore } from './bridge-instance-state'
import type { BridgeSessionModelCatalog } from './bridge-session-model-catalog'
import type { BridgePromptComposer } from './bridge-prompt-composer'
import type { BridgeRendererIpcChannel } from './bridge-renderer-ipc'
import type { BridgeImageServices } from './bridge-image-services'
import type { BridgeContextCompactor } from './bridge-context-compactor'
import type { BridgeInstanceFactory } from './bridge-instance-factory'
import type { RunContext } from './event-converter'
import { agentRuntimeLog as log } from './bridge-utils'
import type { RouterService } from './router/router-service'
import type { RouterHitRateTracker } from './router/router-hit-rate-tracker'
import { toRouterResultLite, type RouterAgentInfo, type RouterSkillInfo } from './router/types'
import { summarizeRecentTurns } from './router/recent-turns-summarizer'
import { classifyImageModel, IMAGE_MODEL_SIMPLE } from './image-intent-classifier'
import type { RouterLlmCaller } from './router/llm-caller'
import { getVcsService } from './vcs-accessor'
import {
  clearTurnTouchedPaths,
  recordTurnTouchedFilePath,
  resolveTurnFileChanges,
} from './turn-touched-paths'

export type WeixinCtxValue = {
  channelUserId: string
  contextToken: string
  botToken?: string
  ilinkBaseUrl?: string
}

export interface BridgePromptDispatcherDeps {
  agentRegistry: AgentRegistry
  instanceStates: InstanceStateStore
  instanceToConversation: Map<string, string>
  instanceToRootSessionKey: Map<string, string>
  sessionModelCatalog: BridgeSessionModelCatalog
  promptComposer: BridgePromptComposer
  featureFlags: AgentRuntimeFeatureFlags
  ipcChannel: BridgeRendererIpcChannel
  imageServices: BridgeImageServices
  compactor: BridgeContextCompactor
  instanceFactory: BridgeInstanceFactory
  modelRouter: ModelRouter
  config: AgentRuntimeBridgeConfig
  getSkillEvolutionEngine: () => import('../../plugins/builtin/skill-evolution/engine').SkillEvolutionEngine | undefined
  /** 工具进化审批回复消费（可选，未装配时跳过） */
  getToolEvolutionEngine?: () => import('./bash-tool-evolution/tool-evolution-engine').ToolEvolutionEngine | null
  getConversationRepo: () => ConversationRepo | null
  /**
   * 读会话归属渠道（`conversations.channel_type`，查不到返回 null）。
   *
   * 暴露记录的用途是回答「按 (agent, 渠道) 分组后该常驻什么工具」，
   * 而渠道此前只活在 conversation_id 的字符串前缀里。解析器已有
   * （`channel-identity.ts` 的 `resolveChannelIdentity`），这里只需拿到落库值。
   */
  getConversationOwnership?: (conversationId: string) => string | null
  /**
   * 按模型 id 取标定的字符/token 比（由真实回执反推，持久化在 runtime_state）。
   *
   * **不传会话 key 而传模型 id**：会话级的 `sessionLastModelId` 是进程内 Map，
   * 重启后为空——那会让重启后的第一次暴露记录退回权重法，与日志差 2.4 倍
   * （实测 22498 vs 9191）。按模型 id 取则一直有效（标定值落库）。
   */
  resolveCharsPerToken?: (modelId: string | undefined) => number | undefined
  /**
   * 会话整窗用量与分类明细（用于把自动压缩阈值扣掉固定开销后再算）。
   * 无活跃实例时返回的 breakdown 为 undefined，预算计算会退化为整窗口径。
   */
  getSessionContextUsage?: (
    sessionKey: string,
    opts?: { withBreakdown?: boolean },
  ) => {
    usedTokens: number
    contextWindow: number
    triggerThreshold: number
    breakdown?: readonly ContextUsageBreakdownEntry[]
  }
  /**
   * Pre-LLM Router 服务（可选）。
   * - 提供时：每轮 prompt 会先调用 Router 筛选 top Agent/Skill，注入主 prompt
   * - 不提供时：走旧路径（主 LLM 看完整 skills/customAgents 清单）
   */
  routerService?: RouterService
  /** Router 命中率追踪器（可选，与 routerService 配套） */
  routerHitRateTracker?: RouterHitRateTracker
  /** Router 所需：getter，避免在 prompt-dispatcher 拉一次 / 在 instance-factory 拉一次 */
  getSkillsSnapshot?: () => Promise<readonly SkillInfo[]>
  getCustomAgentsSnapshot?: () => Promise<readonly CustomAgentInfo[]>
  /**
   * 生图意图分类用的轻量 LLM 调用器（可选）。
   * 提供时：用户选择通用生图入口（gpt-image-2）会按需求复杂度自动升级到 pro；
   * 不提供时：直接用用户选择的生图模型，不做自动分级。
   */
  imageIntentLlmCaller?: RouterLlmCaller
}

/**
 * 段级计量日志（P0-T3）：info 汇总 + debug 逐段；sectionStats 缺失时静默跳过。
 * 段 ID 与元数据见 @mtbot/agent-runtime 的 PROMPT_SECTIONS。
 */
function logPromptSections(
  instanceId: string,
  stats: readonly PromptSectionStat[] | undefined,
  style?: PromptStyle,
): void {
  if (!stats?.length) return
  const totalChars = stats.reduce((n, s) => n + s.chars, 0)
  log.info(
    `[prompt-section] instanceId=${instanceId} sections=${stats.length} totalChars=${totalChars}${style ? ` style=${style}` : ''}`,
  )
  for (const s of stats) {
    log.debug(`[prompt-section] id=${s.id} zone=${s.zone} chars=${s.chars}`)
  }
}

export class BridgePromptDispatcher {
  /** 图片生成专用模型的关键词列表（非对话模型，不支持工具调用） */
  private static readonly IMAGE_GENERATION_MODEL_PATTERNS = [
    'gpt-image-2', 'gpt-image-2-vip', 'dall-e-3', 'dall-e-2',
    'nano-banana', 'gemini-3-pro-image', 'gemini-2.5-flash-image', 'imagen',
  ]

  /** 当前活跃的微信会话上下文（由 index.ts 在处理消息前注入，供 message 工具发送时使用） */
  private currentWeixinCtx: WeixinCtxValue | null = null

  /** 本轮是否已通过 message 工具成功发送微信消息（用于避免 adapter 重复发送文本回复） */
  private weixinMessageSentViaTool = false

  /**
   * 直接生图路径（图片模型拦截）的可中断控制器。
   * key = sessionKey（无 sessionKey 时用 instanceId）。
   * 这条路径绕过 pi-agent-core，instance.abort() 拦不住它，需要独立的 AbortController。
   */
  private readonly directImageAborts = new Map<string, AbortController>()

  constructor(private readonly deps: BridgePromptDispatcherDeps) {}

  /** 中断指定 key（sessionKey 或 instanceId）下进行中的直接生图轮询。返回是否命中。 */
  private abortDirectImage(key: string): boolean {
    const ctrl = this.directImageAborts.get(key)
    if (!ctrl) return false
    ctrl.abort()
    // 同一控制器可能注册在多个 key 下（rootSessionKey/sessionKey/instanceId），一并清理
    for (const [k, c] of [...this.directImageAborts.entries()]) {
      if (c === ctrl) this.directImageAborts.delete(k)
    }
    log.info(`[abortDirectImage] aborted direct image generation: key=${key}`)
    return true
  }

  /**
   * 设置当前活跃的微信会话上下文（每次处理消息前调用）。
   * message 工具在 channel=weixin 时会读取此上下文来发送回复。
   */
  setWeixinMessageContext(ctx: WeixinCtxValue | null): void {
    this.currentWeixinCtx = ctx
    if (ctx) {
      // 新一轮消息开始，重置标志
      this.weixinMessageSentViaTool = false
    }
    log.info(`[setWeixinMessageContext] 已${ctx ? `设置 channelUserId=${ctx.channelUserId}` : '清除'}微信上下文`)
  }

  /** 本轮是否已通过 message 工具成功发送微信消息 */
  getWeixinMessageSentViaTool(): boolean {
    return this.weixinMessageSentViaTool
  }

  /** 供 BridgeToolRegistrar 使用的 weixinCtx accessor */
  getCurrentWeixinCtxRaw(): WeixinCtxValue | null {
    return this.currentWeixinCtx
  }

  /** 标记本轮已通过 message 工具发送微信消息（供 ToolRegistrar 调用） */
  markWeixinMessageSentViaTool(): void {
    this.weixinMessageSentViaTool = true
  }

  /**
   * 记一行「本轮模型看到了哪些工具」（`tool_exposure_log`）。
   *
   * 三条取舍：
   * - **取 `instance.getTools()`**：那是送进请求的那一份（已含极简档裁剪），
   *   不是另算的视图。记别的东西就会出现「日志里说暴露了 A、模型实际没收到 A」。
   * - **渠道走落库值优先 + 前缀回退**（`resolveChannelIdentity`），与
   *   `tool_usage_stats` 的渠道口径同源，否则两张表对不上。
   * - **token 与 `contextUsage` 明细同口径**（都按标定 charsPerToken 换算），
   *   这样两个数才能对账（实测口径不一致时差 2.4 倍）。
   * - **失败静默**：调用点在主路径上，统计不能挡住用户发消息。
   */
  private recordExposure(
    instanceId: string,
    turnId: string | undefined,
    modelId: string | undefined,
  ): void {
    try {
      const instance = this.deps.agentRegistry.get(instanceId)
      // `getTools` 在测试替身里可能不存在；没有它就没法回答「暴露了什么」，跳过而不是编
      if (!instance || typeof instance.getTools !== 'function') return
      const sessionKey = this.deps.instanceToConversation.get(instanceId) ?? ''
      // 没有会话 key 时**不调** resolveChannelIdentity：它对空串会返回 'ipc'
      // （前缀回退的缺省值），而那正是「不猜 ipc」要禁止的事。
      const channel = sessionKey
        ? resolveChannelIdentity(
            sessionKey,
            this.deps.getConversationOwnership?.(sessionKey) ?? null,
          ).ownership
        : UNKNOWN_CHANNEL
      const allTools = instance.getTools()
      // 目标实例状态在**本轮结束时**才读——`tool_search` 的加载发生在 `prompt()` 内部，
      // 此刻 `loadedBySearch` 已是本轮全部命中。先取快照再清零，供下面补记 search 行。
      const loadedBySearch = new Set(
        this.deps.instanceStates.get(instanceId)?.loadedBySearch ?? [],
      )
      this.deps.instanceStates.get(instanceId)?.loadedBySearch?.clear()

      recordToolExposure({
        sessionKey,
        turnId: turnId ?? null,
        agentId: instance.definitionId,
        channel,
        tools: allTools.map((t) => ({
          n: t.name,
          t: estimateToolTokens(
            t as unknown as ToolDefinitionLite,
            this.deps.resolveCharsPerToken?.(modelId),
          ),
        })),
      })

      // P2：本轮若有 `tool_search` 命中装载，补记一行 `reason='search'`。
      //
      // **偏差（如实标注）**：设计 §6 想要「同 turn_id 下先 turn 行、后 search 行」的时序证据。
      // 这本做不到——P0 刻意把暴露行放在 `instance.prompt()` **之后**（要等 `ctx.resolvedModelId`
      // 落到 streamFn 才知道该用哪个标定比），而 search 装载发生在 prompt 内部。所以这里的
      // search 行记的是「本轮被捞回来、且此刻仍在装载集里」的工具名与 token 数，
      // **不是**装载前/后的差值。它足以回答「模型有没有自己把折叠的工具捞回来」，
      // 但对不上「turn 行 + search 行 == 轮末全量」这条会计恒等式。
      const added = allTools.filter((t) => loadedBySearch.has(t.name))
      if (added.length > 0) {
        recordToolExposure({
          sessionKey,
          turnId: turnId ?? null,
          agentId: instance.definitionId,
          channel,
          reason: 'search',
          tools: added.map((t) => ({
            n: t.name,
            t: estimateToolTokens(
              t as unknown as ToolDefinitionLite,
              this.deps.resolveCharsPerToken?.(modelId),
            ),
          })),
        })
      }
    } catch (err) {
      log.warn(`[prompt] 暴露记录写入失败（已忽略）: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 捕获直接生图轮次的工作区起点；失败时不阻断生图。
   *
   * 必须先清空上一轮的归属记录：这条路径在正常 prompt 清理之前就 return，
   * 不清理会让上一轮登记的路径被 stat 合成进本轮变更。
   */
  private async captureDirectImageTurnStart(state: InstanceState | undefined): Promise<void> {
    if (!state) return
    clearTurnTouchedPaths(state.ctx.instanceId)
    try {
      state.turnSnapshotStart = (await getVcsService()?.captureTurnSnapshot(this.deps.config.getCwd())) ?? new Map<string, string>()
    } catch (err) {
      state.turnSnapshotStart = undefined
      log.warn(`[turn-snapshot] direct image start failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 完成直接生图轮次快照并返回净变更，同时确保起点不会污染下一轮。
   *
   * 直连生图绕过写文件工具，产出的图片路径由调用方先登记。快照失败或起点缺失时
   * 仍用已登记路径兜底，保证「图片生成了但变更卡片没有」不再发生。
   */
  private async finishDirectImageTurnSnapshot(
    state: InstanceState | undefined,
  ): Promise<FileChangeEntry[] | undefined> {
    const turnSnapshotStart = state?.turnSnapshotStart
    if (state) state.turnSnapshotStart = undefined
    const instanceId = state?.ctx.instanceId
    const cwd = this.deps.config.getCwd()

    let diff: FileChangeEntry[] = []
    let diffAuthoritative = false
    if (turnSnapshotStart) {
      try {
        const turnSnapshotEnd = (await getVcsService()?.captureTurnSnapshot(cwd)) ?? new Map<string, string>()
        diff = diffTurnSnapshots(turnSnapshotStart, turnSnapshotEnd)
        diffAuthoritative = true
      } catch (err) {
        log.warn(`[turn-snapshot] direct image end failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    if (!instanceId) return undefined
    try {
      const resolved = await resolveTurnFileChanges(instanceId, diff, cwd, {
        ...(turnSnapshotStart ? { snapshotStart: turnSnapshotStart } : {}),
        diffAuthoritative,
      })
      return resolved.length > 0 ? resolved : undefined
    } catch (err) {
      log.warn(`[turn-snapshot] direct image resolve failed: ${err instanceof Error ? err.message : String(err)}`)
      return undefined
    }
  }

  /**
   * 发送消息给指定 Agent
   *
   * @param instanceId Agent 实例 ID
   * @param message 用户消息纯文本（可包含 [media attached: path] 等标记）
   * @param imageAttachmentPaths 可选：图片附件的 workspace 绝对路径列表。
   *   传入后会读盘 → base64 → 构造 ImageContent[] 作为多模态 UserMessage 一部分，
   *   仅当目标模型支持视觉输入时由调用方填充。
   * @param pendingUserMsgId 可选：本轮正在处理、已先行持久化到 DB 的用户消息 id。
   *   自动压缩块从 DB 重载历史做剪枝/摘要时必须排除它——否则该消息会被
   *   replaceMessages 注入实例内存、又被 instance.prompt() 追加一次，发送给
   *   LLM 的末尾出现两条相同 user 消息（与 restoreHistoryForInstance 的
   *   excludeMessageId 同一防重复机制）。
   */
  async prompt(
    instanceId: string,
    message: string,
    imageAttachmentPaths?: readonly string[],
    pendingUserMsgId?: string,
  ): Promise<void> {
    log.info(
      `[prompt] start: instanceId=${instanceId}, message="${message.slice(0, 100)}", imageCount=${imageAttachmentPaths?.length ?? 0}`,
    )
    const instance = this.deps.agentRegistry.get(instanceId)
    if (!instance) {
      log.error(`[prompt] instance not found: ${instanceId}`)
      throw new Error(`Agent instance not found: ${instanceId}`)
    }

    const state = this.deps.instanceStates.get(instanceId)
    if (state) {
      state.lastActivityAt = Date.now()
      // 新 prompt 开轮：清除上一轮锁定，允许本轮按最新会话偏好重新钉死
      if (state.ctx) state.ctx.pinnedStreamModelRef = undefined
    }

    // 上一轮 abort/error 后 pi 循环可能尚未退出；短等空闲，避免 "already processing"
    if (instance.state === 'running' || instance.state === 'aborted' || instance.state === 'error') {
      try {
        await Promise.race([
          instance.waitForIdle(),
          new Promise<void>((resolve) => setTimeout(resolve, 2500)),
        ])
      } catch (err) {
        log.warn(`[prompt] waitForIdle: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    // 每轮发消息前刷新动态部分（用户记忆 + 活跃任务），确保 AI 拿到最新内容
    const stateForRebuild = this.deps.instanceStates.get(instanceId)
    let baseResult = stateForRebuild?.basePrompt
    /** 本轮实际使用的提示词风格（用于完整提示词打印日志；未重建时保持 undefined） */
    let turnPromptStyle: PromptStyle | undefined

    // 获取用户当前选择的模型 ID（用于 Runtime section 实时更新）
    const ctx = stateForRebuild?.ctx
    const currentModelId = ctx ? this.resolveCurrentModelId(ctx) : undefined

    // 每轮都通过 rebuilder 重建基础提示词，确保 Runtime section 中的 model= 实时反映用户选择
    const rebuilder = stateForRebuild?.promptRebuilder
    if (rebuilder) {
      try {
        // ─── Pre-LLM Router 调用（每轮） ──────────────────────────
        // 失败时返回 fallback 标识非 "none" 的结果，主 prompt builder 会自动走旧路径
        let routerLite: import('@mtbot/agent-runtime').RouterResultLite | undefined
        if (this.deps.routerService) {
          try {
            const [allSkills, allAgents] = await Promise.all([
              this.deps.getSkillsSnapshot?.() ?? Promise.resolve(stateForRebuild?.skillsSnapshot ?? []),
              this.deps.getCustomAgentsSnapshot?.() ?? Promise.resolve([] as readonly CustomAgentInfo[]),
            ])
            const conversationIdForRouter = this.deps.instanceToConversation.get(instanceId)
            const recentTurns = summarizeRecentTurns(
              this.deps.getConversationRepo(),
              conversationIdForRouter,
              3,
            )
            const routerResult = await this.deps.routerService.route({
              userInput: message,
              recentTurns,
              availableAgents: allAgents.map(toRouterAgentInfo),
              availableSkills: allSkills.map(toRouterSkillInfo),
            })
            routerLite = toRouterResultLite(routerResult)
            this.deps.routerHitRateTracker?.record(instanceId, routerResult)
            log.info(
              `[prompt] router: intent=${routerResult.intent} confidence=${routerResult.confidence.toFixed(2)} ` +
                `agents=${routerResult.topAgents.length} skills=${routerResult.topSkills.length} ` +
                `fallback=${routerResult.fallback} duration=${routerResult.durationMs}ms`,
            )
          } catch (err) {
            // Router 不应抛错（service 内部已 catch），但留兜底
            log.warn(`[prompt] router 调用意外异常（继续走旧路径）: ${String(err)}`)
          }
        }

        // v12 Skill Activation：当 feature flag 开启时，基于用户输入重算 activations
        // 灰度：`ENABLE_SKILL_ACTIVATION_FOR` 命中本 Agent 定义 id 时也走这条路，
        // 全局开关保持默认 false（理由见 feature-flags.ts 的字段注释）。
        // 名单用 `?.` 读：宿主/测试可以只覆盖它关心的那几个 flag，缺字段时不该炸。
        const skillActivationOn =
          this.deps.featureFlags.ENABLE_SKILL_ACTIVATION ||
          (this.deps.featureFlags.ENABLE_SKILL_ACTIVATION_FOR?.includes(
            instance.definitionId,
          ) ??
            false)
        let hints: readonly SkillActivationHint[] = []
        if (skillActivationOn) {
          const skillsSnap = state?.skillsSnapshot
          if (skillsSnap && skillsSnap.length > 0) {
            hints = resolveSkillActivations({ userInput: message, skills: skillsSnap })
            if (hints.length > 0) {
              log.info(
                `[prompt] Skill activations: ${hints
                  .map((h) => `${h.skillName}(${h.tier},${h.reason})`)
                  .join(', ')}`,
              )
            }
          }
        }
        // 提示词风格（实验功能）：每轮读取最新设置；pi 每轮快照系统提示词，故下一轮对话生效
        turnPromptStyle = (await this.deps.config.getPromptStyleSettings?.())?.style
        // 极简档工具定义裁剪：与提示词同口径逐轮应用（仅样式变化时 setTools，避免无谓替换）
        if (
          stateForRebuild?.originalToolDefs &&
          turnPromptStyle &&
          stateForRebuild.appliedToolDefStyle !== turnPromptStyle
        ) {
          const targetInstance = this.deps.agentRegistry.get(instanceId)
          if (targetInstance) {
            const rebuilt = applyToolDefinitionStyle(stateForRebuild.originalToolDefs, turnPromptStyle)
            // P2：`originalToolDefs` 是**创建时**的工具集，不含之后 `tool_search` 捞回的工具。
            // 换风格时若整份替换，会把它们悄悄丢掉——模型下一轮又"看不见"了，
            // 而它并没有做错任何事。所以把已装载的按名补回（对象取现实例里的那份）。
            // 无装载时**不碰** `getTools()`：多数实例（与测试替身）没有它，白调会把
            // 整个重建块拖进 catch。
            const loaded = state?.loadedBySearch
            const keep =
              loaded && loaded.size > 0 && typeof targetInstance.getTools === 'function'
                ? targetInstance
                    .getTools()
                    .filter((t) => loaded.has(t.name) && !rebuilt.some((r) => r.name === t.name))
                : []
            targetInstance.setTools([...rebuilt, ...keep])
            stateForRebuild.appliedToolDefStyle = turnPromptStyle
          }
        }
        baseResult = rebuilder(hints, currentModelId, routerLite, turnPromptStyle)
        if (state) state.basePrompt = baseResult
        logPromptSections(instanceId, baseResult.sectionStats, turnPromptStyle)
      } catch (err) {
        log.error('[prompt] 重建系统提示词失败（回退缓存提示词）:', err)
      }
    }

    if (baseResult) {
      const injSettings = (await this.deps.config.getMemoryInjectionSettings?.()) ?? {
        injectPersonalMemory: true,
        injectWorkMemory: true,
      }
      instance.setMemoryInjectionFlags({
        injectWorkMemory: injSettings.injectWorkMemory !== false,
      })
      const freshPrompt = await this.deps.promptComposer.buildPromptWithMemory(
        instanceId,
        baseResult,
        injSettings,
        message,
      )
      instance.setSystemPrompt(freshPrompt)
      log.info(`[prompt] 已刷新系统提示词（记忆+任务+模型）instanceId=${instanceId}, model=${currentModelId ?? 'default'}`)
      // 实验观测（提示词风格实验 P1-T5）：转储真实送入 LLM 的完整系统提示词（记忆注入后的最终形态），
      // 供 CLI 套件与人工日志分析提示词编排；begin/end 标记便于脚本截取块内容。
      const styleLabel = turnPromptStyle ?? 'detailed'
      log.info(
        `[llm-prompt] instanceId=${instanceId} style=${styleLabel} chars=${freshPrompt.length} ` +
          `static=${baseResult.staticPrompt.length} dynamic=${baseResult.dynamicPrompt.length}`,
      )
      log.info(`[llm-prompt:full:begin] instanceId=${instanceId} style=${styleLabel}`)
      log.info(freshPrompt)
      log.info(`[llm-prompt:full:end] instanceId=${instanceId}`)
    }

    // 自动压缩：在发送消息前检查当前消息历史 token 预算，超过触发阈值时触发异步压缩
    // 这是 transformContext（LLM 调用前）之外的第二道防线，专门处理单轮工具结果过大的情况
    const sessionKey = this.deps.instanceToConversation.get(instanceId)
    const conversationRepo = this.deps.getConversationRepo()
    if (sessionKey && conversationRepo) {
      const rootSessionKey = this.deps.instanceToRootSessionKey.get(instanceId) ?? sessionKey
      try {
        const comp = this.deps.sessionModelCatalog.getCompactionForRootSession(rootSessionKey)
        // 排除本轮正在处理的 user 消息：它已由 handleUserSend 落库（is_streaming=0），
        // 不排除会进入剪枝结果被 replaceMessages 注入内存，随后 instance.prompt()
        // 又追加一次 → 发送给 LLM 的末尾两条相同 user 消息。
        const historyMessages = conversationRepo.loadMessagesAsPiFormat(sessionKey, {
          limit: 500,
          ...(pendingUserMsgId ? { excludeMessageId: pendingUserMsgId } : {}),
        }) as AgentMessage[]
        const thinkingMsgCount = (historyMessages as any[]).filter(m =>
          Array.isArray(m.content) && m.content.some((b: any) => b.type === "thinking")
        ).length
        if (thinkingMsgCount > 0) {
          log.info(`[prompt] 历史消息含 thinking block: count=${thinkingMsgCount}, sessionKey=${sessionKey}`)
        }
        const estimatedTokens = estimateTokenCount(historyMessages)
        // estimatedTokens 只含对话历史，阈值必须扣掉固定开销（系统提示+工具+MCP）后再算：
        // 按整窗 ×ratio 当阈值时，对话要涨到 156K 才触发，而 MCP 占 150K 的会话在 25K 就爆窗。
        const usage = this.deps.getSessionContextUsage?.(rootSessionKey)
        const budget = computeContextBudget(
          usage?.usedTokens ?? estimatedTokens,
          comp.contextWindow,
          usage?.breakdown,
          comp.outputReserveTokens,
        )
        // 阈值取会话解析出的比例（getSessionContextUsage 的 triggerThreshold），
        // 不要在这里另写常量——同一条链路上留两处来源，迟早像占用条那样出现
        // 显示 78%、实际按 80% 判断的分叉。
        const triggerRatio = usage?.triggerThreshold ?? DEFAULT_COMPACTION_TRIGGER_RATIO
        const autoCompactThreshold = Math.floor(budget.budget * triggerRatio)
        if (estimatedTokens > autoCompactThreshold && historyMessages.length > 4) {
          log.info(
            `[prompt] 自动压缩触发: estimatedTokens=${estimatedTokens} > threshold=${autoCompactThreshold} ` +
              `(可压缩预算 ${budget.budget} × ${triggerRatio}, 固定开销=${budget.fixedOverhead}/${comp.contextWindow}), sessionKey=${sessionKey}`,
          )
          if (budget.exhausted) {
            log.warn(
              `[prompt] 固定开销 ${budget.fixedOverhead} 已挤满 ${comp.contextWindow} 窗口，压缩无法回收空间；` +
                `请在设置中禁用部分 MCP server 或改用更大窗口的模型。sessionKey=${sessionKey}`,
            )
          }

          // ─── 第一档：ProactivePrune 三阶段确定性剪枝（Dedup+Summarize+Truncate） ───
          // 与 agent-runtime transformContext 管线同一策略（0.48×窗口触发，7 道 Gate 内置）。
          // 纯本地无 LLM 成本；结果只注入实例内存当轮生效（不落库，与 transformContext
          // 语义一致），每轮从 DB 重载完整历史后重新剪枝（幂等）。
          const pruned = proactivePrune(historyMessages, {
            contextWindow: comp.contextWindow,
            protectLastN: 20,
            keepRecentToolResults: 20,
          })
          let workingMessages = historyMessages
          let workingTokens = estimatedTokens
          if (pruned.changed) {
            workingMessages = pruned.messages
            workingTokens = estimateTokenCount(workingMessages)
            log.info(
              `[prompt] ProactivePrune 剪枝成功: 回收 ${pruned.reclaimedTokens} tokens` +
                ` (dedup=${pruned.passStats.dedupedCount}, summarize=${pruned.passStats.summarizedCount}, ` +
                `truncate=${pruned.passStats.truncatedArgsCount}), ${estimatedTokens} → ${workingTokens}, sessionKey=${sessionKey}`,
            )
            instance.replaceMessages(workingMessages)
          } else if (pruned.reclaimedTokens > 0) {
            log.info(
              `[prompt] ProactivePrune Reclaim Gate 拦截: 回收 ${pruned.reclaimedTokens} tokens < 门槛, 不提交` +
                ` (dedup=${pruned.passStats.dedupedCount}, summarize=${pruned.passStats.summarizedCount}), sessionKey=${sessionKey}`,
            )
          }

          // 第二档：microcompact 试算（清理旧轮次工具结果），成本极低
          const microcompacted = microcompactToolResults(workingMessages, 4)
          const afterMicrocompact = estimateTokenCount(microcompacted)
          if (afterMicrocompact <= autoCompactThreshold) {
            log.info(
              `[prompt] microcompact 已足够: ${workingTokens} → ${afterMicrocompact} tokens, 跳过 LLM 摘要`,
            )
          } else {
            log.info(
              `[prompt] microcompact 不足: ${workingTokens} → ${afterMicrocompact} tokens, 继续 LLM 摘要`,
            )
            try {
              const compactResult = await this.deps.compactor.compactContextAsync(instanceId, sessionKey, 6)
              log.info(
                `[prompt] 自动压缩完成: removed=${compactResult.messagesRemoved}, hadSummary=${compactResult.hadSummary}`,
              )
            } catch (compactErr) {
              log.warn(`[prompt] 自动压缩失败（继续执行）: ${compactErr instanceof Error ? compactErr.message : String(compactErr)}`)
            }
          }
        }
      } catch (checkErr) {
        log.warn(`[prompt] token 预算检查失败（继续执行）: ${checkErr instanceof Error ? checkErr.message : String(checkErr)}`)
      }
    }

    // 图片生成模型拦截：gpt-image-2 / gpt-image-2-vip / gemini-*-image 等不是对话模型，无法处理工具调用。
    // 若用户当前选择了图片生成模型，则直接调用 generateImage() 并把结果推回，跳过 LLM 对话链。
    const isImageGenerationModel = currentModelId
      ? BridgePromptDispatcher.IMAGE_GENERATION_MODEL_PATTERNS.some(p => currentModelId.toLowerCase().includes(p.toLowerCase()))
      : false

    log.info(`[prompt] modelId=${currentModelId ?? '(default)'}, isImageGenerationModel=${isImageGenerationModel}`)

    if (isImageGenerationModel) {
      await this.captureDirectImageTurnStart(state)
      // 意图分级：用户停留在通用生图入口（gpt-image-2）时，按需求复杂度自动选择
      //   简单/快速 → gpt-image-2；复杂/高清 → gpt-image-2-vip。
      // 用户若已显式选了 pro 或其它生图模型，则尊重其选择，不再自动改写。
      let effectiveModelId = currentModelId ?? IMAGE_MODEL_SIMPLE
      const isGenericImageEntry = effectiveModelId.toLowerCase() === IMAGE_MODEL_SIMPLE
      if (isGenericImageEntry && this.deps.imageIntentLlmCaller) {
        const picked = await classifyImageModel(this.deps.imageIntentLlmCaller, message)
        if (picked !== effectiveModelId) {
          log.info(`[prompt] 生图意图分级: ${effectiveModelId} → ${picked}`)
        }
        effectiveModelId = picked
      }

      log.info(`[prompt] 图片生成模型拦截: model=${effectiveModelId}, 直接调用 generateImage()`)
      const runId = crypto.randomUUID()
      const toolCallId = `img-direct-${runId.slice(0, 8)}`
      const imgSessionKey = sessionKey ?? ''
      const startMs = Date.now()

      // 注册可中断控制器：这条路径绕过 pi-agent-core，需独立 AbortController 才能被用户停止。
      // 前端 user:abort 可能用 rootSessionKey / conversation sessionKey / runId→instanceId 任一键定位，
      // 三个键各异（见 prompt() 顶部 sessionKey vs rootSessionKey），故全部注册，确保命中。
      const rootSessionKey = this.deps.instanceToRootSessionKey.get(instanceId)
      const imgAbort = new AbortController()
      const abortKeys = [...new Set([imgSessionKey, rootSessionKey, instanceId].filter((k): k is string => Boolean(k)))]
      for (const k of abortKeys) {
        this.directImageAborts.set(k, imgAbort)
      }

      // 发送回合开始事件
      this.deps.ipcChannel.forwardIpcEvent({
        type: 'agent:turn:start',
        runId,
        sessionKey: imgSessionKey,
        turnIndex: 0,
        timestamp: Date.now(),
      })
      // 发送工具调用开始事件
      this.deps.ipcChannel.forwardIpcEvent({
        type: 'agent:tool:start',
        runId,
        toolCallId,
        toolName: 'image_generate',
        args: { prompt: message, modelId: effectiveModelId, filename: message },
        timestamp: Date.now(),
        textPositionAtStart: 0,
      })

      try {
        const result = await this.deps.imageServices.generateImage({
          prompt: message,
          modelId: effectiveModelId,
          filename: message,
          signal: imgAbort.signal,
        })
        // 直连生图不经工具链，先把产出图片登记为本实例本轮写入，供归属过滤保留
        recordTurnTouchedFilePath(instanceId, result.filePath, this.deps.config.getCwd(), 'image_generate')
        const durationMs = Date.now() - startMs
        const fileChanges = await this.finishDirectImageTurnSnapshot(state)
        const assistantText = `图片已生成：${result.filePath}（${result.width}×${result.height}，模型：${result.model}）`
        let persistedMessageId: string | undefined

        if (imgSessionKey && conversationRepo) {
          try {
            const row = conversationRepo.saveMessage({
              conversationId: imgSessionKey,
              role: 'assistant',
              contentJson: {
                type: 'assistant_parts',
                parts: [{
                  type: 'text',
                  id: `text-${runId}`,
                  text: assistantText,
                  status: 'done',
                }],
                ...(fileChanges ? { fileChanges } : {}),
              },
            })
            persistedMessageId = row.id
          } catch (err) {
            log.error(`[prompt] 直接生图 assistant 消息持久化失败:`, err)
          }
        }

        if (fileChanges && persistedMessageId) {
          this.deps.ipcChannel.forwardIpcEvent({
            type: 'agent:turn:file-changes',
            runId,
            sessionKey: imgSessionKey,
            messageId: persistedMessageId,
            fileChanges,
            instanceId,
            rootSessionKey: rootSessionKey ?? imgSessionKey,
          })
        }

        // 发送工具调用结束事件
        this.deps.ipcChannel.forwardIpcEvent({
          type: 'agent:tool:end',
          runId,
          toolCallId,
          toolName: 'image_generate',
          result: {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            details: {
              ...result,
              artifacts: [
                {
                  kind: 'image',
                  path: result.filePath,
                  role: 'deliverable',
                  meta: {
                    width: result.width,
                    height: result.height,
                    model: result.model,
                    prompt: result.revisedPrompt,
                    // 与 artifact-declaration 的读端上限一致，避免一条超长口令撑大 content_json
                    sourcePrompt: message.slice(0, 4000),
                  },
                },
              ],
            },
          },
          isError: false,
          durationMs,
        })
        // 发送回合结束事件
        this.deps.ipcChannel.forwardIpcEvent({
          type: 'agent:turn:end',
          runId,
          sessionKey: imgSessionKey,
          turnIndex: 0,
          totalToolUseCount: 1,
          totalTokens: 0,
          durationMs: Date.now() - startMs,
        })
        this.deps.ipcChannel.forwardIpcEvent({ type: 'agent:idle', runId, sessionKey: imgSessionKey })

        log.info(`[prompt] 图片生成完成: instanceId=${instanceId}, filePath=${result.filePath}`)

        // 把结果注入 Agent 历史，确保下次对话有上下文
        try {
          instance.appendMessage({ role: 'assistant', content: [{ type: 'text', text: assistantText }] } as any)
        } catch (e) {
          log.warn(`[prompt] 注入 assistant 消息失败: ${e instanceof Error ? e.message : String(e)}`)
        }
      } catch (e) {
        const errCode = (e as { code?: string }).code ?? 'PROVIDER_ERROR'
        const errMsg = (e as Error).message
        // 用户中断（AbortError 或我们标记的 ABORTED）走 aborted 语义，不算失败
        const isAborted =
          errCode === 'ABORTED' ||
          imgAbort.signal.aborted ||
          (e as Error).name === 'AbortError'
        if (isAborted) {
          log.info(`[prompt] 图片生成已被用户中断: instanceId=${instanceId}`)
          this.deps.ipcChannel.forwardIpcEvent({
            type: 'agent:tool:end',
            runId,
            toolCallId,
            toolName: 'image_generate',
            result: { status: 'aborted', message: '图片生成已被用户中断' },
            isError: true,
            durationMs: Date.now() - startMs,
          })
        } else {
          log.error(`[prompt] 图片生成失败: code=${errCode}, message=${errMsg}`)
          this.deps.ipcChannel.forwardIpcEvent({
            type: 'agent:tool:end',
            runId,
            toolCallId,
            toolName: 'image_generate',
            result: { status: 'error', code: errCode, message: errMsg, retryable: false },
            isError: true,
            durationMs: Date.now() - startMs,
          })
        }
        this.deps.ipcChannel.forwardIpcEvent({
          type: 'agent:turn:end',
          runId,
          sessionKey: imgSessionKey,
          turnIndex: 0,
          totalToolUseCount: 1,
          totalTokens: 0,
          durationMs: Date.now() - startMs,
        })
        this.deps.ipcChannel.forwardIpcEvent({ type: 'agent:idle', runId, sessionKey: imgSessionKey })
      } finally {
        if (state?.turnSnapshotStart) {
          await this.finishDirectImageTurnSnapshot(state)
        }
        // 仅当某键仍指向自己时清理，避免误删后续轮次注册的控制器
        for (const k of abortKeys) {
          if (this.directImageAborts.get(k) === imgAbort) {
            this.directImageAborts.delete(k)
          }
        }
      }
      return
    }

    try {
      // 集成点2：技能进化消息拦截（fire-and-forget 状态机，不阻塞正常对话）
      const skillEvoEngine = this.deps.getSkillEvolutionEngine()
      if (skillEvoEngine) {
        const intercepted = await skillEvoEngine.onUserMessage(instanceId, message)
        if (intercepted) {
          log.info(`[prompt] 技能进化状态机拦截消息: instanceId=${instanceId}`)
          return
        }
      }
      // 集成点2b：工具进化审批回复消费（不拦截，确认/拒绝后消息正常继续对话）
      const toolEvoEngine = this.deps.getToolEvolutionEngine?.()
      if (toolEvoEngine) {
        try {
          await toolEvoEngine.handleUserMessage(message)
        } catch (err) {
          log.warn('[prompt] 工具进化消息处理失败:', err)
        }
      }
      const imageContents = await this.deps.instanceFactory.buildImageContents(imageAttachmentPaths)
      // 在 Agent 真正处理提示词前记录工作区起点；失败时不生成伪造的文件变更。
      if (state) {
        clearTurnTouchedPaths(instanceId)
        try {
          state.turnSnapshotStart = (await getVcsService()?.captureTurnSnapshot(this.deps.config.getCwd())) ?? new Map<string, string>()
        } catch (err) {
          state.turnSnapshotStart = undefined
          log.warn(`[turn-snapshot] start failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      // ── 暴露记录（能力面设计 §5.7.1 P0）──
      // 记「这一轮模型看到了哪些工具」。此前只记「被调用」，于是「没用」与
      // 「没机会用」分不开，任何裁剪都无法证伪。
      //
      // 放在 `await instance.prompt()` **之后**，原因只有一条：
      // 实际用的是哪个模型要等 streamFn 跑完才写进 `ctx.resolvedModelId`
      // （无显式偏好时它是 undefined，而那个模型决定了 token 估算用哪个
      // charsPerToken）。提前记会静默退回权重法，与日志差 2.4 倍。
      // 工具集在单轮内不变，所以"事后记"记到的仍是本轮真实的那一份。
      //
      // `instance.prompt()` 抛错时**不记**：那一轮没跑成，记下来会在
      // 「Recall 掉了吗」的判据里混进一批"根本没发生"的回合。
      await instance.prompt(message, imageContents)
      this.recordExposure(instanceId, pendingUserMsgId, ctx?.resolvedModelId)
      log.info(`[prompt] completed: instanceId=${instanceId}`)
      this.deps.instanceStates.get(instanceId)?.skillHitRateTracker?.flush(instanceId)
    } catch (err) {
      log.error(`[prompt] failed: instanceId=${instanceId}`, err)
      throw err
    }
  }

  /**
   * 获取指定实例当前实际使用的模型 ID。
   * 优先从 sessionModelCatalog 读取用户选择的模型（与 streamFn 逻辑一致），
   * 回退到 runContext 中记录的 resolvedModelId。
   */
  private resolveCurrentModelId(ctx: RunContext): string | undefined {
    const pref = this.deps.sessionModelCatalog.getPreferredModelRawForStream(ctx.rootSessionKey, ctx.sessionKey)
    if (pref) {
      try {
        return this.deps.modelRouter.resolveExplicitModelId(pref).id
      } catch {
        // 模型 ID 无效时回退
      }
    }
    return ctx.resolvedModelId
  }

  /** 向指定 Agent 注入 steer 消息（中途插话） */
  steer(instanceId: string, message: string): void {
    const instance = this.deps.agentRegistry.get(instanceId)
    if (instance) {
      instance.steer(message)
      log.info(`[steer] instanceId=${instanceId}, message="${message.slice(0, 100)}"`)
    } else {
      log.error(`[steer] instance not found: ${instanceId}`)
    }
  }

  /** 中止指定 Agent */
  abort(instanceId: string): void {
    this.abortDirectImage(instanceId)
    const instance = this.deps.agentRegistry.get(instanceId)
    if (instance) {
      const sessionKey = this.deps.instanceToRootSessionKey.get(instanceId)
      if (sessionKey) this.abortDirectImage(sessionKey)
      instance.abort()
      log.info(`Aborted agent: ${instanceId}`)
    }
  }

  /**
   * 中止指定 Agent 及其所有子 Agent（级联中止）。
   * 用于用户点击停止时，确保委派给子 Agent 的任务也同步停止。
   */
  abortWithChildren(instanceId: string): void {
    const instance = this.deps.agentRegistry.get(instanceId)
    if (!instance) return
    // 先递归中止所有子实例（广度优先遍历）
    const toAbort: string[] = [instanceId]
    let i = 0
    while (i < toAbort.length) {
      const id = toAbort[i++]
      const children = this.deps.agentRegistry.getChildrenOf(id)
      for (const childId of children) {
        toAbort.push(childId)
      }
    }
    // 逆序中止（先子后父，避免父实例收到子实例完成事件后继续执行）
    for (let j = toAbort.length - 1; j >= 0; j--) {
      const id = toAbort[j]
      this.abortDirectImage(id)
      const sessionKey = this.deps.instanceToRootSessionKey.get(id)
      if (sessionKey) this.abortDirectImage(sessionKey)
      const inst = this.deps.agentRegistry.get(id)
      if (inst) {
        inst.abort()
        log.info(`Aborted agent (cascade): ${id}`)
      }
    }
  }

  /**
   * 按会话根键中止该会话下所有运行中的 Agent（含子 Agent）。
   * 返回实际触发中止的根实例数量。
   */
  abortSession(rootSessionKey: string): number {
    const roots = this.deps.agentRegistry.getAll()
      .filter((inst) => this.deps.instanceToRootSessionKey.get(inst.id) === rootSessionKey)
      .filter((inst) => !this.deps.agentRegistry.getParentId(inst.id))

    for (const root of roots) {
      this.abortWithChildren(root.id)
    }

    // 直接生图路径可能没有正在运行的 agent（绕过 pi-agent-core），按 sessionKey 兜底中断
    const directHit = this.abortDirectImage(rootSessionKey)

    if (roots.length > 0) {
      log.info(`[abortSession] rootSessionKey=${rootSessionKey}, roots=${roots.length}`)
    } else if (directHit) {
      log.info(`[abortSession] rootSessionKey=${rootSessionKey}, direct image aborted`)
    } else {
      log.info(`[abortSession] no roots found for rootSessionKey=${rootSessionKey}`)
    }
    return roots.length + (directHit ? 1 : 0)
  }
}

// ─── Router 类型适配 ─────────────────────────────────────────────

function toRouterAgentInfo(a: CustomAgentInfo): RouterAgentInfo {
  return {
    id: a.id,
    name: a.name,
    description: a.description ?? '',
    whenToUse: a.whenToUse,
    triggerExamples: a.triggerExamples,
    category: a.category,
    emoji: a.emoji,
  }
}

function toRouterSkillInfo(s: SkillInfo): RouterSkillInfo {
  return {
    id: (s.id ?? s.name).trim(),
    name: s.name,
    description: s.description,
    whenToUse: s.whenToUse,
  }
}
