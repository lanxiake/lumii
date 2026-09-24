import { describe, expect, it } from 'vitest';
import { createMigratedTestDb } from '../../__tests__/helpers/sqlite-test-db.js';
import {
  decayMood,
  circadianEnergy,
  applyMoodImpact,
  moodToDecisionParams,
  computeExplorationRate,
  moodToPetEmotion,
  readMood,
  writeMood,
  type Mood,
} from '../mood';

const BASE: Mood = { energy: 1, valence: 1, arousal: 1, updatedAt: 0 };
const FOUR_HOURS = 4 * 60 * 60 * 1000;

describe('decayMood', () => {
  it('4 小时后向基线回归一半', () => {
    const mood = decayMood(BASE, FOUR_HOURS);
    // energy: 0.6 + (1-0.6)*0.5 = 0.8
    expect(mood.energy).toBeCloseTo(0.8);
    // valence: 0 + (1-0)*0.5 = 0.5
    expect(mood.valence).toBeCloseTo(0.5);
    expect(mood.updatedAt).toBe(FOUR_HOURS);
  });

  it('不修改原对象', () => {
    const mood = decayMood(BASE, FOUR_HOURS);
    expect(BASE.energy).toBe(1);
    expect(mood).not.toBe(BASE);
  });
});

describe('circadianEnergy', () => {
  it('深夜低于午间', () => {
    expect(circadianEnergy(3)).toBeLessThan(circadianEnergy(10));
  });

  it('值域在 [0, 1]', () => {
    for (let h = 0; h < 24; h += 1) {
      const v = circadianEnergy(h);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('applyMoodImpact', () => {
  it('task_failed 同时降 valence、升 arousal', () => {
    const before: Mood = { energy: 0.6, valence: 0, arousal: 0.5, updatedAt: 0 };
    const after = applyMoodImpact(before, 'task_failed');
    expect(after.valence).toBeLessThan(0);
    expect(after.arousal).toBeGreaterThan(0.5);
  });

  it('未知事件不改变情绪', () => {
    const after = applyMoodImpact(BASE, 'unknown_event');
    expect(after).toEqual(BASE);
  });
});

/**
 * 宠物专属事件（五期 T5.5）。
 *
 * 这些用例守的不是数值本身，是**"宠物的成功/失败与任务侧不是一回事"**这条判断——
 * 如果哪天有人图省事把 `pet_task_done` 删掉、让它去共用 `goal_completed`，
 * 下面第一条就会红。
 */
describe('宠物专属情绪事件（T5.5）', () => {
  const NEUTRAL: Mood = { energy: 0.6, valence: 0, arousal: 0.5, updatedAt: 0 };

  it('办成一件事是**兴奋**的：valence ↑ 且 arousal ↑', () => {
    const after = applyMoodImpact(NEUTRAL, 'pet_task_done');
    expect(after.valence).toBeGreaterThan(0);
    expect(after.arousal).toBeGreaterThan(NEUTRAL.arousal);
  });

  it('⚠ 与 goal_completed 的方向不同：后者是**镇静**（arousal ↓）', () => {
    const taskSide = applyMoodImpact(NEUTRAL, 'goal_completed');
    const petSide = applyMoodImpact(NEUTRAL, 'pet_task_done');
    // 两条线各写各的键（分键后不互相覆盖），但方向必须是相反的：
    // 共用会让"宠物替你把事办成了"变成一件让它平静下来的事
    expect(taskSide.arousal).toBeLessThan(NEUTRAL.arousal);
    expect(petSide.arousal).toBeGreaterThan(NEUTRAL.arousal);
  });

  it('帮上忙那一下足够跨过雀跃线（第四期的 Cheer 靠这条才有真触发）', () => {
    // MOOD_CHEER_THRESHOLD = 0.2（pet-core 的 mood-shift.ts）。这里钉的是
    // "从基线出发，一次 pet_task_done 就能越线"——数值变了这条会红，
    // 那正是要有人来看一眼的时候（否则 Cheer 会静默地再也不播）
    const after = applyMoodImpact(NEUTRAL, 'pet_task_done');
    expect(after.valence).toBeGreaterThan(0.2);
  });

  it('没看成：valence ↓ 但 arousal ↑（设计 §7.3 的双向影响）', () => {
    const after = applyMoodImpact(NEUTRAL, 'pet_task_failed');
    expect(after.valence).toBeLessThan(0);
    expect(after.arousal).toBeGreaterThan(NEUTRAL.arousal);
  });

  it('没看成比任务失败**轻**（宠物办砸的多半是"没读到"）', () => {
    const pet = applyMoodImpact(NEUTRAL, 'pet_task_failed');
    const task = applyMoodImpact(NEUTRAL, 'task_failed');
    expect(pet.valence).toBeGreaterThan(task.valence);
  });

  it('没看成要**耗一点精力**（它真的跑了一趟）', () => {
    const after = applyMoodImpact(NEUTRAL, 'pet_task_failed');
    expect(after.energy).toBeLessThan(NEUTRAL.energy);
  });

  it('办成了不耗精力（只有失败那条扣）', () => {
    const after = applyMoodImpact(NEUTRAL, 'pet_task_done');
    expect(after.energy).toBe(NEUTRAL.energy);
  });

  it('两个事件名都真的在表里（拼错会静默变成空操作）', () => {
    expect(applyMoodImpact(NEUTRAL, 'pet_task_done')).not.toEqual(NEUTRAL);
    expect(applyMoodImpact(NEUTRAL, 'pet_task_failed')).not.toEqual(NEUTRAL);
  });
});

describe('moodToDecisionParams', () => {
  it('低 energy → 不做重活', () => {
    const params = moodToDecisionParams({ energy: 0.2, valence: 0, arousal: 0.5, updatedAt: 0 });
    expect(params.willDoHeavyWork).toBe(false);
  });

  it('低 valence → 少打扰', () => {
    const params = moodToDecisionParams({ energy: 0.8, valence: -0.5, arousal: 0.5, updatedAt: 0 });
    expect(params.outreachMultiplier).toBeLessThan(1);
  });

  it('高 energy + 非负 valence → 正常', () => {
    const params = moodToDecisionParams({ energy: 0.8, valence: 0.3, arousal: 0.5, updatedAt: 0 });
    expect(params.willDoHeavyWork).toBe(true);
    expect(params.outreachMultiplier).toBe(1);
  });

  it('低 valence（<-0.2）→ 审慎复查', () => {
    const params = moodToDecisionParams({ energy: 0.8, valence: -0.5, arousal: 0.5, updatedAt: 0 });
    expect(params.selfCheckBias).toBe(true);
  });

  it('非负 valence → 不强制审慎', () => {
    const params = moodToDecisionParams({ energy: 0.8, valence: 0.3, arousal: 0.5, updatedAt: 0 });
    expect(params.selfCheckBias).toBe(false);
  });
});

describe('computeExplorationRate', () => {
  it('arousal 高 + openness 高 → 探索率高', () => {
    const r = computeExplorationRate({ energy: 0.6, valence: 0, arousal: 1, updatedAt: 0 }, 1);
    expect(r).toBeCloseTo(0.45); // 1 * 0.3 * (0.5 + 1)
  });

  it('arousal 低 → 探索率低', () => {
    const r = computeExplorationRate({ energy: 0.6, valence: 0, arousal: 0, updatedAt: 0 }, 0.5);
    expect(r).toBeCloseTo(0.075); // 0.5 * 0.3 * 0.5
  });

  it('封顶 0.5', () => {
    const r = computeExplorationRate({ energy: 0.6, valence: 0, arousal: 1, updatedAt: 0 }, 1);
    expect(r).toBeLessThanOrEqual(0.5);
  });
});

describe('moodToPetEmotion', () => {
  it('开心且精力足 → joy', () => {
    expect(moodToPetEmotion({ energy: 0.8, valence: 0.5, arousal: 0.5, updatedAt: 0 })).toBe('joy');
  });
  it('唤起高 → surprise', () => {
    expect(moodToPetEmotion({ energy: 0.5, valence: 0, arousal: 0.8, updatedAt: 0 })).toBe('surprise');
  });
  it('精力低 → neutral', () => {
    expect(moodToPetEmotion({ energy: 0.2, valence: 0, arousal: 0.5, updatedAt: 0 })).toBe('neutral');
  });
  it('心情低落 → sadness', () => {
    expect(moodToPetEmotion({ energy: 0.5, valence: -0.5, arousal: 0.3, updatedAt: 0 })).toBe('sadness');
  });
  it('平静默认 → neutral', () => {
    expect(moodToPetEmotion({ energy: 0.5, valence: 0, arousal: 0.4, updatedAt: 0 })).toBe('neutral');
  });
});

describe('mood 分键与老库迁移', () => {
  const LEGACY_KEY = 'autonomous.mood';
  const ASSISTANT_KEY = 'autonomous.mood:assistant';

  function seedLegacy(db: ReturnType<typeof createMigratedTestDb>, mood: Mood): void {
    db.prepare(`INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)`).run(
      LEGACY_KEY,
      JSON.stringify(mood),
      new Date().toISOString(),
    );
  }

  it('不同 agent 的 mood 互不覆盖', () => {
    const db = createMigratedTestDb();
    writeMood(db, 'assistant', { energy: 0.9, valence: 0.5, arousal: 0.1, updatedAt: 1 });
    writeMood(db, 'pet:cat', { energy: 0.2, valence: -0.5, arousal: 0.7, updatedAt: 2 });
    expect(readMood(db, 'assistant')).toMatchObject({ energy: 0.9, valence: 0.5 });
    expect(readMood(db, 'pet:cat')).toMatchObject({ energy: 0.2, valence: -0.5 });
    db.close();
  });

  it('老库全局单键迁到 :assistant，原值一字不差，旧键删除', () => {
    const db = createMigratedTestDb();
    const legacy: Mood = { energy: 0.42, valence: -0.33, arousal: 0.61, updatedAt: 123456 };
    seedLegacy(db, legacy);

    expect(readMood(db, 'assistant')).toEqual(legacy);

    const oldRow = db.prepare(`SELECT value FROM runtime_state WHERE key = ?`).get(LEGACY_KEY);
    const newRow = db.prepare<{ value: string }>(`SELECT value FROM runtime_state WHERE key = ?`).get(ASSISTANT_KEY);
    expect(oldRow).toBeUndefined();
    expect(JSON.parse(newRow!.value)).toEqual(legacy);
    db.close();
  });

  it('迁移只发生在 assistant：读宠物不会吞掉老键', () => {
    const db = createMigratedTestDb();
    seedLegacy(db, { energy: 0.42, valence: -0.33, arousal: 0.61, updatedAt: 123456 });

    expect(readMood(db, 'pet:cat')).toMatchObject({ energy: 0.6, valence: 0, arousal: 0.5 }); // 基线
    expect(db.prepare(`SELECT value FROM runtime_state WHERE key = ?`).get(LEGACY_KEY)).toBeDefined();
    db.close();
  });

  it('空库读 assistant 返回基线，不建键', () => {
    const db = createMigratedTestDb();
    expect(readMood(db, 'assistant')).toMatchObject({ energy: 0.6, valence: 0, arousal: 0.5 });
    expect(db.prepare(`SELECT value FROM runtime_state WHERE key = ?`).get(ASSISTANT_KEY)).toBeUndefined();
    db.close();
  });
});
