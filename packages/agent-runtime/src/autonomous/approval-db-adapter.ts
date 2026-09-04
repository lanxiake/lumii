/**
 * 审批队列数据库适配器
 *
 * 实现审批队列的 SQLite 数据库操作。
 */

import type { DatabaseSync } from 'node:sqlite'
import type {
  ApprovalRecord,
  ApprovalStatus,
  DeliveryStatus,
  DecisionSource,
  ApprovalDatabase,
} from './approval-queue'
import type { AutoApprovalDatabase } from './auto-approval-policy'

/**
 * 扩展数据库接口
 */
export interface ExtendedDatabase {
  db: DatabaseSync
}

/**
 * 审批队列数据库适配器
 */
export class ApprovalDbAdapter implements ApprovalDatabase, AutoApprovalDatabase {
  constructor(private readonly dbClient: ExtendedDatabase) {}

  /**
   * 创建审批记录
   */
  async createApproval(record: ApprovalRecord): Promise<void> {
    const stmt = this.dbClient.db.prepare(`
      INSERT INTO autonomous_approvals (
        id, goal_id, risk_level, status,
        channel, peer_id, delivery_status, delivery_error, delivered_at,
        decided_by, decided_at, decision_note,
        expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    stmt.run(
      record.id,
      record.goalId,
      record.riskLevel,
      record.status,
      record.channel ?? null,
      record.peerId ?? null,
      record.deliveryStatus ?? null,
      record.deliveryError ?? null,
      record.deliveredAt ?? null,
      record.decidedBy ?? null,
      record.decidedAt ?? null,
      record.decisionNote ?? null,
      record.expiresAt,
      record.createdAt
    )
  }

  /**
   * 查询待审批项
   */
  async findPendingApprovals(peerId?: string): Promise<ApprovalRecord[]> {
    let query = `
      SELECT * FROM autonomous_approvals
      WHERE status = 'pending'
    `
    const params: any[] = []

    if (peerId) {
      query += ` AND peer_id = ?`
      params.push(peerId)
    }

    query += ` ORDER BY created_at DESC`

    const stmt = this.dbClient.db.prepare(query)
    const rows = stmt.all(...params) as any[]

    return rows.map(this.mapRow)
  }

  /**
   * 查询最近一条待审批项
   */
  async findLatestPendingApproval(peerId: string): Promise<ApprovalRecord | null> {
    const stmt = this.dbClient.db.prepare(`
      SELECT * FROM autonomous_approvals
      WHERE status = 'pending' AND peer_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `)

    const row = stmt.get(peerId) as any
    return row ? this.mapRow(row) : null
  }

  /**
   * 查询即将超时的审批
   */
  async findExpiringApprovals(beforeTimestamp: number): Promise<ApprovalRecord[]> {
    const stmt = this.dbClient.db.prepare(`
      SELECT * FROM autonomous_approvals
      WHERE status = 'pending' AND expires_at <= ?
      ORDER BY expires_at ASC
    `)

    const rows = stmt.all(beforeTimestamp) as any[]
    return rows.map(this.mapRow)
  }

  /**
   * 更新送达状态
   */
  async updateDeliveryStatus(
    approvalId: string,
    status: DeliveryStatus,
    channel?: string,
    peerId?: string,
    error?: string
  ): Promise<void> {
    const stmt = this.dbClient.db.prepare(`
      UPDATE autonomous_approvals
      SET delivery_status = ?,
          channel = ?,
          peer_id = ?,
          delivery_error = ?,
          delivered_at = ?
      WHERE id = ?
    `)

    stmt.run(
      status,
      channel ?? null,
      peerId ?? null,
      error ?? null,
      status === 'sent' ? Date.now() : null,
      approvalId
    )
  }

  /**
   * 记录决策
   */
  async recordDecision(
    approvalId: string,
    decision: ApprovalStatus,
    decidedBy: DecisionSource,
    note?: string
  ): Promise<void> {
    const stmt = this.dbClient.db.prepare(`
      UPDATE autonomous_approvals
      SET status = ?,
          decided_by = ?,
          decided_at = ?,
          decision_note = ?
      WHERE id = ?
    `)

    stmt.run(decision, decidedBy, Date.now(), note ?? null, approvalId)
  }

  /**
   * 查询今日自动批准数量
   */
  async getTodayAutoApprovalCount(agentId: string): Promise<number> {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const todayStartMs = todayStart.getTime()

    const stmt = this.dbClient.db.prepare(`
      SELECT COUNT(*) as count
      FROM autonomous_approvals
      WHERE decided_by = 'auto-policy'
        AND decided_at >= ?
        AND goal_id IN (
          SELECT id FROM autonomous_goals WHERE agent_id = ?
        )
    `)

    const row = stmt.get(todayStartMs, agentId) as any
    return row?.count ?? 0
  }

  /**
   * 查询审批记录
   */
  async getApprovalHistory(goalId: string): Promise<ApprovalRecord[]> {
    const stmt = this.dbClient.db.prepare(`
      SELECT * FROM autonomous_approvals
      WHERE goal_id = ?
      ORDER BY created_at DESC
    `)

    const rows = stmt.all(goalId) as any[]
    return rows.map(this.mapRow)
  }

  /**
   * 映射数据库行到记录对象
   */
  private mapRow(row: any): ApprovalRecord {
    return {
      id: row.id,
      goalId: row.goal_id,
      riskLevel: row.risk_level,
      status: row.status,
      channel: row.channel,
      peerId: row.peer_id,
      deliveryStatus: row.delivery_status,
      deliveryError: row.delivery_error,
      deliveredAt: row.delivered_at,
      decidedBy: row.decided_by,
      decidedAt: row.decided_at,
      decisionNote: row.decision_note,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    }
  }
}
