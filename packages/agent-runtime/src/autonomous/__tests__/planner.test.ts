import { describe, expect, it } from 'vitest';
import { buildPlannerPrompt, parsePlannerOutput, enforcePlanBudget } from '../planner';
import type { PlannerInput, PlannerBudget } from '../planner';

function makeInput(overrides: Partial<PlannerInput> = {}): PlannerInput {
  return {
    reflection: {
      primaryIssue: '用户觉得回复太啰嗦',
      rootCause: '没有先抓住重点',
      recommendations: ['回复先给结论'],
      suggestedGoals: [{ type: 'learning', description: '练习简洁表达', priority: 0.7 }],
    },
    currentGoals: [{ description: '学习 X', status: 'executing', scheduledFor: null }],
    concerns: [{ description: '用户提过想看某主题', origin: 'session' }],
    mood: { energy: 0.6, valence: 0.5, arousal: 0.4 },
    budget: { tokensRemaining: 50000, outreachRemaining: 5, goalsRemaining: 3, cronSlotsRemaining: 2 },
    now: new Date('2026-09-06T09:00:00Z'),
    quietHours: [23, 8],
    ...overrides,
  };
}

describe('buildPlannerPrompt', () => {
  it('注入真实原料：反思/牵挂/目标/预算', () => {
    const prompt = buildPlannerPrompt(makeInput());
    expect(prompt).toContain('回复太啰嗦'); // 反思 primaryIssue
    expect(prompt).toContain('用户提过想看某主题'); // 牵挂
    expect(prompt).toContain('学习 X'); // 当前目标
    expect(prompt).toContain('50000'); // token 剩余
    expect(prompt).toContain('3'); // 目标配额
  });

  it('无反思时给占位，不抛', () => {
    const prompt = buildPlannerPrompt(makeInput({ reflection: null }));
    expect(prompt).toContain('最近还没有反思');
  });

  it('预算为负时裁剪为 0', () => {
    const prompt = buildPlannerPrompt(
      makeInput({ budget: { tokensRemaining: -5, outreachRemaining: -1, goalsRemaining: -2, cronSlotsRemaining: -3 } }),
    );
    expect(prompt).toContain('0-0');
  });
});

describe('parsePlannerOutput', () => {
  it('解析完整 JSON', () => {
    const raw = `\`\`\`json
{
  "goals": [{"description":"学习A","type":"learning","scheduled_for":"2026-09-07T09:00:00+08:00","priority":0.6}],
  "cronJobs": [{"task":"每天整理","scheduleType":"every","scheduleExpr":"21600000"}],
  "todos": ["读一篇文"]
}
\`\`\``;
    const plan = parsePlannerOutput(raw);
    expect(plan.goals).toHaveLength(1);
    expect(plan.goals[0].type).toBe('learning');
    expect(plan.goals[0].scheduled_for).toContain('2026-09-07');
    expect(plan.cronJobs[0].scheduleType).toBe('every');
    expect(plan.todos).toEqual(['读一篇文']);
  });

  it('脏 JSON 降级为空计划不抛', () => {
    expect(parsePlannerOutput('这不是 JSON')).toEqual({ goals: [], cronJobs: [], todos: [] });
    expect(parsePlannerOutput('')).toEqual({ goals: [], cronJobs: [], todos: [] });
  });

  it('结构缺失字段降级为空数组', () => {
    const plan = parsePlannerOutput('{"goals": []}');
    expect(plan.cronJobs).toEqual([]);
    expect(plan.todos).toEqual([]);
  });

  it('未知目标类型回落 learning，非法 priority 归一到 0-1', () => {
    const plan = parsePlannerOutput(
      '{"goals":[{"description":"x","type":"self-replicate","priority":5}]}',
    );
    expect(plan.goals[0].type).toBe('learning');
    expect(plan.goals[0].priority).toBe(1);
  });

  it('缺 scheduled_for 的目标视为立即（null）', () => {
    const plan = parsePlannerOutput('{"goals":[{"description":"x","type":"learning"}]}');
    expect(plan.goals[0].scheduled_for).toBeNull();
  });
});

describe('enforcePlanBudget', () => {
  const budget: PlannerBudget = { tokensRemaining: 1000, outreachRemaining: 1, goalsRemaining: 1, cronSlotsRemaining: 1 };

  it('目标数超配额被裁剪', () => {
    const plan = {
      goals: [
        { description: 'a', type: 'learning', scheduled_for: null, priority: 0.5 },
        { description: 'b', type: 'learning', scheduled_for: null, priority: 0.5 },
      ],
      cronJobs: [],
      todos: ['t1', 't2'],
    };
    const out = enforcePlanBudget(plan, budget);
    expect(out.goals).toHaveLength(1);
    expect(out.todos).toEqual(['t1', 't2']); // todos 不受限
  });

  it('cron 超配额被裁剪，且不修改原对象', () => {
    const plan = {
      goals: [],
      cronJobs: [
        { task: 'a', scheduleType: 'every' as const, scheduleExpr: '60000' },
        { task: 'b', scheduleType: 'at' as const, scheduleExpr: '2026-09-07T09:00:00Z' },
      ],
      todos: [],
    };
    const out = enforcePlanBudget(plan, budget);
    expect(out.cronJobs).toHaveLength(1);
    expect(plan.cronJobs).toHaveLength(2);
  });
});
