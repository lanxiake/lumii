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
import { createMigratedTestDb } from '../../__tests__/helpers/sqlite-test-db.js';

/** 日记防重用例的默认主体 */
const AGENT = 'assistant';

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
  it('同日第二次不生成（按 agent 分账）', () => {
    const db = createMigratedTestDb();
    const now = new Date(2026, 8, 6, 23, 0, 0);

    expect(hasWrittenDiaryToday(db, AGENT, now)).toBe(false);
    markDiaryWritten(db, AGENT, now);
    expect(hasWrittenDiaryToday(db, AGENT, now)).toBe(true);
  });

  /**
   * ★ 2026-09-24：防重键**按 agent 分**。
   *
   * 此前它是全局单键 `autonomous.last_diary_date` —— 语义是"一天只能有一个人写日记"：
   * 助手写了，宠物那天就**静默地**写不了（反之亦然），而两边都不会报错。
   *
   * ⚠ 这个文件此前用**手搓的 mock db**（`{prepare: () => ({get, run})}`）测这条，
   * 改签名后 mock 照样"通过"——它把 `Date` 当成了 agentId 去拼键。
   * 现在改用真实迁移库（与 `pet-sensing.test.ts` / `mood.test.ts` 同一套助手），
   * 顺带说明为什么：**这个包的 tsconfig 排除了 `*.test.ts`**，类型错了没人拦。
   */
  it('★ 两个主体各记各的（助手写过不影响宠物）', () => {
    const db = createMigratedTestDb();
    const now = new Date(2026, 8, 6, 23, 0, 0);
    const pet = 'pet:demo_cartoon_cat';

    markDiaryWritten(db, AGENT, now);
    expect(hasWrittenDiaryToday(db, AGENT, now)).toBe(true);
    expect(hasWrittenDiaryToday(db, pet, now)).toBe(false);

    markDiaryWritten(db, pet, now);
    expect(hasWrittenDiaryToday(db, pet, now)).toBe(true);
  });

  it('跨天归零', () => {
    const db = createMigratedTestDb();
    markDiaryWritten(db, AGENT, new Date(2026, 8, 6, 23, 0, 0));
    expect(hasWrittenDiaryToday(db, AGENT, new Date(2026, 8, 7, 9, 0, 0))).toBe(false);
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
