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
  type SkillActivationHint,
  type SkillInfo,
  type CustomAgentInfo,
  resolveSkillActivations,
  estimateTokenCount,
  microcompactToolResults,
  DEFAULT_COMPACTION_TRIGGER_RATIO,
  diffTurnSnapshots,
} from '@mtbot/agent-runtime'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
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
import { captureWorkspaceTurnSnapshot } from '../workspace-vcs/workspace-turn-snapshot'

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
  getSkillEvolutionEngine: () => import('../skill-evolution/index').SkillEvolutionEngine | undefined
  getConversationRepo: () => ConversationRepo | null
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
   * 捕获直接生图轮次的工作区起点；失败时不阻断生图。
   */
  private async captureDirectImageTurnStart(state: InstanceState | undefined): Promise<void> {
    if (!state) return
    try {
      state.turnSnapshotStart = await captureWorkspaceTurnSnapshot(this.deps.config.getCwd())
    } catch (err) {
      state.turnSnapshotStart = undefined
      log.warn(`[turn-snapshot] direct image start failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 完成直接生图轮次快照并返回净变更，同时确保起点不会污染下一轮。
   */
  private async finishDirectImageTurnSnapshot(
    state: InstanceState | undefined,
  ): Promise<FileChangeEntry[] | undefined> {
    const turnSnapshotStart = state?.turnSnapshotStart
    if (state) state.turnSnapshotStart = undefined
    if (!turnSnapshotStart) return undefined

    try {
      const turnSnapshotEnd = await captureWorkspaceTurnSnapshot(this.deps.config.getCwd())
      return diffTurnSnapshots(turnSnapshotStart, turnSnapshotEnd)
    } catch (err) {
      log.warn(`[turn-snapshot] direct image end failed: ${err instanceof Error ? err.message : String(err)}`)
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
   */
  async prompt(instanceId: string, message: string, imageAttachmentPaths?: readonly string[]): Promise<void> {
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
    }

    // 上一轮 abort 后 pi 循环可能尚未退出；短等空闲，避免 "already processing"
    if (instance.state === 'running' || instance.state === 'aborted') {
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
        let hints: readonly SkillActivationHint[] = []
        if (this.deps.featureFlags.ENABLE_SKILL_ACTIVATION) {
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
        baseResult = rebuilder(hints, currentModelId, routerLite)
        if (state) state.basePrompt = baseResult
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
      )
      instance.setSystemPrompt(freshPrompt)
      log.info(`[prompt] 已刷新系统提示词（记忆+任务+模型）instanceId=${instanceId}, model=${currentModelId ?? 'default'}`)
    }

    // 自动压缩：在发送消息前检查当前消息历史 token 预算，超过触发阈值时触发异步压缩
    // 这是 transformContext（LLM 调用前）之外的第二道防线，专门处理单轮工具结果过大的情况
    const sessionKey = this.deps.instanceToConversation.get(instanceId)
    const conversationRepo = this.deps.getConversationRepo()
    if (sessionKey && conversationRepo) {
      const rootSessionKey = this.deps.instanceToRootSessionKey.get(instanceId) ?? sessionKey
      try {
        const comp = this.deps.sessionModelCatalog.getCompactionForRootSession(rootSessionKey)
        const historyMessages = conversationRepo.loadMessagesAsPiFormat(sessionKey, { limit: 500 }) as AgentMessage[]
        const thinkingMsgCount = (historyMessages as any[]).filter(m =>
          Array.isArray(m.content) && m.content.some((b: any) => b.type === "thinking")
        ).length
        if (thinkingMsgCount > 0) {
          log.info(`[prompt] 历史消息含 thinking block: count=${thinkingMsgCount}, sessionKey=${sessionKey}`)
        }
        const estimatedTokens = estimateTokenCount(historyMessages)
        // 与 agent-instance createTransformContext 使用同一常量，避免两套逻辑在不同阈值重复触发
        const autoCompactThreshold = Math.floor(comp.contextWindow * DEFAULT_COMPACTION_TRIGGER_RATIO)
        if (estimatedTokens > autoCompactThreshold && historyMessages.length > 4) {
          log.info(
            `[prompt] 自动压缩触发: estimatedTokens=${estimatedTokens} > threshold=${autoCompactThreshold} (80% of ${comp.contextWindow}), sessionKey=${sessionKey}`,
          )

          // 先尝试 microcompact（清理旧轮次工具结果），成本极低
          const microcompacted = microcompactToolResults(historyMessages, 4)
          const afterMicrocompact = estimateTokenCount(microcompacted)
          if (afterMicrocompact <= autoCompactThreshold) {
            log.info(
              `[prompt] microcompact 已足够: ${estimatedTokens} → ${afterMicrocompact} tokens, 跳过 LLM 摘要`,
            )
          } else {
            log.info(
              `[prompt] microcompact 不足: ${estimatedTokens} → ${afterMicrocompact} tokens, 继续 LLM 摘要`,
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
          result: { content: [{ type: 'text', text: JSON.stringify(result) }], details: result },
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
      const imageContents = await this.deps.instanceFactory.buildImageContents(imageAttachmentPaths)
      // 在 Agent 真正处理提示词前记录工作区起点；失败时不生成伪造的文件变更。
      if (state) {
        try {
          state.turnSnapshotStart = await captureWorkspaceTurnSnapshot(this.deps.config.getCwd())
        } catch (err) {
          state.turnSnapshotStart = undefined
          log.warn(`[turn-snapshot] start failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      await instance.prompt(message, imageContents)
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
