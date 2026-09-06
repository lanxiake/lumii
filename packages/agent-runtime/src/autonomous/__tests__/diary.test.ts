import { describe, expect, it, vi } from 'vitest';
import {
  DIARY_PROMPT,
  buildDiaryContext,
  hasWrittenDiaryToday,
  markDiaryWritten,
  saveDiary,
  listRecentDiaries,
  todayDateKey,
} from '../diary';

describe('DIARY_PROMPT', () => {
  it('含防指标/表演情绪的关键约束', () => {
    expect(DIARY_PROMPT).toContain('平淡');
    expect(DIARY_PROMPT).toContain('凑篇幅');
    expect(DIARY_PROMPT).toContain('满意度');
    expect(DIARY_PROMPT).toContain('第一人称');
  });

  it('含历史日记连续性指引', () => {
    expect(DIARY_PROMPT).toContain('最近的日记');
    expect(DIARY_PROMPT).toContain('续写');
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

  it('格式化历史日记为「日期：正文」', () => {
    const ctx = buildDiaryContext({
      goals: [],
      reflections: [],
      concerns: [],
      mood: { energy: 0.6, valence: 0.2, arousal: 0.5, updatedAt: 0 },
      recentDiaries: [
        { diaryDate: '2026-09-05', content: '昨天在想 X' },
        { diaryDate: '2026-09-04', content: '前天很平淡' },
      ],
    });
    expect(ctx.recentDiaries).toEqual(['2026-09-05：昨天在想 X', '2026-09-04：前天很平淡']);
  });

  it('缺省 recentDiaries 时为空数组', () => {
    const ctx = buildDiaryContext({
      goals: [],
      reflections: [],
      concerns: [],
      mood: { energy: 0.6, valence: 0.2, arousal: 0.5, updatedAt: 0 },
    });
    expect(ctx.recentDiaries).toEqual([]);
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

describe('日记表读写', () => {
  it('saveDiary 落一行，列顺序正确', () => {
    const run = vi.fn();
    const db = { prepare: () => ({ run }) } as never;
    saveDiary(db, 'assistant', '2026-09-06', '今天的内容');
    expect(run).toHaveBeenCalledTimes(1);
    const args = run.mock.calls[0];
    expect(args[1]).toBe('assistant');
    expect(args[2]).toBe('2026-09-06');
    expect(args[3]).toBe('今天的内容');
  });

  it('listRecentDiaries 映射列名并返回对象', () => {
    const db = {
      prepare: () => ({
        all: () => [
          { diary_date: '2026-09-06', content: '今天' },
          { diary_date: '2026-09-05', content: '昨天' },
        ],
      }),
    } as never;
    const rows = listRecentDiaries(db, 'assistant', 5);
    expect(rows).toEqual([
      { diaryDate: '2026-09-06', content: '今天' },
      { diaryDate: '2026-09-05', content: '昨天' },
    ]);
  });
});

describe('todayDateKey', () => {
  it('返回 YYYY-MM-DD', () => {
    expect(todayDateKey(new Date(2026, 8, 6))).toBe('2026-09-06');
  });
});
