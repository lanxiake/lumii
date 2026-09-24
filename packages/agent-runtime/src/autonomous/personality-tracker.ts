/**
 * 人格追踪系统
 *
 * 使用 Big Five 模型和 EMA 算法追踪 Agent 人格演化
 * 来源：设计文档 5-人格追踪系统.md
 *
 * 出生：首次读到某 agent 时抽一次签（`rollInnateTraits`）并落库，此后永不再掷；
 * 同时写一份出生快照供「它变了没有」对照（宠物智能化设计 §3.2/§3.3）。
 */

import type { PersonalityState, PersonalityEvent, PersonalityConfig } from './types';
import type { DatabaseClient } from './meta-cognition-engine';
import type { DatabaseAdapter } from '../storage/local-database.js';

/** 出生抽签：截断正态 σ=0.15，clip [0.15, 0.85] */
const INNATE_TRAIT_SIGMA = 0.15;
const INNATE_TRAIT_MIN = 0.15;
const INNATE_TRAIT_MAX = 0.85;

/** 出生快照键：`personality:birth:{agentId}` */
const BIRTH_SNAPSHOT_KEY_PREFIX = 'personality:birth:';

/** Big Five 五维原始值（不含元数据） */
export type InnateTraits = Omit<PersonalityState, 'lastUpdated' | 'updateCount'>;

/** 出生快照（设计 §3.3） */
export interface BirthSnapshot {
  /** 抽签时刻。存量装上这是升级时间、不是出生时间——见 `migrated` */
  at: string;
  traits: InnateTraits;
  /** 升级时补抽的签：经历页要说「性格记录始于 X 日」而不是「出生」 */
  migrated?: boolean;
}

/**
 * 出生抽签（纯函数）。
 *
 * 用截断正态而不是均匀分布：均匀抽样在五维空间里会大量产出「又极度神经质又极度内向」
 * 的极端个体；σ=0.15 让大多数宠物**正常但有偏向**，少数偏得明显。
 */
export function rollInnateTraits(rng: () => number = Math.random): InnateTraits {
  const draw = (): number => {
    const u = Math.max(rng(), Number.EPSILON); // Box-Muller
    const v = rng();
    const gauss = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.min(INNATE_TRAIT_MAX, Math.max(INNATE_TRAIT_MIN, 0.5 + gauss * INNATE_TRAIT_SIGMA));
  };

  return {
    openness: draw(),
    conscientiousness: draw(),
    extraversion: draw(),
    agreeableness: draw(),
    neuroticism: draw(),
  };
}

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

/** Big Five 五个维度（不含元数据字段） */
const PERSONALITY_DIMENSIONS: Array<keyof Omit<PersonalityState, 'lastUpdated' | 'updateCount'>> = [
  'openness',
  'conscientiousness',
  'extraversion',
  'agreeableness',
  'neuroticism',
];

/**
 * P2: 校验人格状态各维度是否在 [0, 1] 内且为有限数
 */
export function validatePersonalityState(state: PersonalityState): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const dim of PERSONALITY_DIMENSIONS) {
    const value = state[dim] as number;
    if (!Number.isFinite(value)) {
      errors.push(`${dim} 不是有限数：${value}`);
    } else if (value < 0 || value > 1) {
      errors.push(`${dim} 超出 [0, 1]：${value}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * P2: 描述人格变更（用于审计日志，只包含实际发生变化的维度）
 */
export function describePersonalityChange(
  before: PersonalityState,
  after: PersonalityState,
): Record<string, { before: number; after: number; delta: number }> {
  const changes: Record<string, { before: number; after: number; delta: number }> = {};

  for (const dim of PERSONALITY_DIMENSIONS) {
    const b = before[dim] as number;
    const a = after[dim] as number;
    if (b !== a) {
      changes[dim] = { before: b, after: a, delta: a - b };
    }
  }

  return changes;
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

      // 首次读到 = 出生：抽一次签并落库，此后永不再掷（设计 §3.2）
      const traits = rollInnateTraits();
      const defaultState: PersonalityState = {
        ...traits,
        lastUpdated: new Date().toISOString(),
        updateCount: 0,
      };

      await this.saveState(agentId, defaultState);
      await this.writeBirthSnapshot(agentId, traits);
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

      // P2: 人格追踪可整体关闭；关闭时不改变状态（P0/P1 的 EMA 追踪行为不受
      // evolutionEnabled 影响，该开关保留给 P3 的人格主动进化）
      if (!this.config.trackingEnabled) {
        console.info('[PersonalityTracker] 人格追踪已关闭，跳过状态更新', {
          event: 'personality-tracking-disabled',
          agentId,
          eventType: event.eventType,
        });
        return currentState;
      }

      // 应用 EMA 更新
      const updatedState = applyEMA(currentState, event.personalityDelta, this.config.emaAlpha);

      // 更新元数据
      updatedState.lastUpdated = new Date().toISOString();
      updatedState.updateCount = currentState.updateCount + 1;

      // P2: 更新后边界校验，任一维度越界则放弃本次更新
      const validation = validatePersonalityState(updatedState);
      if (!validation.valid) {
        console.error('[PersonalityTracker] 人格更新越界，已放弃本次更新', {
          event: 'personality-update-rejected',
          agentId,
          errors: validation.errors,
        });
        return currentState;
      }

      // 持久化
      await this.saveState(agentId, updatedState);

      // P2: 变更审计（记录前后差值，便于解释和回滚）
      console.info('[PersonalityTracker] 人格状态已更新', {
        event: 'personality-updated',
        agentId,
        eventType: event.eventType,
        emaAlpha: this.config.emaAlpha,
        updateCount: updatedState.updateCount,
        changes: describePersonalityChange(currentState, updatedState),
      });

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
   * 写出生快照 `personality:birth:{agentId}`。只在缺失时写一次（不重掷）。
   *
   * **best-effort**：快照是给「成长对照」看的旁证，写不进去不能连累出生抽签
   * ——否则 `getCurrentState` 会掉进 catch 返回中性值，而抽签结果其实已经落库了。
   */
  private async writeBirthSnapshot(agentId: string, traits: InnateTraits): Promise<void> {
    const key = `${BIRTH_SNAPSHOT_KEY_PREFIX}${agentId}`;
    try {
      const existing = await this.db.query<{ value: string }>(
        `SELECT value FROM runtime_state WHERE key = ?`,
        [key],
      );
      if (existing.length > 0) return;

      const snapshot: BirthSnapshot = { at: new Date().toISOString(), traits };
      if (await this.isExistingInstall()) snapshot.migrated = true;

      await this.db.execute(
        `INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [key, JSON.stringify(snapshot), snapshot.at],
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.warn('[PersonalityTracker] 出生快照写入失败（不影响抽签结果）:', err.message);
    }
  }

  /**
   * 这是不是「存量装」：宠物人格上线前用户就已经在用它了。
   *
   * 拿最老最全的 `messages` 表当探针——有历史消息说明宠物早就存在，此时抽签的 `at`
   * 是**升级时间**而不是出生时间，经历页必须改口（设计 §3.3）。探不到就按新装算：
   * 「说是出生但其实更早」比「说是记录开始但其实更晚」伤害小。
   */
  private async isExistingInstall(): Promise<boolean> {
    try {
      const rows = await this.db.query<{ x: number }>('SELECT 1 AS x FROM messages LIMIT 1');
      return rows.length > 0;
    } catch {
      return false;
    }
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

/**
 * 记一次人格事件**并立刻应用**它的影响（第七期 T7.3）。
 *
 * 协调器里那两处（`autonomous-coordinator.ts`）是分两步写的：先
 * `recordPersonalityEvent(...)` 落事件表，再 `tracker.updatePersonality(...)` 跑 EMA。
 * 两步之间的那个缺口很危险，因为**它们各自都不报错**：
 *
 * | 只做了 | 现象 |
 * |---|---|
 * | 只落事件表 | `personality_events` 有行、`personality_state.update_count` 仍是 0 |
 * | 只跑 EMA | 性格变了，但没人知道因为什么（事件表是审计） |
 *
 * 而"它到底变了没有"这个问题，两边会给出**相反的答案**——这正是宠物侧
 * 2026-09-24 真机上的实况（`update_count = 0` 而设计以为演化在跑）。
 * 合成一个函数，调用方就没有"只做一半"这个选项。
 *
 * 不吞异常：调用方要能自己决定失败怎么办（宠物侧一律只记日志，
 * 演进失败不该影响一次已经跑完的任务）。
 */
export async function applyPersonalityEvent(
  eventType: string,
  agentId: string,
  context: Record<string, any>,
  db: DatabaseClient,
  tracker: PersonalityTracker,
): Promise<PersonalityState> {
  const event = await recordPersonalityEvent(eventType, agentId, context, db);
  return tracker.updatePersonality(agentId, event);
}

/**
 * 读出生快照（`personality:birth:{agentId}`）。
 *
 * 单独一个 **sync + `DatabaseAdapter`** 的读口：写它的是 tracker 内部（async 客户端），
 * 而读它的那两处（设置页的气质标签、经历页的"出生时什么样"）手上只有同步的
 * `DatabaseAdapter`。为一次主键读去装一整个 `PersonalityTracker` 是绕远路。
 *
 * 读不到 / 坏数据一律 `null` —— 调用方据此说"还不知道"，**不要拿 0.5 编一个中性气质**
 * （§3.6：用户看到的是气质标签，编出来的标签比没有更糟）。
 */
export function readBirthSnapshot(db: DatabaseAdapter, agentId: string): BirthSnapshot | null {
  try {
    const row = db
      .prepare<{ value: string }>(`SELECT value FROM runtime_state WHERE key = ?`)
      .get(`${BIRTH_SNAPSHOT_KEY_PREFIX}${agentId}`);
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as BirthSnapshot;
    if (!parsed?.traits || typeof parsed.at !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}
