import { describe, expect, it } from 'vitest';
import {
  decayMood,
  circadianEnergy,
  applyMoodImpact,
  moodToDecisionParams,
  moodToPetEmotion,
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
