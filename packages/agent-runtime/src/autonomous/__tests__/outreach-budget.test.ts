import { describe, expect, it } from 'vitest';
import { canSendOutreach, recordOutreach, getOutreachUsedToday } from '../outreach-budget';

function makeDb(initial: Record<string, string> = {}) {
  const store = { ...initial };
  return {
    prepare: () => ({
      get: (key: string) => (key in store ? { value: store[key] } : undefined),
      run: (key: string, value: string) => {
        store[key] = value;
      },
    }),
    _store: store,
  } as never;
}

const NOW = new Date(2026, 8, 6, 10, 0, 0); // 本地时间 2026-09-06 10:00

describe('outreach-budget', () => {
  it('无记录时今日用量为 0', () => {
    expect(getOutreachUsedToday(makeDb(), NOW)).toBe(0);
  });

  it('recordOutreach 递增计数', () => {
    const db = makeDb();
    recordOutreach(db, NOW);
    recordOutreach(db, NOW);
    expect(getOutreachUsedToday(db, NOW)).toBe(2);
  });

  it('达到上限后 canSendOutreach 返回 false', () => {
    const db = makeDb();
    for (let i = 0; i < 20; i += 1) recordOutreach(db, NOW);
    expect(canSendOutreach(db, NOW, 20)).toBe(false);
  });

  it('未达上限时可发送', () => {
    const db = makeDb();
    for (let i = 0; i < 19; i += 1) recordOutreach(db, NOW);
    expect(canSendOutreach(db, NOW, 20)).toBe(true);
  });

  it('跨天自动归零', () => {
    const db = makeDb();
    recordOutreach(db, NOW);
    const nextDay = new Date(2026, 8, 7, 0, 0, 0);
    expect(getOutreachUsedToday(db, nextDay)).toBe(0);
  });
});
