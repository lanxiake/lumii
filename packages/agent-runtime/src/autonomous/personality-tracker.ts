/**
 * 人格追踪系统
 *
 * 使用 Big Five 模型和 EMA 算法追踪 Agent 人格演化
 * 来源：设计文档 5-人格追踪系统.md
 */

import type { PersonalityState, PersonalityEvent, PersonalityConfig } from './types';
import type { DatabaseClient } from './meta-cognition-engine';

/**
 * 事件类型到人格影响的映射
 */
export const EVENT_PERSONALITY_IMPACT: Record<string, Partial<PersonalityState>> = {
  'goal-generated': { openness: 0.02, conscientiousness: 0.01 },
  'evolution-decided': { openness: 0.03, conscientiousness: -0.01 },
  'user-feedback-positive': { agreeableness: 0.02, neuroticism: -0.02 },
  'user-feedback-negative': { neuroticism: 0.03, conscientiousness: 0.02 },
  'error-handled': { conscientiousness: 0.02, neuroticism: 0.01 },
};

/**
 * 应用 EMA 更新（纯函数）
 *
 * 公式：newValue = currentValue + alpha * delta
 * 所有维度值限制在 [0, 1] 区间
 *
 * @param currentState 当前人格状态
 * @param delta 人格增量
 * @param alpha EMA 平滑系数
 * @returns 更新后的人格状态
 */
export function applyEMA(currentState: PersonalityState, delta: Partial<PersonalityState>, alpha: number): PersonalityState {
  const updated: PersonalityState = { ...currentState };

  // 对每个维度应用 EMA
  const dimensions: Array<keyof Omit<PersonalityState, 'lastUpdated' | 'updateCount'>> = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism'];

  for (const dim of dimensions) {
    if (delta[dim] !== undefined && typeof delta[dim] === 'number') {
      const currentValue = currentState[dim] as number;
      const deltaValue = delta[dim] as number;
      const newValue = currentValue + alpha * deltaValue;
      // 限制在 [0, 1] 区间
      (updated as any)[dim] = Math.max(0, Math.min(1, newValue));
    }
  }

  return updated;
}

/**
 * 人格追踪器
 */
export class PersonalityTracker {
  constructor(
    private readonly config: PersonalityConfig,
    private readonly db: DatabaseClient,
  ) {}

  /**
   * 获取当前人格状态
   *
   * @param agentId Agent ID
   * @returns 人格状态
   */
  async getCurrentState(agentId: string): Promise<PersonalityState> {
    try {
      const sql = `
        SELECT * FROM personality_state
        WHERE agent_id = ?
      `;
      const rows = await this.db.query<any>(sql, [agentId]);

      if (rows.length > 0) {
        return this.mapRowToState(rows[0]);
      }

      // 初始化默认状态（中性）
      const defaultState: PersonalityState = {
        openness: 0.5,
        conscientiousness: 0.5,
        extraversion: 0.5,
        agreeableness: 0.5,
        neuroticism: 0.5,
        lastUpdated: new Date().toISOString(),
        updateCount: 0,
      };

      await this.saveState(agentId, defaultState);
      return defaultState;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[PersonalityTracker] 获取人格状态失败:', err.message);
      // 返回默认中性状态
      return {
        openness: 0.5,
        conscientiousness: 0.5,
        extraversion: 0.5,
        agreeableness: 0.5,
        neuroticism: 0.5,
        lastUpdated: new Date().toISOString(),
        updateCount: 0,
      };
    }
  }

  /**
   * 更新人格状态
   *
   * @param agentId Agent ID
   * @param event 人格事件
   * @returns 更新后的人格状态
   */
  async updatePersonality(agentId: string, event: PersonalityEvent): Promise<PersonalityState> {
    try {
      // 获取当前状态
      const currentState = await this.getCurrentState(agentId);

      // 应用 EMA 更新
      const updatedState = applyEMA(currentState, event.personalityDelta, this.config.emaAlpha);

      // 更新元数据
      updatedState.lastUpdated = new Date().toISOString();
      updatedState.updateCount = currentState.updateCount + 1;

      // 持久化
      await this.saveState(agentId, updatedState);

      return updatedState;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[PersonalityTracker] 更新人格状态失败:', err.message);
      throw err;
    }
  }

  /**
   * 获取人格历史事件
   *
   * @param agentId Agent ID
   * @param limit 数量限制
   * @returns 事件列表
   */
  async getPersonalityHistory(agentId: string, limit: number): Promise<PersonalityEvent[]> {
    try {
      const sql = `
        SELECT * FROM personality_events
        WHERE agent_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `;
      const rows = await this.db.query<any>(sql, [agentId, limit]);
      return rows.map(this.mapRowToEvent);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[PersonalityTracker] 获取历史事件失败:', err.message);
      return [];
    }
  }

  /**
   * 获取人格维度趋势
   *
   * @param agentId Agent ID
   * @param dimension 维度
   * @param days 天数
   * @returns 趋势数据
   */
  async getPersonalityTrend(agentId: string, dimension: keyof PersonalityState, days: number): Promise<number[]> {
    // 简化实现：返回空数组（完整实现需要时间序列查询）
    return [];
  }

  /**
   * 保存人格状态
   */
  private async saveState(agentId: string, state: PersonalityState): Promise<void> {
    const sql = `
      INSERT INTO personality_state (
        agent_id, openness, conscientiousness, extraversion,
        agreeableness, neuroticism, update_count, last_updated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        openness = excluded.openness,
        conscientiousness = excluded.conscientiousness,
        extraversion = excluded.extraversion,
        agreeableness = excluded.agreeableness,
        neuroticism = excluded.neuroticism,
        update_count = excluded.update_count,
        last_updated = excluded.last_updated
    `;
    await this.db.execute(sql, [agentId, state.openness, state.conscientiousness, state.extraversion, state.agreeableness, state.neuroticism, state.updateCount, state.lastUpdated]);
  }

  /**
   * 映射数据库行到人格状态
   */
  private mapRowToState(row: any): PersonalityState {
    return {
      openness: row.openness,
      conscientiousness: row.conscientiousness,
      extraversion: row.extraversion,
      agreeableness: row.agreeableness,
      neuroticism: row.neuroticism,
      lastUpdated: row.last_updated,
      updateCount: row.update_count,
    };
  }

  /**
   * 映射数据库行到事件
   */
  private mapRowToEvent(row: any): PersonalityEvent {
    return {
      id: row.id,
      agentId: row.agent_id,
      eventType: row.event_type,
      personalityDelta: JSON.parse(row.personality_delta),
      triggerContext: row.trigger_context ? JSON.parse(row.trigger_context) : undefined,
      createdAt: row.created_at,
    };
  }
}

/**
 * 记录人格事件
 *
 * @param eventType 事件类型
 * @param agentId Agent ID
 * @param context 触发上下文
 * @param db 数据库客户端
 * @returns 人格事件
 */
export async function recordPersonalityEvent(eventType: string, agentId: string, context: Record<string, any>, db: DatabaseClient): Promise<PersonalityEvent> {
  // 获取人格增量
  const personalityDelta = EVENT_PERSONALITY_IMPACT[eventType] || {};

  const event: PersonalityEvent = {
    id: `event_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    agentId,
    eventType: eventType as any,
    personalityDelta,
    triggerContext: context,
    createdAt: new Date().toISOString(),
  };

  // 持久化
  const sql = `
    INSERT INTO personality_events (
      id, agent_id, event_type, personality_delta, trigger_context, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `;
  await db.execute(sql, [event.id, event.agentId, event.eventType, JSON.stringify(event.personalityDelta), JSON.stringify(event.triggerContext || {}), event.createdAt]);

  return event;
}
