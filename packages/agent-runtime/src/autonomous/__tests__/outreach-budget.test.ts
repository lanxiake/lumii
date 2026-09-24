/**
 * 主动消息预算的分账与老库迁移。
 *
 * 老库有**两个**全局单键（当日计数 + 上次发送时间），都要处理：
 * 只拆计数不拆时间戳的话，宠物说一句话仍会把助手的 `last_sent_at` 顶掉，
 * 助手的 `minOutreachIntervalMinutes` 跟着误判——这是分账漏一半的典型症状。
 */

import { describe, expect, it } from 'vitest';
import { createMigratedTestDb } from '../../__tests__/helpers/sqlite-test-db';
import { canSendOutreach, recordOutreach, getOutreachUsedToday, getLastOutreachAt } from '../outreach-budget';

const NOW = new Date(2026, 8, 6, 10, 0, 0); // 本地时间 2026-09-06 10:00
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

describe('outreach 预算 — 基础行为', () => {
  it('无记录时今日用量为 0', () => {
    const db = createMigratedTestDb();
    expect(getOutreachUsedToday(db, ASSISTANT, NOW)).toBe(0);
    db.close();
  });

  it('recordOutreach 递增计数', () => {
    const db = createMigratedTestDb();
    recordOutreach(db, ASSISTANT, NOW);
    recordOutreach(db, ASSISTANT, NOW);
    expect(getOutreachUsedToday(db, ASSISTANT, NOW)).toBe(2);
    db.close();
  });

  it('达到上限后 canSendOutreach 返回 false，未达上限时可发送', () => {
    const db = createMigratedTestDb();
    for (let i = 0; i < 19; i += 1) recordOutreach(db, ASSISTANT, NOW);
    expect(canSendOutreach(db, ASSISTANT, NOW, 20)).toBe(true);
    recordOutreach(db, ASSISTANT, NOW);
    expect(canSendOutreach(db, ASSISTANT, NOW, 20)).toBe(false);
    db.close();
  });

  it('跨天自动归零', () => {
    const db = createMigratedTestDb();
    recordOutreach(db, ASSISTANT, NOW);
    expect(getOutreachUsedToday(db, ASSISTANT, new Date(2026, 8, 7, 0, 0, 0))).toBe(0);
    db.close();
  });

  it('从未发送时 getLastOutreachAt 返回 null；记一次后写时间戳', () => {
    const db = createMigratedTestDb();
    expect(getLastOutreachAt(db, ASSISTANT)).toBeNull();
    recordOutreach(db, ASSISTANT, NOW);
    expect(getLastOutreachAt(db, ASSISTANT)).toBe(NOW.getTime());
    db.close();
  });
});

describe('outreach 预算 — 按 agent 分账', () => {
  it('计数与「上次说话时间」两样都各记各的', () => {
    const db = createMigratedTestDb();
    const later = new Date(2026, 8, 6, 11, 30, 0);
    recordOutreach(db, 'assistant', NOW);
    recordOutreach(db, PET, later);

    expect(getOutreachUsedToday(db, 'assistant', NOW)).toBe(1);
    expect(getOutreachUsedToday(db, PET, NOW)).toBe(1);
    // 宠物 11:30 说的那句不能把助手的「上次说话」推到 11:30
    expect(getLastOutreachAt(db, 'assistant')).toBe(NOW.getTime());
    expect(getLastOutreachAt(db, PET)).toBe(later.getTime());
    db.close();
  });
});

describe('outreach 预算 — 老库全局单键迁移', () => {
  const LEGACY_COUNT = `autonomous.outreach.${TODAY}`;
  const LEGACY_LAST = 'autonomous.outreach.last_sent_at';
  const OWN_COUNT = `autonomous.outreach:${ASSISTANT}:${TODAY}`;
  const OWN_LAST = `autonomous.outreach:${ASSISTANT}:last_sent_at`;

  it('两个老键都迁给 assistant，原值一字不差，旧键删除', () => {
    const db = createMigratedTestDb();
    seed(db, LEGACY_COUNT, '3');
    seed(db, LEGACY_LAST, '1789000000000');

    expect(getOutreachUsedToday(db, 'assistant', NOW)).toBe(3);
    expect(getLastOutreachAt(db, 'assistant')).toBe(1789000000000);

    expect(raw(db, LEGACY_COUNT)).toBeUndefined();
    expect(raw(db, LEGACY_LAST)).toBeUndefined();
    expect(raw(db, OWN_COUNT)).toBe('3');
    expect(raw(db, OWN_LAST)).toBe('1789000000000');
    db.close();
  });

  it('读宠物**不吞**老键：两条老键原封不动，宠物读到自己那份是 0 / null', () => {
    const db = createMigratedTestDb();
    seed(db, LEGACY_COUNT, '3');
    seed(db, LEGACY_LAST, '1789000000000');

    expect(getOutreachUsedToday(db, PET, NOW)).toBe(0);
    expect(getLastOutreachAt(db, PET)).toBeNull();
    expect(raw(db, LEGACY_COUNT)).toBe('3');
    expect(raw(db, LEGACY_LAST)).toBe('1789000000000');
    db.close();
  });

  it('自己的键已在时不看老键（迁移不覆盖当天已记的账）', () => {
    const db = createMigratedTestDb();
    seed(db, OWN_COUNT, '1');
    seed(db, LEGACY_COUNT, '19');

    expect(getOutreachUsedToday(db, 'assistant', NOW)).toBe(1);
    expect(raw(db, LEGACY_COUNT)).toBe('19');
    db.close();
  });

  it('老键按日期与「上次发送」互不混淆（`.last_sent_at` 不是日期键）', () => {
    const db = createMigratedTestDb();
    seed(db, LEGACY_LAST, '1789000000000');

    // 读当日计数不应该把 last_sent_at 当成今天的计数搬走
    expect(getOutreachUsedToday(db, 'assistant', NOW)).toBe(0);
    expect(raw(db, LEGACY_LAST)).toBe('1789000000000');
    db.close();
  });
});
