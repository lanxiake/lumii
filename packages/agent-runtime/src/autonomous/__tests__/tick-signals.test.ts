import { describe, expect, it } from 'vitest';
import { decideAction, collectTickSignals } from '../tick-signals';

function makeDb(goals: unknown[] = [], reflections: unknown[] = []) {
  return {
    prepare: (sql: string) => ({
      all: () => {
        if (sql.includes('FROM autonomous_goals')) return goals;
        if (sql.includes('FROM reflections')) return reflections;
        return [];
      },
      get: () => undefined,
    }),
  } as never;
}

const emptySignals = {
  approvedGoalCount: 0,
  approvedGoals: [] as Array<{ id: string; type: string; description: string }>,
  outreachUsedToday: 0,
  outreachLimit: 20,
  outreachLastSentAt: null as number | null,
  minOutreachIntervalMinutes: 60,
  reflectionDue: false,
  diaryDue: false,
  tokenUsedToday: 0,
  tokenLimit: 100000,
  willDoHeavyWork: true,
  outreachMultiplier: 1,
  selfCheckBias: false,
  stuckGoalCount: 0,
};

describe('decideAction', () => {
  it('空信号 → idle', () => {
    expect(decideAction(emptySignals).kind).toBe('idle');
  });

  it('proactive-message 预算内 → outreach', () => {
    const action = decideAction({
      ...emptySignals,
      approvedGoalCount: 1,
      approvedGoals: [{ id: 'g1', type: 'proactive-message', description: '问候' }],
      outreachUsedToday: 3,
    });
    expect(action.kind).toBe('outreach');
  });

  it('proactive-message 预算用尽 → 跳过并执行其他目标', () => {
    const action = decideAction({
      ...emptySignals,
      approvedGoalCount: 2,
      approvedGoals: [
        { id: 'g1', type: 'proactive-message', description: '问候' },
        { id: 'g2', type: 'learning', description: '学习' },
      ],
      outreachUsedToday: 20,
    });
    expect(action.kind).toBe('execute-goal');
    expect(action.goal?.id).toBe('g2');
  });

  it('其它目标 → execute-goal', () => {
    const action = decideAction({
      ...emptySignals,
      approvedGoalCount: 1,
      approvedGoals: [{ id: 'g2', type: 'learning', description: '学习' }],
    });
    expect(action.kind).toBe('execute-goal');
  });

  it('该反思且无目标 → reflect', () => {
    const action = decideAction({ ...emptySignals, reflectionDue: true });
    expect(action.kind).toBe('reflect');
  });

  it('该反思但有目标 → 目标优先', () => {
    const action = decideAction({
      ...emptySignals,
      approvedGoalCount: 1,
      approvedGoals: [{ id: 'g2', type: 'learning', description: '学习' }],
      reflectionDue: true,
    });
    expect(action.kind).toBe('execute-goal');
  });

  it('该写日记且无目标 → diary', () => {
    const action = decideAction({ ...emptySignals, diaryDue: true });
    expect(action.kind).toBe('diary');
  });

  it('日记与反思同时到期 → 日记优先', () => {
    const action = decideAction({ ...emptySignals, diaryDue: true, reflectionDue: true });
    expect(action.kind).toBe('diary');
  });

  it('token 超限时执行目标 → idle（token-budget-exhausted）', () => {
    const action = decideAction({
      ...emptySignals,
      approvedGoalCount: 1,
      approvedGoals: [{ id: 'g2', type: 'learning', description: '学习' }],
      tokenUsedToday: 95000,
      tokenLimit: 100000,
    });
    expect(action.kind).toBe('idle');
    expect(action.reason).toBe('token-budget-exhausted');
  });

  it('token 超限时反思 → idle', () => {
    const action = decideAction({
      ...emptySignals,
      reflectionDue: true,
      tokenUsedToday: 100000,
      tokenLimit: 100000,
    });
    expect(action.kind).toBe('idle');
    expect(action.reason).toBe('token-budget-exhausted');
  });

  it('主动消息不受 token 预算限制（不烧 LLM）', () => {
    const action = decideAction({
      ...emptySignals,
      approvedGoalCount: 1,
      approvedGoals: [{ id: 'g1', type: 'proactive-message', description: '问候' }],
      tokenUsedToday: 100000,
      tokenLimit: 100000,
    });
    expect(action.kind).toBe('outreach');
  });

  it('proactive-message 间隔未到 → 跳过不发送', () => {
    const now = new Date(2026, 8, 6, 10, 0, 0);
    const action = decideAction(
      {
        ...emptySignals,
        approvedGoalCount: 1,
        approvedGoals: [{ id: 'g1', type: 'proactive-message', description: '问候' }],
        outreachUsedToday: 3,
        outreachLastSentAt: new Date(2026, 8, 6, 9, 50, 0).getTime(), // 10 分钟前
        minOutreachIntervalMinutes: 60,
      },
      now,
    );
    expect(action.kind).toBe('idle');
  });

  it('proactive-message 间隔已满足 → outreach', () => {
    const now = new Date(2026, 8, 6, 10, 0, 0);
    const action = decideAction(
      {
        ...emptySignals,
        approvedGoalCount: 1,
        approvedGoals: [{ id: 'g1', type: 'proactive-message', description: '问候' }],
        outreachUsedToday: 3,
        outreachLastSentAt: new Date(2026, 8, 6, 8, 0, 0).getTime(), // 2 小时前
        minOutreachIntervalMinutes: 60,
      },
      now,
    );
    expect(action.kind).toBe('outreach');
  });

  it('proactive-message 间隔未到但有其它目标 → 执行其它目标', () => {
    const now = new Date(2026, 8, 6, 10, 0, 0);
    const action = decideAction(
      {
        ...emptySignals,
        approvedGoalCount: 2,
        approvedGoals: [
          { id: 'g1', type: 'proactive-message', description: '问候' },
          { id: 'g2', type: 'learning', description: '学习' },
        ],
        outreachUsedToday: 3,
        outreachLastSentAt: new Date(2026, 8, 6, 9, 50, 0).getTime(),
        minOutreachIntervalMinutes: 60,
      },
      now,
    );
    expect(action.kind).toBe('execute-goal');
    expect(action.goal?.id).toBe('g2');
  });

  it('低 energy → 跳过重活（目标执行）', () => {
    const action = decideAction({
      ...emptySignals,
      approvedGoalCount: 1,
      approvedGoals: [{ id: 'g2', type: 'learning', description: '学习' }],
      willDoHeavyWork: false,
    });
    expect(action.kind).toBe('idle');
    expect(action.reason).toBe('low-energy');
  });

  it('低 valence → outreach 有效上限减半', () => {
    const action = decideAction({
      ...emptySignals,
      approvedGoalCount: 1,
      approvedGoals: [{ id: 'g1', type: 'proactive-message', description: '问候' }],
      outreachUsedToday: 12,
      outreachMultiplier: 0.5,
    });
    // 有效上限 = floor(20 * 0.5) = 10；已用 12 ≥ 10 → 不发
    expect(action.kind).toBe('idle');
  });

  it('心情差 → execute-goal 携带审慎标记', () => {
    const action = decideAction({
      ...emptySignals,
      approvedGoalCount: 1,
      approvedGoals: [{ id: 'g2', type: 'learning', description: '学习' }],
      selfCheckBias: true,
    });
    expect(action.kind).toBe('execute-goal');
    expect(action.selfCheckBias).toBe(true);
  });
});

describe('collectTickSignals', () => {
  it('收集已批准目标与 outreach 用量', () => {
    const db = makeDb([{ id: 'g1', type: 'learning', description: '学习' }]);
    const signals = collectTickSignals(db, 'assistant', new Date(2026, 8, 6, 10, 0, 0));
    expect(signals.approvedGoalCount).toBe(1);
    expect(signals.outreachUsedToday).toBe(0);
    expect(signals.outreachLimit).toBe(20);
    expect(signals.reflectionDue).toBe(false); // 白天不反思
  });

  it('静默时段且从未反思 → reflectionDue 为 true', () => {
    const db = makeDb([]);
    const signals = collectTickSignals(db, 'assistant', new Date(2026, 8, 6, 23, 30, 0));
    expect(signals.reflectionDue).toBe(true);
  });

  it('静默时段且距上次反思不足 24h → reflectionDue 为 false', () => {
    const db = makeDb([], [{ created_at: new Date(2026, 8, 6, 20, 0, 0).toISOString() }]);
    const signals = collectTickSignals(db, 'assistant', new Date(2026, 8, 6, 23, 30, 0));
    expect(signals.reflectionDue).toBe(false);
  });

  it('深夜昼夜节律压低能量 → 不做重活', () => {
    const db = makeDb([{ id: 'g2', type: 'learning', description: '学习' }]);
    const signals = collectTickSignals(db, 'assistant', new Date(2026, 8, 6, 3, 0, 0));
    expect(signals.willDoHeavyWork).toBe(false);
  });

  it('午间昼夜节律 → 正常做重活', () => {
    const db = makeDb([]);
    const signals = collectTickSignals(db, 'assistant', new Date(2026, 8, 6, 12, 0, 0));
    expect(signals.willDoHeavyWork).toBe(true);
  });

  it('到期过滤：未来 scheduled_for 的目标不派发，到期/被动的派发', () => {
    const now = new Date(2026, 8, 6, 10, 0, 0);
    const db = makeDb([
      { id: 'g-future', type: 'learning', description: '未来', scheduled_for: new Date(2026, 8, 6, 11, 0, 0).toISOString() },
      { id: 'g-past', type: 'learning', description: '过去', scheduled_for: new Date(2026, 8, 6, 9, 0, 0).toISOString() },
      { id: 'g-none', type: 'learning', description: '被动', scheduled_for: null },
    ]);
    const signals = collectTickSignals(db, 'assistant', now);
    expect(signals.approvedGoalCount).toBe(2);
    expect(signals.approvedGoals.map((g) => g.id)).toEqual(['g-past', 'g-none']);
  });

  it('卡死检测：批准时间早于阈值仍未完成的目标计入 stuckGoalCount', () => {
    const now = new Date(2026, 8, 6, 10, 0, 0);
    const stuckApprovedAt = new Date(2026, 8, 4, 10, 0, 0).toISOString();
    const recentApprovedAt = new Date(2026, 8, 6, 9, 0, 0).toISOString();
    const db = makeDb([
      { id: 'g-stuck', type: 'learning', description: '卡死', approved_at: stuckApprovedAt, created_at: stuckApprovedAt },
      { id: 'g-ok', type: 'learning', description: '正常', approved_at: recentApprovedAt, created_at: recentApprovedAt },
    ]);
    const signals = collectTickSignals(db, 'assistant', now);
    expect(signals.stuckGoalCount).toBe(1);
  });
});
