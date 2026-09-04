/**
 * 审批请求渠道送达
 *
 * 复用现有渠道出站能力（ChannelOutboundRouter）推送审批请求到飞书/微信/企微。
 * 复用现有审批文案格式（1/2/3 语义）。
 *
 * 来源：前端可视化实施方案.md 第十节 10.4
 */

import type { AutonomousGoal, GoalType } from './types'
import type { ApprovalRecord } from './approval-queue'
import type { ChannelOutboundRouter } from '../../main/channel/channel-outbound-router'

/**
 * 目标类型中文标签
 */
const GOAL_TYPE_LABELS: Record<GoalType, string> = {
  learning: '学习目标',
  'proactive-message': '主动消息',
  'capability-improvement': '能力提升',
  'skill-enhancement': '技能增强',
  'memory-optimization': '记忆优化',
}

/**
 * 渠道目标
 */
export interface DeliveryTarget {
  channel: string
  peerId: string
}

/**
 * 送达配置接口
 */
export interface DeliverySettings {
  channel: string
  peerId?: string
}

/**
 * 获取用户审批设置
 */
export interface DeliverySettingsProvider {
  getUserDeliverySettings(userId: string): Promise<DeliverySettings | null>
}

/**
 * 格式化审批请求文案
 *
 * 复用渠道审批的 1/2/3 语义，保持一致性。
 *
 * @param goal 自主目标
 * @returns 审批请求文案
 */
export function formatGoalApprovalPrompt(goal: AutonomousGoal): string {
  const typeLabel = GOAL_TYPE_LABELS[goal.type] || goal.type
  const priorityStars = '⭐'.repeat(Math.ceil(goal.priority * 5))

  return `🎯 我想做一件事，需要你确认

[${typeLabel}] ${goal.description}
原因：${goal.triggerReason}
优先级：${priorityStars}

回复 1 = 同意  2 = 拒绝  3 = 以后同类都自动同意

（超时将按目标类型采取默认动作，不会打扰你）`
}

/**
 * 审批送达服务
 */
export class ApprovalDeliveryService {
  constructor(
    private readonly router: ChannelOutboundRouter,
    private readonly settingsProvider: DeliverySettingsProvider
  ) {}

  /**
   * 解析可送达的渠道目标
   *
   * 优先使用用户配置的渠道；如果未配置，尝试找到任一可送达的 peer。
   *
   * @param userId 用户 ID
   * @returns 渠道目标或 null
   */
  async resolveTarget(userId: string): Promise<DeliveryTarget | null> {
    // 获取用户配置
    const settings = await this.settingsProvider.getUserDeliverySettings(userId)
    if (!settings || settings.channel === 'off' || settings.channel === 'local') {
      return null
    }

    // 用户指定了 peer
    if (settings.peerId) {
      return {
        channel: settings.channel,
        peerId: settings.peerId,
      }
    }

    // 尝试从渠道列表中找到可用的 peer
    const channels = await this.router.list()
    const targetChannel = channels.find((c) => c.channel === settings.channel && c.connected)
    if (!targetChannel || targetChannel.peers.length === 0) {
      return null
    }

    // 选择第一个可用的 peer（通常是用户自己）
    const firstPeer = targetChannel.peers[0]
    return {
      channel: settings.channel,
      peerId: firstPeer.id,
    }
  }

  /**
   * 推送审批请求到渠道
   *
   * 送达失败不抛错：标记 delivery_status 让超时策略接管，
   * 否则一次网络抖动就会让目标永久卡住。
   *
   * @param approval 审批记录
   * @param goal 自主目标
   * @param userId 用户 ID
   * @returns 送达结果
   */
  async deliver(
    approval: ApprovalRecord,
    goal: AutonomousGoal,
    userId: string
  ): Promise<{
    ok: boolean
    target?: DeliveryTarget
    errorCode?: string
  }> {
    // 解析目标
    const target = await this.resolveTarget(userId)
    if (!target) {
      return {
        ok: false,
        errorCode: 'PEER_NOT_FOUND',
      }
    }

    // 格式化文案
    const text = formatGoalApprovalPrompt(goal)

    // 发送
    const result = await this.router.send({
      channel: target.channel,
      to: target.peerId,
      text,
    })

    if (!result.ok) {
      return {
        ok: false,
        errorCode: result.errorCode ?? 'UPSTREAM_ERROR',
      }
    }

    return {
      ok: true,
      target,
    }
  }
}
