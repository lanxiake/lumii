/**
 * 审批回复解析器
 *
 * 解析用户在渠道中的回复（1/2/3），复用渠道审批的文案语义。
 *
 * 来源：前端可视化实施方案.md 第十节 10.4
 */

import type { ApprovalQueue } from './approval-queue'

/**
 * 审批回复决策
 */
export type ApprovalDecision = 'approve' | 'reject' | 'always'

/**
 * 解析审批回复
 *
 * 复用渠道审批的 1/2/3 语义：
 * - 1 → 同意
 * - 2 → 拒绝
 * - 3 → 以后同类都自动同意
 *
 * @param text 用户回复文本
 * @returns 决策类型或 null（无法解析）
 */
export function parseApprovalReply(text: string): ApprovalDecision | null {
  const trimmed = text.trim()

  // 精确匹配数字
  if (trimmed === '1') return 'approve'
  if (trimmed === '2') return 'reject'
  if (trimmed === '3') return 'always'

  // 支持中文关键词（更友好）
  const lower = trimmed.toLowerCase()
  if (lower === '同意' || lower === '批准' || lower === '好的' || lower === 'ok' || lower === 'yes') {
    return 'approve'
  }
  if (lower === '拒绝' || lower === '不同意' || lower === 'no') {
    return 'reject'
  }

  // 无法解析
  return null
}

/**
 * 尝试把入站文本当作目标审批回复消费
 *
 * 只消费最近一条待审批项，避免用户一句「1」被多条审批同时吃掉。
 *
 * @param peerId 渠道 peer ID
 * @param text 用户回复文本
 * @param queue 审批队列
 * @param db 数据库接口
 * @returns 是否消费成功
 */
export async function tryConsumeGoalApproval(
  peerId: string,
  text: string,
  queue: ApprovalQueue,
  db: ApprovalDatabase
): Promise<boolean> {
  // 查找最近一条待审批项
  const pending = await db.findLatestPendingApproval(peerId)
  if (!pending) {
    return false
  }

  // 尝试解析回复
  const decision = parseApprovalReply(text)
  if (!decision) {
    // 看不懂就不消费，交回正常对话流程
    return false
  }

  // 检查是否已过期
  if (pending.expiresAt < Date.now()) {
    // TODO: 明确回复「该请求已过期」
    return false
  }

  // 应用决策
  if (decision === 'approve') {
    await queue.applyUserDecision(pending.id, 'approved', '用户批准')
  } else if (decision === 'reject') {
    await queue.applyUserDecision(pending.id, 'rejected', '用户拒绝')
  } else if (decision === 'always') {
    // TODO: 更新用户设置，以后同类自动批准
    await queue.applyUserDecision(pending.id, 'approved', '用户批准并设置自动批准')
  }

  return true
}

/**
 * 数据库接口（用于回复匹配）
 */
export interface ApprovalDatabase {
  findLatestPendingApproval(peerId: string): Promise<{
    id: string
    goalId: string
    expiresAt: number
  } | null>
}
