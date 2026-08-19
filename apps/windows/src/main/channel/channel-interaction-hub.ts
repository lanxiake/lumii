/**
 * ChannelInteractionHub —— 渠道侧提问/审批的推送与回填
 *
 * 全局单例：bridge 只有一个 notifier 槽位，各渠道 adapter 把自己的会话注册进来。
 * Agent 发起提问/审批 → 找到该 sessionKey 对应的 adapter → 文字化推送 →
 * 用户下一条文字消息被 adapter 拦截 → 解析 → 回填 bridge 的 resolver。
 */

import type { AgentRuntimeBridge } from '../agent-runtime/bridge'
import type { ChannelInteractionRequest, ChannelSession, IChannelAdapter } from './types'
import {
  ChannelInteractionStore,
  formatAskPrompt,
  formatPermissionPrompt,
  parseAskReply,
  parsePermissionReply,
  type ChannelInteraction,
} from './channel-interaction-store'

const log = {
  info: (...args: unknown[]) => console.log('[ChannelInteractionHub]', ...args),
  warn: (...args: unknown[]) => console.warn('[ChannelInteractionHub]', ...args),
}

interface RouteEntry {
  adapter: IChannelAdapter
  session: ChannelSession
}

export class ChannelInteractionHub {
  private readonly store = new ChannelInteractionStore()
  /** sessionKey → 最近一次该会话的 adapter + 回复上下文（每轮消息刷新） */
  private readonly routes = new Map<string, RouteEntry>()

  constructor(private readonly bridge: AgentRuntimeBridge) {
    bridge.setChannelInteractionNotifier((req) => this.onInteraction(req))
  }

  /**
   * 每轮渠道消息进来时调用，刷新该会话的回复上下文。
   * replyContext 含一次性的 msgId/token，必须每轮更新否则回复会发到旧消息上。
   */
  trackSession(adapter: IChannelAdapter, session: ChannelSession): void {
    this.routes.set(session.sessionKey, { adapter, session })
  }

  /** /clear、/new、中止时清掉挂起交互，避免陈旧问题吃掉下一条正常消息 */
  clear(sessionKey: string): void {
    this.store.clear(sessionKey)
  }

  /** 该会话当前是否在等用户回答 */
  hasPending(sessionKey: string): boolean {
    return this.store.get(sessionKey) !== undefined
  }

  /**
   * 拦截入站文字：若该会话正等提问/审批答复，消费掉这条消息并回填。
   * @returns true 表示已作为答复消费，adapter 不应再当普通 prompt 处理
   */
  async tryConsumeReply(sessionKey: string, text: string): Promise<boolean> {
    const entry = this.store.get(sessionKey)
    if (!entry) return false

    const { interaction, adapter, session } = entry

    if (interaction.kind === 'permission') {
      const decision = parsePermissionReply(text)
      if (!decision) {
        await adapter.sendTextReply(
          session,
          '没看懂你的审批意见，请回复 1（本次允许）/ 2（一直允许）/ 3（拒绝）。',
        )
        return true
      }
      this.store.delete(sessionKey)
      this.bridge.resolvePermission(interaction.requestId, decision)
      const label = { 'allow-once': '本次允许', 'allow-always': '一直允许', deny: '已拒绝' }[decision]
      await adapter.sendTextReply(session, `✅ 审批已提交：${label}`)
      log.info(`[tryConsumeReply] 审批回填 sessionKey=${sessionKey} decision=${decision}`)
      return true
    }

    this.store.delete(sessionKey)
    const answers = parseAskReply(interaction.questions, text)
    this.bridge.resolveAskUserQuestion(interaction.requestId, { answers })
    await adapter.sendTextReply(session, '✅ 已收到你的回答，继续处理中…')
    log.info(`[tryConsumeReply] 提问回填 sessionKey=${sessionKey} keys=${Object.keys(answers).join(',')}`)
    return true
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  /** bridge 回调：把请求文字化推给渠道用户 */
  private onInteraction(req: ChannelInteractionRequest): boolean {
    const route = this.routes.get(req.sessionKey)
    if (!route) return false

    let interaction: ChannelInteraction
    let text: string
    if (req.kind === 'permission') {
      interaction = { kind: 'permission', requestId: req.requestId, toolName: req.toolName }
      text = formatPermissionPrompt(req.toolName, req.description)
    } else {
      const questions = req.questions.map((q) => ({
        question: q.question,
        header: q.header,
        multiSelect: q.multiSelect ?? false,
        options: q.options.map((o) => ({ label: o.label, description: o.description })),
      }))
      interaction = { kind: 'ask', requestId: req.requestId, questions }
      text = formatAskPrompt(questions)
    }

    this.store.set(req.sessionKey, {
      interaction,
      adapter: route.adapter,
      session: route.session,
    })

    // 推送本身是异步的，但 bridge 需要同步知道「渠道已承接」
    void route.adapter.sendTextReply(route.session, text).catch((err) => {
      log.warn(`[onInteraction] 推送失败 sessionKey=${req.sessionKey}: ${err}`)
    })
    log.info(`[onInteraction] 已推送 ${interaction.kind} 到渠道 sessionKey=${req.sessionKey}`)
    return true
  }
}

/**
 * 全局单例：bridge 只有一个 notifier 槽位，多个 adapter 必须共用同一个 Hub，
 * 否则后构造的 adapter 会覆盖前一个的注册，先注册的渠道彻底收不到交互。
 */
let hub: ChannelInteractionHub | null = null

export function getChannelInteractionHub(bridge: AgentRuntimeBridge): ChannelInteractionHub {
  if (!hub) hub = new ChannelInteractionHub(bridge)
  return hub
}
