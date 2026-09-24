/**
 * 宠物目标读取（跨 agent 查询）的测试。
 *
 * 这一层是宠物与助手**唯一共享的读判断**，所以两条边界都要钉住：
 * 只拿 `pet:*` 的活、只拿已到期的活。漏掉任一条，宠物会去跑助手的目标。
 */
import { describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../storage/local-database.js';
import { createMigratedTestDb } from '../../__tests__/helpers/sqlite-test-db.js';
import { isPetAgentId, isPetGoalDue, listDuePetGoals } from '../pet-goals';

const NOW = new Date('2026-09-24T12:00:00.000Z');

function insertGoal(
  db: DatabaseAdapter,
  opts: {
    id: string;
    agentId: string;
    status?: string;
    scheduledFor?: string | null;
    createdAt?: string;
    description?: string;
  },
): void {
  db.prepare(
    `INSERT INTO autonomous_goals
     (id, agent_id, type, description, trigger_reason, status, priority, metadata,
      planned_by, scheduled_for, created_at)
     VALUES (?, ?, 'learning', ?, 'user-assigned', ?, 0.5, '{}', 'pet', ?, ?)`,
  ).run(
    opts.id,
    opts.agentId,
    opts.description ?? '看看测试跑没跑通',
    opts.status ?? 'executing',
    opts.scheduledFor ?? null,
    opts.createdAt ?? '2026-09-24T10:00:00.000Z',
  );
}

describe('isPetAgentId', () => {
  it('认 pet:<模型ID>，不认助手与裸 pet', () => {
    expect(isPetAgentId('pet:demo_cartoon_cat')).toBe(true);
    expect(isPetAgentId('assistant')).toBe(false);
    expect(isPetAgentId('system-keeper')).toBe(false);
    // 裸 'pet' 不是宠物——身份口径是 `pet:<模型ID>`，没有模型就没有归属
    expect(isPetAgentId('pet')).toBe(false);
    expect(isPetAgentId('')).toBe(false);
  });
});

describe('isPetGoalDue', () => {
  it('无排期即立即可做', () => {
    expect(isPetGoalDue(null, NOW)).toBe(true);
  });

  it('排期已到 → 可做；未到 → 不可做', () => {
    expect(isPetGoalDue('2026-09-24T11:59:59.000Z', NOW)).toBe(true);
    expect(isPetGoalDue('2026-09-24T12:00:00.000Z', NOW)).toBe(true); // 边界含等于
    expect(isPetGoalDue('2026-09-24T12:00:01.000Z', NOW)).toBe(false);
  });

  it('解析不出来的排期按「未到期」处理', () => {
    // 不认识的排期不该当场执行——宁可永远不做，也不要在一个错误的时间蹦出来
    expect(isPetGoalDue('不是时间', NOW)).toBe(false);
  });
});

describe('listDuePetGoals', () => {
  it('只拿宠物名下的活，助手的活一概不碰', () => {
    const db = createMigratedTestDb();
    insertGoal(db, { id: 'g-pet', agentId: 'pet:demo_cartoon_cat' });
    insertGoal(db, { id: 'g-assistant', agentId: 'assistant' });
    insertGoal(db, { id: 'g-keeper', agentId: 'system-keeper' });

    const got = listDuePetGoals(db, NOW);
    expect(got.map((g) => g.id)).toEqual(['g-pet']);
    expect(got[0].agentId).toBe('pet:demo_cartoon_cat');
  });

  it('只拿 executing：pending / completed / failed 都不派发', () => {
    const db = createMigratedTestDb();
    insertGoal(db, { id: 'g-exec', agentId: 'pet:mao_pro', status: 'executing' });
    insertGoal(db, { id: 'g-pending', agentId: 'pet:mao_pro', status: 'pending' });
    insertGoal(db, { id: 'g-approved', agentId: 'pet:mao_pro', status: 'approved' });
    insertGoal(db, { id: 'g-done', agentId: 'pet:mao_pro', status: 'completed' });
    insertGoal(db, { id: 'g-failed', agentId: 'pet:mao_pro', status: 'failed' });

    expect(listDuePetGoals(db, NOW).map((g) => g.id)).toEqual(['g-exec']);
  });

  it('排期未到的先不做，到点了才做', () => {
    const db = createMigratedTestDb();
    // created_at 必须显式错开：三条同一时刻的话排序是未定义的，测试会随机红。
    // 顺序按**创建时间**（不是按到期与否）——先派进来的先做，到期只是过滤条件。
    insertGoal(db, {
      id: 'g-later',
      agentId: 'pet:mao_pro',
      scheduledFor: '2026-09-24T18:00:00.000Z',
      createdAt: '2026-09-24T10:00:00.000Z',
    });
    insertGoal(db, { id: 'g-now', agentId: 'pet:mao_pro', createdAt: '2026-09-24T10:01:00.000Z' });
    insertGoal(db, {
      id: 'g-past',
      agentId: 'pet:mao_pro',
      scheduledFor: '2026-09-24T09:00:00.000Z',
      createdAt: '2026-09-24T10:02:00.000Z',
    });

    // 12:00：排到 18:00 的那条还没到时候
    expect(listDuePetGoals(db, NOW).map((g) => g.id)).toEqual(['g-now', 'g-past']);

    // 19:00：三条全到期，仍按创建时间排——它排在最先，是因为它**先被派进来**，不是因为排期最早
    const later = new Date('2026-09-24T19:00:00.000Z');
    expect(listDuePetGoals(db, later).map((g) => g.id)).toEqual(['g-later', 'g-now', 'g-past']);
  });

  it('按创建时间升序——先派进来的先做', () => {
    const db = createMigratedTestDb();
    insertGoal(db, { id: 'g-c', agentId: 'pet:mao_pro', createdAt: '2026-09-24T11:00:00.000Z' });
    insertGoal(db, { id: 'g-a', agentId: 'pet:mao_pro', createdAt: '2026-09-24T09:00:00.000Z' });
    insertGoal(db, { id: 'g-b', agentId: 'pet:mao_pro', createdAt: '2026-09-24T10:00:00.000Z' });

    expect(listDuePetGoals(db, NOW).map((g) => g.id)).toEqual(['g-a', 'g-b', 'g-c']);
  });

  it('读库失败返回空数组，不抛给调用方', () => {
    // 派发循环是后台动作：一次查询失败不该把整轮心跳炸成异常
    const broken = {
      prepare() {
        throw new Error('no such table');
      },
    } as unknown as DatabaseAdapter;
    expect(listDuePetGoals(broken, NOW)).toEqual([]);
  });
});
