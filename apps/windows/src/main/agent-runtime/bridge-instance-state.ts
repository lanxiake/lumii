/**
 * AgentRuntimeBridge 实例状态聚合
 *
 * 把 per-instance 的运行时数据从分散的 Map 字段聚合为单一 InstanceState 对象。
 * 用于简化 createInstance / destroy / destroyAll 等生命周期逻辑。
 *
 * 注意：以下字段仍保持为独立 Map（不放入 InstanceState）：
 * - toolStartTimeMap：复合键 `${instanceId}:${toolCallId}`
 * - toolCallInstanceMap：键为 toolCallId 而非 instanceId
 * - instanceToConversation：promptComposer 等外部组件直接依赖
 * - nodeStreamCallbacks：节点流式回调，跨生命周期使用
 */

import type { StreamFn } from '@earendil-works/pi-agent-core'
import type {
  AgentTool,
  AssistantPart,
  SystemPromptResult,
  SkillInfo,
  SkillActivationHint,
  ProactivityScheduler,
  RouterResultLite,
  PromptStyle,
} from '@mtbot/agent-runtime'
import type { RunContext } from './event-converter'
import type { SkillHitRateTracker } from './hooks/skill-hit-rate-hook'
import type { InstanceRuntimeMetrics } from './bridge-agent-instance-events'

/** 单个 Agent 实例的全部 per-instance 运行时数据 */
export interface InstanceState {
  /** 运行上下文（事件转换 / sessionKey / runId / resolvedModelId） */
  ctx: RunContext
  /** 是否跳过 Session Tasks 注入到系统提示词（外部通道如微信） */
  skipTaskInjection: boolean
  /** 本轮消息来源的在场/渠道标签（P0：二元在场信号） */
  presence?: {
    /** channelType === 'ipc' 时用户在客户端面前 */
    userAtClient: boolean
    /** 渠道中文名（微信/飞书/企业微信/QQ/消息渠道），ipc 为 undefined */
    channelLabel?: string
    /**
     * 本轮消息来源的渠道类型（ipc / weixin / feishu / wecom / qbot）。
     *
     * 记的是**消息从哪来**，不是会话归属 —— 跨渠道接续之后 sessionKey 会变成目标
     * 会话的 key（可能是客户端或另一个渠道的），从它反推不出这条消息的来源。
     * 会话切换类工具据此决定该改哪个渠道的路由。
     */
    channelType?: string
    /** 本轮消息的渠道用户 ID（与 channelType 一起用于把后续消息路由到目标会话） */
    channelUserId?: string
    /**
     * 回信地址：本轮消息「回给这里」的 channel_send `to`。
     *
     * 多数渠道等于 channelUserId；群聊里二者不同 —— QQ 群是 `group:{group_openid}`，
     * 企微群是群 chatId。由 adapter 侧按群/单聊算出（见 channel/session-manager 的
     * resolveReplyTo）。缺席表示「回不到当前会话」（客户端、cron、群聊信息不全），
     * 工具须要求显式 to，不得猜。
     */
    replyTo?: string
  }
  /** toolCallId → 工具入参（tool:end 时合并写入 messages） */
  toolCallArgs: Map<string, Record<string, unknown>>
  /** 当前助手轮次的结构化时间线，是正文、思考与工具状态的唯一真相 */
  pendingParts: AssistantPart[]
  /** 本轮开始时的工作区文件快照，由后续文件变更任务填充 */
  turnSnapshotStart?: Map<string, string>
  /** 不含用户记忆的结构化基础提示词（用于每轮刷新记忆和活跃任务注入） */
  basePrompt?: SystemPromptResult
  /** 每轮重建系统提示词的闭包（v12 Skill Activation + Router 注入 + 提示词风格） */
  promptRebuilder?: (
    hints: readonly SkillActivationHint[],
    currentModelId?: string,
    routerResult?: RouterResultLite,
    promptStyle?: PromptStyle,
  ) => SystemPromptResult
  /**
   * 极简档工具定义裁剪：实例原始（未裁剪）工具定义快照。
   * 逐轮样式切换时据此重裁（minimal）或还原（detailed/terse），子 Agent 无逐轮刷新、靠创建时应用。
   */
  originalToolDefs?: readonly AgentTool[]
  /** 已应用到实例的工具定义风格（与 originalToolDefs 配套，避免每轮重复 setTools） */
  appliedToolDefStyle?: PromptStyle
  /** 本实例当前的 skills 快照（用于 ActivationResolver 输入） */
  skillsSnapshot: readonly SkillInfo[]
  /** 技能命中率监控 tracker（P3 监控） */
  skillHitRateTracker?: SkillHitRateTracker
  /** 是否已注入完整记忆管理指南（首次触发记忆操作后设为 true） */
  memoryGuideInjected: boolean
  /** subscribe 返回的取消订阅函数（destroy 时调用以防止内存泄漏） */
  unsubscribe?: () => void
  /** 本轮流式助手消息行 ID（agent:start 插入，agent:end 收尾） */
  streamingAssistantMsgId?: string
  /**
   * 当前 assistant 分段的**开始时刻**（ISO 串）。
   *
   * 为什么单独记：流式持久化每次写入都把该行 timestamp 推到当下，所以行上的值早已不是
   * 段起点。插话处封口需要段起点才能保证排序正确（旧段排在插话之前）——详见
   * ConversationRepo.updateMessageContent 的 timestampOverride。
   */
  streamingSegmentStartedAt?: string
  /** 最近一轮 message:end 的 token 用量（写入最终行） */
  lastAssistantUsage?: {
    inputTokens: number
    outputTokens: number
    cacheRead?: number
    cacheWrite?: number
  }
  /**
   * 最近一次 message:end 的 LLM 错误（该轮干净收场时清空）。
   *
   * 存在的理由：agent:error 收尾会用 pendingParts 重写同一行，重写路径拿不到 message:end
   * 事件里的 llmError——不接力就会把「为什么失败」从落库内容里抹掉。
   */
  lastLlmError?: { code: string; message: string; retryable: boolean }
  /**
   * 最近一次 message:end 是否为中止收场（该轮干净收场时清空）。
   *
   * 与 lastLlmError 同样的接力理由：message:end 只是流式中间态，最终行由 agent:end
   * 收尾时重写；不接力，历史回放就分不清「被中止」与「已完成」（2026-09-20）。
   */
  lastAborted?: boolean
  /** 实例对应的 innerStream 与 model，供 compactContextAsync 按 instanceId 查找 */
  stream?: {
    innerStream: StreamFn
    model: import('@earendil-works/pi-ai/compat').Model<any>
  }
  /** 实例级运行时指标（生命周期 UI + 统计） */
  metrics: InstanceRuntimeMetrics
  /** 实例级主动调度（cron/event → prompt） */
  proactivityScheduler?: ProactivityScheduler
  /** 最后一次活动时间戳（agent:start / tool:start / user prompt），用于 idle compaction 判断 */
  lastActivityAt: number
}

/**
 * 创建一个默认的 InstanceState（仅赋值必填字段，其余按需 set）。
 *
 * @param ctx       已构造的 RunContext
 * @param metrics   已构造的 InstanceRuntimeMetrics
 */
export function createInstanceState(
  ctx: RunContext,
  metrics: InstanceRuntimeMetrics,
): InstanceState {
  return {
    ctx,
    skipTaskInjection: false,
    toolCallArgs: new Map(),
    pendingParts: [],
    skillsSnapshot: [],
    memoryGuideInjected: false,
    metrics,
    lastActivityAt: Date.now(),
  }
}

/**
 * Per-instance 状态存储，封装单个 Map 操作。
 *
 * 提供与 Map 类似的 API，便于在各模块间通过 InstanceStateStore 引用而非裸 Map 传递，
 * 后续如需添加访问日志或 LRU 等策略时只需修改本类。
 */
export class InstanceStateStore {
  private readonly map = new Map<string, InstanceState>()

  get(id: string): InstanceState | undefined {
    return this.map.get(id)
  }

  set(id: string, state: InstanceState): void {
    this.map.set(id, state)
  }

  delete(id: string): boolean {
    return this.map.delete(id)
  }

  has(id: string): boolean {
    return this.map.has(id)
  }

  keys(): IterableIterator<string> {
    return this.map.keys()
  }

  values(): IterableIterator<InstanceState> {
    return this.map.values()
  }

  entries(): IterableIterator<[string, InstanceState]> {
    return this.map.entries()
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}
