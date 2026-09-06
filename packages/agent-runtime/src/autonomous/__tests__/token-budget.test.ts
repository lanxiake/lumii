import { describe, expect, it } from 'vitest';
import {
  TOKEN_COST,
  readTodayTokenUsage,
  recordTokenUsage,
  canSpendTokens,
} from '../token-budget';

function makeDb() {
  const store: Record<string, string> = {};
  return {
    prepare: () => ({
      get: (key: string) => (key in store ? { value: store[key] } : undefined),
      run: (key: string, value: string) => { store[key] = value; },
    }),
    _store: store,
  } as never;
}

const NOW = new Date(2026, 8, 6, 12, 0, 0);

describe('readTodayTokenUsage', () => {
  it('无记录返回 0', () => {
    expect(readTodayTokenUsage(makeDb(), NOW)).toBe(0);
  });

  it('脏数据按 0', () => {
    const db = makeDb();
    db._store['autonomous.tokens.2026-09-06'] = 'not-a-number';
    expect(readTodayTokenUsage(db, NOW)).toBe(0);
  });
});

describe('recordTokenUsage', () => {
  it('累加今日消耗', () => {
    const db = makeDb();
    recordTokenUsage(db, NOW, 8000);
    recordTokenUsage(db, NOW, 5000);
    expect(readTodayTokenUsage(db, NOW)).toBe(13000);
  });

  it('跨天自然重置（不同日期键）', () => {
    const db = makeDb();
    recordTokenUsage(db, NOW, 8000);
    const tomorrow = new Date(2026, 8, 7, 0, 30, 0);
    expect(readTodayTokenUsage(db, tomorrow)).toBe(0);
  });

  it('非正数不记录', () => {
    const db = makeDb();
    recordTokenUsage(db, NOW, 0);
    recordTokenUsage(db, NOW, -100);
    expect(readTodayTokenUsage(db, NOW)).toBe(0);
  });
});

describe('canSpendTokens', () => {
  it('预算内允许', () => {
    expect(canSpendTokens(makeDb(), NOW, 8000, 100000)).toBe(true);
  });

  it('超限拒绝', () => {
    const db = makeDb();
    recordTokenUsage(db, NOW, 95000);
    expect(canSpendTokens(db, NOW, TOKEN_COST.executeGoal, 100000)).toBe(false);
  });
});
