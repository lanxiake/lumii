import { describe, expect, it } from 'vitest';
import { readSettings, writeSettings, DEFAULT_SETTINGS } from '../settings';

function makeDb(initial?: string) {
  const store: Record<string, string> = {};
  if (initial !== undefined) store['autonomous.settings'] = initial;
  return {
    prepare: () => ({
      get: (key: string) => (key in store ? { value: store[key] } : undefined),
      run: (key: string, value: string) => { store[key] = value; },
    }),
    _store: store,
  } as never;
}

describe('readSettings', () => {
  it('无记录返回默认值', () => {
    expect(readSettings(makeDb())).toEqual(DEFAULT_SETTINGS);
  });

  it('用户覆盖合并不丢默认', () => {
    const s = readSettings(makeDb(JSON.stringify({ maxOutreachPerDay: 5 })));
    expect(s.maxOutreachPerDay).toBe(5);
    expect(s.tickIntervalMinutes).toBe(DEFAULT_SETTINGS.tickIntervalMinutes);
    expect(s.approvalMode).toBe('always');
  });

  it('非法值回落默认', () => {
    const s = readSettings(makeDb(JSON.stringify({ tickIntervalMinutes: 999 })));
    expect(s.tickIntervalMinutes).toBe(DEFAULT_SETTINGS.tickIntervalMinutes);
  });

  it('越界 maxOutreachPerDay 回落默认', () => {
    const s = readSettings(makeDb(JSON.stringify({ maxOutreachPerDay: -1 })));
    expect(s.maxOutreachPerDay).toBe(DEFAULT_SETTINGS.maxOutreachPerDay);
  });
});

describe('writeSettings', () => {
  it('部分覆盖写回', () => {
    const db = makeDb();
    writeSettings(db, { maxOutreachPerDay: 3 });
    expect(readSettings(db).maxOutreachPerDay).toBe(3);
  });
});
