/**
 * token 预算的分账与老库迁移。
 *
 * 这一组守的是 T3.2 的全部意义：**宠物跑目标不能记到助手账上**。
 * 用真库（`createMigratedTestDb`）而不是假 DB——迁移里有 `DELETE`，
 * 假 DB 的 run 不返回 changes 会让删除静默失败，测试反而全绿。
 */

import { describe, expect, it } from 'vitest';
import { createMigratedTestDb } from '../../__tests__/helpers/sqlite-test-db';
import { TOKEN_COST, readTodayTokenUsage, recordTokenUsage, canSpendTokens } from '../token-budget';

const NOW = new Date(2026, 8, 6, 12, 0, 0); // 本地时间 2026-09-06 12:00
const TODAY = '2026-09-06';
const ASSISTANT = 'assistant';
const PET = 'pet:demo_cartoon_cat';

type Db = ReturnType<typeof createMigratedTestDb>;

/** 老库现场：直接往 runtime_state 塞一个键 */
function seed(db: Db, key: string, value: string): void {
  db.prepare(`INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)`).run(
    key,
    value,
    new Date().toISOString(),
  );
}

function raw(db: Db, key: string): string | undefined {
  return db.prepare<{ value: string }>(`SELECT value FROM runtime_state WHERE key = ?`).get(key)?.value;
}

describe('token 预算 — 基础行为', () => {
  it('无记录返回 0；脏数据也按 0', () => {
    const db = createMigratedTestDb();
    expect(readTodayTokenUsage(db, ASSISTANT, NOW)).toBe(0);
    seed(db, `autonomous.tokens:${ASSISTANT}:${TODAY}`, 'not-a-number');
    expect(readTodayTokenUsage(db, ASSISTANT, NOW)).toBe(0);
    db.close();
  });

  it('累加今日消耗', () => {
    const db = createMigratedTestDb();
    recordTokenUsage(db, ASSISTANT, NOW, 8000);
    recordTokenUsage(db, ASSISTANT, NOW, 5000);
    expect(readTodayTokenUsage(db, ASSISTANT, NOW)).toBe(13000);
    db.close();
  });

  it('跨天自然重置（不同日期键）', () => {
    const db = createMigratedTestDb();
    recordTokenUsage(db, ASSISTANT, NOW, 8000);
    expect(readTodayTokenUsage(db, ASSISTANT, new Date(2026, 8, 7, 0, 30, 0))).toBe(0);
    db.close();
  });

  it('非正数不记录，且不建键', () => {
    const db = createMigratedTestDb();
    recordTokenUsage(db, ASSISTANT, NOW, 0);
    recordTokenUsage(db, ASSISTANT, NOW, -100);
    expect(readTodayTokenUsage(db, ASSISTANT, NOW)).toBe(0);
    expect(raw(db, `autonomous.tokens:${ASSISTANT}:${TODAY}`)).toBeUndefined();
    db.close();
  });

  it('canSpendTokens：预算内允许，超限拒绝', () => {
    const db = createMigratedTestDb();
    expect(canSpendTokens(db, ASSISTANT, NOW, 8000, 100000)).toBe(true);
    recordTokenUsage(db, ASSISTANT, NOW, 95000);
    expect(canSpendTokens(db, ASSISTANT, NOW, TOKEN_COST.executeGoal, 100000)).toBe(false);
    db.close();
  });
});

describe('token 预算 — 按 agent 分账', () => {
  it('两只 agent 各记各的：宠物烧的不进助手的账', () => {
    const db = createMigratedTestDb();
    recordTokenUsage(db, 'assistant', NOW, 8000);
    recordTokenUsage(db, PET, NOW, 8000);
    recordTokenUsage(db, PET, NOW, 8000);

    expect(readTodayTokenUsage(db, 'assistant', NOW)).toBe(8000);
    expect(readTodayTokenUsage(db, PET, NOW)).toBe(16000);
    // 各自的闸门只看自己那一份
    expect(canSpendTokens(db, 'assistant', NOW, 8000, 16000)).toBe(true);
    expect(canSpendTokens(db, PET, NOW, 8000, 16000)).toBe(false);
    db.close();
  });

  it('键名带 agent 维度，宠物 id 里的冒号原样保留', () => {
    const db = createMigratedTestDb();
    recordTokenUsage(db, PET, NOW, 8000);
    expect(raw(db, `autonomous.tokens:${PET}:${TODAY}`)).toBe('8000');
    db.close();
  });
});

describe('token 预算 — 老库全局单键迁移', () => {
  const LEGACY = `autonomous.tokens.${TODAY}`;
  const OWN = `autonomous.tokens:${ASSISTANT}:${TODAY}`;

  it('老键迁给 assistant，原值一字不差，旧键删除', () => {
    const db = createMigratedTestDb();
    seed(db, LEGACY, '13579');

    expect(readTodayTokenUsage(db, 'assistant', NOW)).toBe(13579);

    expect(raw(db, LEGACY)).toBeUndefined();
    expect(raw(db, OWN)).toBe('13579');
    db.close();
  });

  it('读宠物**不吞**老键：老键原封不动，宠物读到自己那份是 0', () => {
    const db = createMigratedTestDb();
    seed(db, LEGACY, '13579');

    expect(readTodayTokenUsage(db, PET, NOW)).toBe(0);
    expect(raw(db, LEGACY)).toBe('13579');
    expect(raw(db, `autonomous.tokens:${PET}:${TODAY}`)).toBeUndefined();
    db.close();
  });

  it('自己的键已在时不看老键（迁移不覆盖当天已记的账）', () => {
    const db = createMigratedTestDb();
    seed(db, OWN, '1000');
    seed(db, LEGACY, '99999');

    expect(readTodayTokenUsage(db, 'assistant', NOW)).toBe(1000);
    expect(raw(db, LEGACY)).toBe('99999'); // 没被搬走，因为不需要搬
    db.close();
  });

  it('迁移只发生一次：第二次读仍读到同一个数', () => {
    const db = createMigratedTestDb();
    seed(db, LEGACY, '13579');
    readTodayTokenUsage(db, 'assistant', NOW);
    seed(db, LEGACY, '其他东西'); // 就算有人又写了老键，也不再被读
    expect(readTodayTokenUsage(db, 'assistant', NOW)).toBe(13579);
    db.close();
  });

  it('空库读 assistant 不建键', () => {
    const db = createMigratedTestDb();
    expect(readTodayTokenUsage(db, 'assistant', NOW)).toBe(0);
    expect(raw(db, OWN)).toBeUndefined();
    db.close();
  });

  it('分键后的键与老键互不为前缀（差一个分隔符）', () => {
    // 这条是给未来写 LIKE 扫描的人看的：老键是 `.`、新键是 `:`，
    // 于是 `LIKE 'autonomous.tokens.%'` 永远不会误命中新键。
    const db = createMigratedTestDb();
    recordTokenUsage(db, 'assistant', NOW, 8000);
    const legacyHits = db
      .prepare<{ key: string }>(`SELECT key FROM runtime_state WHERE key LIKE 'autonomous.tokens.%'`)
      .all();
    expect(legacyHits).toHaveLength(0);
    db.close();
  });
});
