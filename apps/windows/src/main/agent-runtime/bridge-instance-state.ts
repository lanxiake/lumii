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

import type { createGatewayStreamFn } from '@mtbot/agent-runtime'
import type {
  AssistantPart,
  SystemPromptResult,
  SkillInfo,
  SkillActivationHint,
  ProactivityScheduler,
  RouterResultLite,
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
  /** toolCallId → 工具入参（tool:end 时合并写入 messages） */
  toolCallArgs: Map<string, Record<string, unknown>>
  /** 当前助手轮次的结构化时间线，是正文、思考与工具状态的唯一真相 */
  pendingParts: AssistantPart[]
  /** 本轮开始时的工作区文件快照，由后续文件变更任务填充 */
  turnSnapshotStart?: Map<string, string>
  /** 不含用户记忆的结构化基础提示词（用于每轮刷新记忆和活跃任务注入） */
  basePrompt?: SystemPromptResult
  /** 每轮重建系统提示词的闭包（v12 Skill Activation + Router 注入） */
  promptRebuilder?: (
    hints: readonly SkillActivationHint[],
    currentModelId?: string,
    routerResult?: RouterResultLite,
  ) => SystemPromptResult
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
  /** 最近一轮 message:end 的 token 用量（写入最终行） */
  lastAssistantUsage?: {
    inputTokens: number
    outputTokens: number
    cacheRead?: number
    cacheWrite?: number
  }
  /** 实例对应的 innerStream 与 model，供 compactContextAsync 按 instanceId 查找 */
  stream?: {
    innerStream: ReturnType<typeof createGatewayStreamFn>
    model: import('@mariozechner/pi-ai').Model<any>
  }
  /** 实例级运行时指标（生命周期 UI + 统计） */
  metrics: InstanceRuntimeMetrics
  /** 实例级主动调度（cron/event → prompt） */
  proactivityScheduler?: ProactivityScheduler
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
