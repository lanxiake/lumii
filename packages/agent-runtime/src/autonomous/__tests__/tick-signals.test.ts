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
  reflectionDue: false,
  diaryDue: false,
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
});
