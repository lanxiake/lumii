/**
 * 人格追踪器测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  applyEMA,
  PersonalityTracker,
  recordPersonalityEvent,
  EVENT_PERSONALITY_IMPACT,
} from '../personality-tracker';
import type { PersonalityState, PersonalityEvent } from '../types';
import type { DatabaseClient } from '../meta-cognition-engine';
import { EMA_ALPHA } from '../config';

describe('EMA 更新算法', () => {
  it('应正确应用 EMA 公式', () => {
    const currentState: PersonalityState = {
      openness: 0.5,
      conscientiousness: 0.5,
      extraversion: 0.5,
      agreeableness: 0.5,
      neuroticism: 0.5,
      lastUpdated: new Date().toISOString(),
      updateCount: 0,
    };

    const delta: Partial<PersonalityState> = {
      openness: 0.02,
      conscientiousness: 0.01,
    };

    const updated = applyEMA(currentState, delta, EMA_ALPHA);

    // openness: 0.5 + 0.05 * 0.02 = 0.501
    expect(updated.openness).toBeCloseTo(0.501, 3);
    // conscientiousness: 0.5 + 0.05 * 0.01 = 0.5005
    expect(updated.conscientiousness).toBeCloseTo(0.5005, 4);
    // 其他维度不变
    expect(updated.extraversion).toBe(0.5);
  });

  it('应限制维度值在 [0, 1] 区间', () => {
    const currentState: PersonalityState = {
      openness: 0.95,
      conscientiousness: 0.05,
      extraversion: 0.5,
      agreeableness: 0.5,
      neuroticism: 0.5,
      lastUpdated: new Date().toISOString(),
      updateCount: 0,
    };

    const delta: Partial<PersonalityState> = {
      openness: 2.0, // 极端增量
      conscientiousness: -2.0,
    };

    const updated = applyEMA(currentState, delta, 0.1);

    expect(updated.openness).toBe(1.0); // 截断到 1.0
    expect(updated.conscientiousness).toBe(0.0); // 截断到 0.0
  });

  it('应保持不可变更新', () => {
    const currentState: PersonalityState = {
      openness: 0.5,
      conscientiousness: 0.5,
      extraversion: 0.5,
      agreeableness: 0.5,
      neuroticism: 0.5,
      lastUpdated: new Date().toISOString(),
      updateCount: 0,
    };

    const delta: Partial<PersonalityState> = {
      openness: 0.02,
    };

    const updated = applyEMA(currentState, delta, EMA_ALPHA);

    expect(currentState.openness).toBe(0.5); // 原对象不变
    expect(updated).not.toBe(currentState);
  });
});

describe('人格事件映射', () => {
  it('goal-generated 应影响 openness 和 conscientiousness', () => {
    const impact = EVENT_PERSONALITY_IMPACT['goal-generated'];

    expect(impact.openness).toBe(0.02);
    expect(impact.conscientiousness).toBe(0.01);
  });

  it('evolution-decided 应影响 openness 和 conscientiousness', () => {
    const impact = EVENT_PERSONALITY_IMPACT['evolution-decided'];

    expect(impact.openness).toBe(0.03);
    expect(impact.conscientiousness).toBe(-0.01); // 降低
  });

  it('user-feedback-positive 应影响 agreeableness 和 neuroticism', () => {
    const impact = EVENT_PERSONALITY_IMPACT['user-feedback-positive'];

    expect(impact.agreeableness).toBe(0.02);
    expect(impact.neuroticism).toBe(-0.02); // 降低
  });

  it('user-feedback-negative 应影响 neuroticism 和 conscientiousness', () => {
    const impact = EVENT_PERSONALITY_IMPACT['user-feedback-negative'];

    expect(impact.neuroticism).toBe(0.03);
    expect(impact.conscientiousness).toBe(0.02);
  });

  it('error-handled 应影响 conscientiousness 和 neuroticism', () => {
    const impact = EVENT_PERSONALITY_IMPACT['error-handled'];

    expect(impact.conscientiousness).toBe(0.02);
    expect(impact.neuroticism).toBe(0.01);
  });
});

describe('PersonalityTracker', () => {
  let mockDb: DatabaseClient;
  let tracker: PersonalityTracker;

  beforeEach(() => {
    mockDb = {
      execute: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
    };

    tracker = new PersonalityTracker(
      {
        emaAlpha: EMA_ALPHA,
        eventWeights: {},
        trackingEnabled: true,
        evolutionEnabled: false,
      },
      mockDb,
    );
  });

  it('首次获取应返回默认中性状态', async () => {
    mockDb.query = vi.fn().mockResolvedValue([]);

    const state = await tracker.getCurrentState('agent1');

    expect(state.openness).toBe(0.5);
    expect(state.conscientiousness).toBe(0.5);
    expect(state.extraversion).toBe(0.5);
    expect(state.agreeableness).toBe(0.5);
    expect(state.neuroticism).toBe(0.5);
    expect(state.updateCount).toBe(0);
  });

  it('应正确加载现有状态', async () => {
    const mockState = {
      agent_id: 'agent1',
      openness: 0.6,
      conscientiousness: 0.7,
      extraversion: 0.5,
      agreeableness: 0.55,
      neuroticism: 0.45,
      update_count: 5,
      last_updated: new Date().toISOString(),
    };
    mockDb.query = vi.fn().mockResolvedValue([mockState]);

    const state = await tracker.getCurrentState('agent1');

    expect(state.openness).toBe(0.6);
    expect(state.updateCount).toBe(5);
  });

  it('应正确更新人格状态', async () => {
    const initialState = {
      agent_id: 'agent1',
      openness: 0.5,
      conscientiousness: 0.5,
      extraversion: 0.5,
      agreeableness: 0.5,
      neuroticism: 0.5,
      update_count: 0,
      last_updated: new Date().toISOString(),
    };
    mockDb.query = vi.fn().mockResolvedValue([initialState]);

    const event: PersonalityEvent = {
      id: 'event1',
      agentId: 'agent1',
      eventType: 'goal-generated',
      personalityDelta: {
        openness: 0.02,
        conscientiousness: 0.01,
      },
      createdAt: new Date().toISOString(),
    };

    const updated = await tracker.updatePersonality('agent1', event);

    expect(updated.openness).toBeGreaterThan(0.5);
    expect(updated.updateCount).toBe(1);
    expect(mockDb.execute).toHaveBeenCalled();
  });

  it('应正确累积多次更新', async () => {
    let currentState = {
      agent_id: 'agent1',
      openness: 0.5,
      conscientiousness: 0.5,
      extraversion: 0.5,
      agreeableness: 0.5,
      neuroticism: 0.5,
      update_count: 0,
      last_updated: new Date().toISOString(),
    };

    mockDb.query = vi.fn().mockImplementation(() => Promise.resolve([currentState]));
    mockDb.execute = vi.fn().mockImplementation(async () => {
      // 模拟状态更新
      currentState = { ...currentState, update_count: currentState.update_count + 1 };
    });

    // 第一次更新
    const event1: PersonalityEvent = {
      id: 'event1',
      agentId: 'agent1',
      eventType: 'goal-generated',
      personalityDelta: { openness: 0.02 },
      createdAt: new Date().toISOString(),
    };
    await tracker.updatePersonality('agent1', event1);

    // 第二次更新
    const event2: PersonalityEvent = {
      id: 'event2',
      agentId: 'agent1',
      eventType: 'evolution-decided',
      personalityDelta: { openness: 0.03 },
      createdAt: new Date().toISOString(),
    };
    await tracker.updatePersonality('agent1', event2);

    expect(mockDb.execute).toHaveBeenCalledTimes(2);
  });

  it('应正确查询历史事件', async () => {
    const mockEvents = [
      {
        id: 'event1',
        agent_id: 'agent1',
        event_type: 'goal-generated',
        personality_delta: JSON.stringify({ openness: 0.02 }),
        trigger_context: JSON.stringify({ goalId: 'goal1' }),
        created_at: new Date().toISOString(),
      },
    ];
    mockDb.query = vi.fn().mockResolvedValue(mockEvents);

    const events = await tracker.getPersonalityHistory('agent1', 10);

    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('goal-generated');
    expect(events[0].personalityDelta.openness).toBe(0.02);
  });
});

describe('recordPersonalityEvent', () => {
  let mockDb: DatabaseClient;

  beforeEach(() => {
    mockDb = {
      execute: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
    };
  });

  it('应正确记录事件', async () => {
    const event = await recordPersonalityEvent('goal-generated', 'agent1', { goalId: 'goal1' }, mockDb);

    expect(event.eventType).toBe('goal-generated');
    expect(event.agentId).toBe('agent1');
    expect(event.personalityDelta).toEqual(EVENT_PERSONALITY_IMPACT['goal-generated']);
    expect(mockDb.execute).toHaveBeenCalled();
  });

  it('未知事件类型应使用空增量', async () => {
    const event = await recordPersonalityEvent('unknown-event', 'agent1', {}, mockDb);

    expect(event.personalityDelta).toEqual({});
  });
});
