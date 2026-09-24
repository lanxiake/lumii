import { describe, expect, it } from 'vitest';
import {
  appendPetExperience,
  petExperienceKey,
  readPetExperience,
  readPetUnderstanding,
  readPetWorkRecords,
  summarizePetExperience,
  writePetUnderstanding,
  type PetExperienceKind,
} from '../pet-experience';
import { createMigratedTestDb } from '../../__tests__/helpers/sqlite-test-db.js';

const PET = 'pet:demo_cartoon_cat';
const OTHER_PET = 'pet:mao_pro';

function at(day: number, hour = 12): Date {
  return new Date(2026, 8, day, hour, 0, 0); // 2026-09-<day>
}

/** 插一条宠物目标（默认已完成带回执） */
function insertGoal(
  db: ReturnType<typeof createMigratedTestDb>,
  id: string,
  opts: {
    agentId?: string;
    status?: string;
    metadata?: string | null;
    plannedBy?: string;
    at?: string;
  } = {},
): void {
  const iso = opts.at ?? at(20, 10).toISOString();
  db.prepare(
    `INSERT INTO autonomous_goals
     (id, agent_id, type, description, trigger_reason, status, priority, metadata,
      planned_by, scheduled_for, created_at, completed_at)
     VALUES (?, ?, 'learning', ?, '用户交代', ?, 1, ?, ?, NULL, ?, ?)`,
  ).run(
    id,
    opts.agentId ?? PET,
    `做过 ${id}`,
    opts.status ?? 'completed',
    opts.metadata === undefined
      ? JSON.stringify({
          source: 'pet-task',
          dimension: null,
          result: { ok: true, text: '看过了', at: iso },
        })
      : opts.metadata,
    opts.plannedBy ?? 'pet',
    iso,
    opts.status === 'executing' ? null : iso,
  );
}

describe('appendPetExperience / readPetExperience', () => {
  it('追加后按时间序读回', () => {
    const db = createMigratedTestDb();
    appendPetExperience(db, PET, 'petted', at(20, 9));
    appendPetExperience(db, PET, 'task-created', at(20, 10));
    appendPetExperience(db, PET, 'bubble-ignored', at(20, 11));

    const entries = readPetExperience(db, PET);
    expect(entries.map((e) => e.k)).toEqual(['petted', 'task-created', 'bubble-ignored']);
    expect(entries[0].at).toBe(at(20, 9).getTime());
  });

  it('★ 按 agent 分键：两只宠物各记各的账', () => {
    const db = createMigratedTestDb();
    appendPetExperience(db, PET, 'petted', at(20));
    appendPetExperience(db, OTHER_PET, 'bubble-ignored', at(20));

    expect(readPetExperience(db, PET).map((e) => e.k)).toEqual(['petted']);
    expect(readPetExperience(db, OTHER_PET).map((e) => e.k)).toEqual(['bubble-ignored']);
  });

  it('键名带 agentId（换模型不串账）', () => {
    expect(petExperienceKey(PET)).toBe('pet.experience:pet:demo_cartoon_cat');
  });

  it('没记过返回空数组，不抛', () => {
    const db = createMigratedTestDb();
    expect(readPetExperience(db, 'pet:never-used')).toEqual([]);
  });

  it('剪枝：超 7 天的丢掉（值域是"最近"，不是账本）', () => {
    const db = createMigratedTestDb();
    appendPetExperience(db, PET, 'petted', at(1)); // 19 天前
    appendPetExperience(db, PET, 'petted', at(20)); // 今天
    expect(readPetExperience(db, PET)).toHaveLength(1);
  });

  it('剪枝：条数封顶 200，保留最近的', () => {
    const db = createMigratedTestDb();
    for (let i = 0; i < 260; i++) {
      appendPetExperience(db, PET, 'petted', new Date(at(20).getTime() + i * 1000));
    }
    const entries = readPetExperience(db, PET);
    expect(entries).toHaveLength(200);
    // 保留的是**后面**那 200 条
    expect(entries[entries.length - 1].at).toBe(at(20).getTime() + 259 * 1000);
  });

  it('脏数据按空流水处理（不炸调用方）', () => {
    const db = createMigratedTestDb();
    db.prepare(`INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)`).run(
      petExperienceKey(PET),
      '{"not":"an array"}',
      new Date().toISOString(),
    );
    expect(readPetExperience(db, PET)).toEqual([]);
  });

  it('数组里混进坏条目时逐条跳过，不整份丢掉', () => {
    const db = createMigratedTestDb();
    db.prepare(`INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)`).run(
      petExperienceKey(PET),
      JSON.stringify([{ k: 'petted', at: 1 }, null, { k: 'petted' }, 'x', { k: 'task-read', at: 2 }]),
      new Date().toISOString(),
    );
    expect(readPetExperience(db, PET).map((e) => e.k)).toEqual(['petted', 'task-read']);
  });
});

describe('summarizePetExperience', () => {
  const entries: Array<{ k: PetExperienceKind; at: number }> = [
    { k: 'petted', at: at(19).getTime() },
    { k: 'task-created', at: at(20, 9).getTime() },
    { k: 'bubble-ignored', at: at(20, 10).getTime() },
    { k: 'bubble-ignored', at: at(20, 11).getTime() },
    { k: 'chat-reply', at: at(20, 12).getTime() },
  ];

  it('正负判读：ignored 只数 bubble-ignored，其余都算回应', () => {
    const s = summarizePetExperience(entries, at(20, 13));
    expect(s.positive).toBe(3); // petted + task-created + chat-reply
    expect(s.ignored).toBe(2);
    expect(s.total).toBe(5);
  });

  it('kinds 去重（"被摸过也被派过活"比"互动 7 次"有信息量）', () => {
    const s = summarizePetExperience(entries, at(20, 13));
    expect(s.kinds.sort()).toEqual(['bubble-ignored', 'chat-reply', 'petted', 'task-created']);
  });

  it('sinceLastMs 取最近一次互动', () => {
    const s = summarizePetExperience(entries, at(20, 13));
    expect(s.sinceLastMs).toBe(60 * 60 * 1000); // 12:00 → 13:00
  });

  it('窗口外的条目不计入（默认 72 小时）', () => {
    const s = summarizePetExperience(entries, at(20, 13));
    expect(s.total).toBe(5); // 19 日那条还在 72h 内
    const wide = summarizePetExperience(entries, at(20, 13), 6 * 60 * 60 * 1000);
    expect(wide.total).toBe(4); // 收紧到 6 小时后，昨天那条出局
    expect(wide.positive).toBe(2); // 出局的那条正好是 petted
  });

  it('一次都没有时 sinceLastMs 为 null（冷启动守卫的上游）', () => {
    const s = summarizePetExperience([], at(20));
    expect(s).toEqual({ positive: 0, ignored: 0, kinds: [], sinceLastMs: null, total: 0 });
  });

  it('★ 全是 bubble-ignored 时 positive=0（"它说了话没人理"要读得出来）', () => {
    const only: Array<{ k: PetExperienceKind; at: number }> = [
      { k: 'bubble-ignored', at: at(20, 9).getTime() },
      { k: 'bubble-ignored', at: at(20, 10).getTime() },
    ];
    const s = summarizePetExperience(only, at(20, 11));
    expect(s.positive).toBe(0);
    expect(s.ignored).toBe(2);
  });
});

describe('readPetWorkRecords —— 经历的另一半（做过的事）', () => {
  it('只取**已收尾**的：在路上的不进来（它还没有"结果"可言）', () => {
    const db = createMigratedTestDb();
    insertGoal(db, 'done', { status: 'completed' });
    insertGoal(db, 'failed', { status: 'failed' });
    insertGoal(db, 'running', { status: 'executing' });

    const works = readPetWorkRecords(db, PET);
    expect(works.map((w) => w.id).sort()).toEqual(['done', 'failed']);
  });

  it('带回执：成败与结果文本都读得到', () => {
    const db = createMigratedTestDb();
    insertGoal(db, 'ok', { status: 'completed' });
    insertGoal(db, 'bad', {
      status: 'failed',
      metadata: JSON.stringify({
        source: 'pet-task',
        dimension: null,
        result: { ok: false, text: '没能做成：今日目标已用满', at: at(20, 11).toISOString() },
      }),
    });

    const works = readPetWorkRecords(db, PET);
    const ok = works.find((w) => w.id === 'ok');
    const bad = works.find((w) => w.id === 'bad');
    expect(ok?.ok).toBe(true);
    expect(ok?.result).toBe('看过了');
    expect(bad?.ok).toBe(false);
    expect(bad?.result).toContain('没能做成');
  });

  it('★ 回执缺失时按终态判成败（回执写库失败不该让它变成"没做过"）', () => {
    const db = createMigratedTestDb();
    insertGoal(db, 'no-receipt', {
      status: 'completed',
      metadata: JSON.stringify({ source: 'pet-task', dimension: null }),
    });
    const works = readPetWorkRecords(db, PET);
    expect(works).toHaveLength(1);
    expect(works[0].ok).toBe(true);
    expect(works[0].result).toBeUndefined();
  });

  it('跳过不是宠物任务的行（`planned_by` 与解析器两道都要过）', () => {
    const db = createMigratedTestDb();
    insertGoal(db, 'mine');
    // 规划器落的（planned_by='trigger'）
    insertGoal(db, 'planner', { plannedBy: 'trigger' });
    // 宠物名下但 metadata 不是宠物任务形态
    insertGoal(db, 'other-shape', {
      metadata: JSON.stringify({ source: 'reflection-suggestion' }),
    });

    expect(readPetWorkRecords(db, PET).map((w) => w.id)).toEqual(['mine']);
  });

  it('按 agent 分：别人的事不进我的经历', () => {
    const db = createMigratedTestDb();
    insertGoal(db, 'mine');
    insertGoal(db, 'theirs', { agentId: OTHER_PET });
    expect(readPetWorkRecords(db, PET).map((w) => w.id)).toEqual(['mine']);
  });

  it('新的在前，且有条数上限', () => {
    const db = createMigratedTestDb();
    for (let i = 0; i < 5; i++) {
      insertGoal(db, `w${i}`, { at: at(20, 10 + i).toISOString() });
    }
    expect(readPetWorkRecords(db, PET, 3).map((w) => w.id)).toEqual(['w4', 'w3', 'w2']);
  });

  it('一件都没做过时返回空数组（下游据此走冷启动）', () => {
    const db = createMigratedTestDb();
    expect(readPetWorkRecords(db, PET)).toEqual([]);
  });
});

describe('readPetUnderstanding / writePetUnderstanding', () => {
  it('写进去能读回来（下一轮反思的连续性）', () => {
    const db = createMigratedTestDb();
    expect(readPetUnderstanding(db, PET)).toBeNull();
    writePetUnderstanding(db, PET, '他喜欢我盯着他干活');
    expect(readPetUnderstanding(db, PET)).toBe('他喜欢我盯着他干活');
  });

  it('★ 按 agent 分：两只宠物的"了解"互不覆盖', () => {
    const db = createMigratedTestDb();
    writePetUnderstanding(db, PET, '这只的了解');
    writePetUnderstanding(db, OTHER_PET, '那只的了解');
    expect(readPetUnderstanding(db, PET)).toBe('这只的了解');
    expect(readPetUnderstanding(db, OTHER_PET)).toBe('那只的了解');
  });

  it('空串按"还没说过"处理（不让它把上一次的了解抹掉后留个空白）', () => {
    const db = createMigratedTestDb();
    writePetUnderstanding(db, PET, '   ');
    expect(readPetUnderstanding(db, PET)).toBeNull();
  });
});
