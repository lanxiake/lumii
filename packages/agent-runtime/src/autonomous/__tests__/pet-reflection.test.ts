import { describe, expect, it, vi } from 'vitest';
import {
  MIN_EXPERIENCES_FOR_REFLECTION,
  PET_REFLECTION_PROMPT,
  parsePetReflection,
  reflectOnPet,
  renderPetReflectionInput,
  type PetReflectionInput,
} from '../pet-reflection';

const MOOD = { energy: 0.6, valence: 0.2, arousal: 0.5, updatedAt: 0 };

function makeInput(overrides: Partial<PetReflectionInput> = {}): PetReflectionInput {
  return {
    agentId: 'pet:demo_cartoon_cat',
    experiences: [
      { description: '看看测试跑没跑', ok: true, at: '2026-09-20T10:00:00.000Z', result: '全过了' },
      { description: '看下日报', ok: true, at: '2026-09-20T11:00:00.000Z' },
      { description: '查一下构建产物', ok: false, at: '2026-09-20T12:00:00.000Z' },
    ],
    reaction: { positive: 4, ignored: 2, kinds: ['petted', 'bubble-ignored'], sinceLastMs: 3_600_000, total: 6 },
    mood: MOOD,
    ...overrides,
  };
}

describe('PET_REFLECTION_PROMPT', () => {
  it('含三条禁令（量化 / 表演 / 述职）——删一条反思就会滑回自我审计', () => {
    expect(PET_REFLECTION_PROMPT).toContain('数字指标');
    expect(PET_REFLECTION_PROMPT).toContain('表演');
    expect(PET_REFLECTION_PROMPT).toContain('绩效');
  });

  it('反思的对象是"我和这个人"，不是"我的指标"', () => {
    expect(PET_REFLECTION_PROMPT).toContain('我和这个人之间');
  });

  it('排除助手那类目标（不要写"优化系统""提升效率"）', () => {
    expect(PET_REFLECTION_PROMPT).toContain('优化系统');
  });
});

describe('renderPetReflectionInput', () => {
  it('把做过的事、结果、用户反应都摆给模型看', () => {
    const text = renderPetReflectionInput(makeInput());
    expect(text).toContain('看看测试跑没跑');
    expect(text).toContain('做成了');
    expect(text).toContain('没做成');
    expect(text).toContain('回应了我 4 次');
    expect(text).toContain('没接 2 次');
  });

  it('★ 输入侧有数字、产出侧才不许有（禁令禁的是产出）', () => {
    const text = renderPetReflectionInput(makeInput());
    expect(text).toMatch(/\d/);
  });

  it('没有互动时如实说"什么都没发生"，不编', () => {
    const text = renderPetReflectionInput(
      makeInput({ reaction: { positive: 0, ignored: 0, kinds: [], sinceLastMs: null, total: 0 } }),
    );
    expect(text).toContain('什么都没');
  });

  it('带上次的"了解"时会要求它改口或延续', () => {
    const text = renderPetReflectionInput(makeInput({ previousUnderstanding: '他话不多' }));
    expect(text).toContain('他话不多');
    expect(text).toContain('改口');
  });
});

describe('reflectOnPet — 冷启动守卫', () => {
  it('★ 经历不足时不反思，且**一次 LLM 都不调**', async () => {
    const complete = vi.fn(async () => ({ content: '{}' }));
    const out = await reflectOnPet(
      makeInput({ experiences: makeInput().experiences.slice(0, MIN_EXPERIENCES_FOR_REFLECTION - 1) }),
      { complete },
    );
    expect(out.coldStart).toBe(true);
    expect(out.understanding).toBeNull();
    expect(out.suggestions).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });

  it('一件都没做过时同样冷启动（新出生的宠物）', async () => {
    const complete = vi.fn(async () => ({ content: '{}' }));
    const out = await reflectOnPet(makeInput({ experiences: [] }), { complete });
    expect(out.coldStart).toBe(true);
    expect(complete).not.toHaveBeenCalled();
  });

  it('刚好够 3 件时正常反思', async () => {
    const complete = vi.fn(async () => ({
      content: '```json\n{"understanding":"他很急","impression":"closer","suggestions":[]}\n```',
    }));
    const out = await reflectOnPet(makeInput(), { complete });
    expect(out.coldStart).toBe(false);
    expect(out.understanding).toBe('他很急');
    expect(out.feedback).toBe('positive');
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe('reflectOnPet — 失败与容错', () => {
  it('LLM 抛错不炸调用方，按"这次没反思出什么"处理', async () => {
    const out = await reflectOnPet(makeInput(), {
      complete: async () => {
        throw new Error('endpoint 500');
      },
    });
    expect(out.coldStart).toBe(true);
    expect(out.understanding).toBeNull();
  });

  it('模型没返回 JSON 时不抛（这条链失败只该安静过去）', async () => {
    const out = await reflectOnPet(makeInput(), {
      complete: async () => ({ content: '我觉得挺好的，没什么可说的。' }),
    });
    expect(out.coldStart).toBe(false);
    expect(out.understanding).toBeNull();
    expect(out.feedback).toBeNull();
    expect(out.suggestions).toEqual([]);
  });
});

describe('parsePetReflection', () => {
  it('带 ```json 围栏能解析', () => {
    const out = parsePetReflection(
      '```json\n{"understanding":"他喜欢我盯着他干活","impression":"closer","suggestions":[{"description":"看看今天的日志","reason":"他昨天提过"}]}\n```',
    );
    expect(out.understanding).toBe('他喜欢我盯着他干活');
    expect(out.feedback).toBe('positive');
    expect(out.suggestions).toEqual([{ description: '看看今天的日志', reason: '他昨天提过' }]);
  });

  it('无围栏、前后带解释也能抠出 JSON', () => {
    const out = parsePetReflection(
      '好的，我想了想：{"understanding":"他话少","impression":"distant","suggestions":[]} （就这样）',
    );
    expect(out.feedback).toBe('negative');
  });

  it('impression 是 neutral / 缺失 / 乱填时不发人格事件', () => {
    expect(parsePetReflection('{"understanding":"x","impression":"neutral"}').feedback).toBeNull();
    expect(parsePetReflection('{"understanding":"x"}').feedback).toBeNull();
    expect(parsePetReflection('{"understanding":"x","impression":"很亲近"}').feedback).toBeNull();
  });

  it('★ suggestions 最多留 2 件（自己找事做不等于给自己排满）', () => {
    const out = parsePetReflection(
      JSON.stringify({
        understanding: 'x',
        impression: 'neutral',
        suggestions: [
          { description: 'a', reason: '' },
          { description: 'b', reason: '' },
          { description: 'c', reason: '' },
        ],
      }),
    );
    expect(out.suggestions.map((s) => s.description)).toEqual(['a', 'b']);
  });

  it('空描述的建议被丢掉（不能让宠物去"做点事"）', () => {
    const out = parsePetReflection(
      JSON.stringify({
        understanding: 'x',
        impression: 'neutral',
        suggestions: [{ description: '   ', reason: 'r' }, { description: '真的事', reason: 'r' }],
      }),
    );
    expect(out.suggestions.map((s) => s.description)).toEqual(['真的事']);
  });

  it('understanding 为空串按"没说出来"处理', () => {
    expect(parsePetReflection('{"understanding":"   "}').understanding).toBeNull();
  });

  it('坏 JSON 不抛', () => {
    expect(() => parsePetReflection('{ 这不是 json }')).not.toThrow();
    expect(parsePetReflection('{ 这不是 json }').understanding).toBeNull();
  });
});
