import { describe, expect, it } from 'vitest';
import {
  DIARY_PROMPT,
  buildDiaryContext,
  hasWrittenDiaryToday,
  markDiaryWritten,
} from '../diary';

describe('DIARY_PROMPT', () => {
  it('含防指标/表演情绪的关键约束', () => {
    expect(DIARY_PROMPT).toContain('平淡');
    expect(DIARY_PROMPT).toContain('别凑字数');
    expect(DIARY_PROMPT).toContain('满意度');
    expect(DIARY_PROMPT).toContain('第一人称');
  });
});

describe('buildDiaryContext', () => {
  it('聚合 goals/insights/concerns 五块', () => {
    const ctx = buildDiaryContext({
      goals: [
        { description: '完成A', status: 'completed' },
        { description: '完成B', status: 'failed' },
      ],
      reflections: [{ primaryIssue: '检索不准' }],
      concerns: [
        {
          id: 'c1', description: '在意的事', origin: 's1',
          arousalWeight: 0.5, raisedCount: 0, nextRaiseAfter: 0, status: 'open',
        },
        {
          id: 'c2', description: '已解决', origin: 's2',
          arousalWeight: 0.5, raisedCount: 0, nextRaiseAfter: 0, status: 'resolved',
        },
      ],
      mood: { energy: 0.6, valence: 0.2, arousal: 0.5, updatedAt: 0 },
    });
    expect(ctx.goalsCompleted).toEqual(['完成A']);
    expect(ctx.goalsFailed).toEqual(['完成B']);
    expect(ctx.insights).toEqual(['检索不准']);
    expect(ctx.concerns).toEqual(['在意的事']);
  });
});

describe('日记防重', () => {
  it('同日第二次不生成', () => {
    const now = new Date(2026, 8, 6, 23, 0, 0);
    const store: Record<string, string> = {};
    const db = {
      prepare: () => ({
        get: (key: string) => (key in store ? { value: store[key] } : undefined),
        run: (key: string, value: string) => { store[key] = value; },
      }),
    } as never;

    expect(hasWrittenDiaryToday(db, now)).toBe(false);
    markDiaryWritten(db, now);
    expect(hasWrittenDiaryToday(db, now)).toBe(true);
  });
});
