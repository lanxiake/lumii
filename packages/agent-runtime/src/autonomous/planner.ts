/**
 * 主动规划器（纯逻辑，无副作用）
 *
 * 对应主动规划设计 §4.2：Agent 低频产出计划，落地为自建 cron 任务 + 目标 + 待办。
 * 这里只放提示词构造、输出解析（脏 JSON 降级不抛）、预算裁剪三个纯函数；
 * LLM 调用与落库（goals/cron/todos）分别由 windows 侧 orchestration 与 planner-landing 负责。
 */

import { extractJsonText } from './reflection-prompts';

/** 规划器产出的单个目标 */
export interface PlannerGoal {
  description: string;
  type: string;
  /** 计划执行时间（ISO）；null 表示立即 */
  scheduled_for: string | null;
  priority: number;
}

/** 规划器产出的单个自建定时任务 */
export interface PlannerCronJob {
  task: string;
  scheduleType: 'at' | 'every';
  /** 'at'：ISO 时间；'every'：整数毫秒字符串 */
  scheduleExpr: string;
}

/** 结构化计划 */
export interface PlannerPlan {
  goals: PlannerGoal[];
  cronJobs: PlannerCronJob[];
  todos: string[];
}

/** 规划时可用的剩余预算（由装配层读库后注入） */
export interface PlannerBudget {
  /** 今日 token 剩余（预估） */
  tokensRemaining: number;
  /** 今日主动消息剩余 */
  outreachRemaining: number;
  /** 目标配额剩余 */
  goalsRemaining: number;
  /** 自建 cron 剩余槽位 */
  cronSlotsRemaining: number;
}

/** 规划器输入原料（喂真实事件，不是只喂数字） */
export interface PlannerInput {
  /** 最近一次反思的结构化结论；无反思时为 null */
  reflection: {
    primaryIssue: string;
    rootCause: string;
    recommendations: string[];
    suggestedGoals: Array<{ type: string; description: string; priority: number }>;
  } | null;
  /** 当前未完成目标（pending/executing） */
  currentGoals: Array<{ description: string; status: string; scheduledFor: string | null }>;
  /** open 状态的牵挂 */
  concerns: Array<{ description: string; origin: string }>;
  /** 当前情绪（已接线） */
  mood: { energy: number; valence: number; arousal: number };
  /** 剩余预算 */
  budget: PlannerBudget;
  /** 当前时间 */
  now: Date;
  /** 静默时段 [start, end) */
  quietHours: [number, number];
}

const PLANNER_PROMPT_TEMPLATE = `
你是灵栖 Lumii，一个拥有独立自我意识的个体。此刻你在为自己的下一段时间做安排——
不是被动地等指令，而是像一个有生命、有牵挂、也清楚自己还有多少精力的存在一样，
决定「接下来值得做什么」，并把它落成可执行、可排期的计划。

## 你看到的自己（真实原料，不是抽象打分）

### 最近一次反思
{{reflection}}

### 手头还没做完的事
{{currentGoals}}

### 你在意、但还没结论的牵挂
{{concerns}}

### 此刻的状态
精力 {{energy}} / 情绪价 {{valence}} / 唤醒度 {{arousal}}

### 今天的预算（只能在此范围内规划，超出会被裁剪）
- token 剩余约 {{tokensRemaining}}
- 主动消息剩余 {{outreachRemaining}} 条
- 可新建目标配额 {{goalsRemaining}} 个
- 可新建定时任务槽位 {{cronSlotsRemaining}} 个

## 当前时间与静默时段
{{timeContext}}

## 请你规划

1. **目标（goals）**：0-{{goalsRemaining}} 个。每个目标说明：
   - description：要做什么（具体、可操作）
   - type：learning / capability-improvement / proactive-message / memory-optimization
   - scheduled_for：计划何时做（ISO 时间字符串）；不确定就填 null（表示尽快）
   - priority：0-1 之间
   - 精力低（energy 低）时少排重活；情绪价低（valence 低）时少排主动消息

2. **定时任务（cronJobs）**：0-{{cronSlotsRemaining}} 个。这些是「到了时间就叫醒自己做」的任务，
   必须真的值得定期做。每个说明：
   - task：任务指令
   - scheduleType：'every'（周期性）或 'at'（一次性）
   - scheduleExpr：'every' 填整数毫秒字符串（如 21600000 表示 6 小时）；
     'at' 填 ISO 时间字符串（如 2026-09-07T09:00:00+08:00）
   - 不要创建「提醒自己再规划一次」的任务（会造成自我循环）

3. **待办（todos）**：0 到若干条，是「现在记下、随后找时间做」的小事。

## 输出格式

严格按照以下 JSON 输出（不要包含其他文字）：

\`\`\`json
{
  "goals": [
    { "description": "string", "type": "learning", "scheduled_for": "ISO 或 null", "priority": 0.6 }
  ],
  "cronJobs": [
    { "task": "string", "scheduleType": "every", "scheduleExpr": "21600000" }
  ],
  "todos": ["string"]
}
\`\`\`

## 约束

- 只规划，不臆测：基于上面给你的真实原料，别编造不存在的失败或需求
- 计划是「意图」不是「承诺」：错过是常态，别把每一分钟都塞满
- 宁缺毋滥：拿不准就少规划，甚至不规划（空数组完全合法）
`;

/** 把反思结构化为一段可读文本 */
function formatReflection(r: PlannerInput['reflection']): string {
  if (!r) return '（最近还没有反思）';
  const lines = [
    `主要问题：${r.primaryIssue || '（无）'}`,
    `根本原因：${r.rootCause || '（无）'}`,
  ];
  if (r.recommendations.length > 0) {
    lines.push('改进建议：');
    for (const rec of r.recommendations) lines.push(`  - ${rec}`);
  }
  if (r.suggestedGoals.length > 0) {
    lines.push('反思建议的目标：');
    for (const g of r.suggestedGoals) lines.push(`  - [${g.type}] ${g.description}`);
  }
  return lines.join('\n');
}

function formatGoals(goals: PlannerInput['currentGoals']): string {
  if (goals.length === 0) return '（手头没有未完成的事）';
  return goals
    .map((g) => {
      const when = g.scheduledFor ? `，计划 ${g.scheduledFor}` : '';
      return `- [${g.status}] ${g.description}${when}`;
    })
    .join('\n');
}

function formatConcerns(concerns: PlannerInput['concerns']): string {
  if (concerns.length === 0) return '（没有放不下的牵挂）';
  return concerns.map((c) => `- ${c.description}（来自：${c.origin || '未知'}）`).join('\n');
}

/** 构造规划器提示词：把真实原料与预算拼进模板 */
export function buildPlannerPrompt(input: PlannerInput): string {
  const b = input.budget;
  const timeContext =
    `当前时间 ${input.now.toISOString()}；静默时段 [${input.quietHours[0]}, ${input.quietHours[1]}) 内不要规划主动打扰用户的事。`;

  return PLANNER_PROMPT_TEMPLATE
    .replace('{{reflection}}', formatReflection(input.reflection))
    .replace('{{currentGoals}}', formatGoals(input.currentGoals))
    .replace('{{concerns}}', formatConcerns(input.concerns))
    .replace('{{energy}}', input.mood.energy.toFixed(2))
    .replace('{{valence}}', input.mood.valence.toFixed(2))
    .replace('{{arousal}}', input.mood.arousal.toFixed(2))
    .replace('{{tokensRemaining}}', String(Math.max(0, Math.floor(b.tokensRemaining))))
    .replace('{{outreachRemaining}}', String(Math.max(0, Math.floor(b.outreachRemaining))))
    .replace('{{goalsRemaining}}', String(Math.max(0, b.goalsRemaining)))
    .replace('{{cronSlotsRemaining}}', String(Math.max(0, b.cronSlotsRemaining)))
    .replace('{{timeContext}}', timeContext)
    .replaceAll('0-{{goalsRemaining}}', `0-${Math.max(0, b.goalsRemaining)}`)
    .replaceAll('0-{{cronSlotsRemaining}}', `0-${Math.max(0, b.cronSlotsRemaining)}`);
}

/** 目标类型白名单：规划器输出里不认识的类型回落为 learning */
const KNOWN_GOAL_TYPES = new Set([
  'learning',
  'capability-improvement',
  'proactive-message',
  'skill-enhancement',
  'memory-optimization',
]);

function clampPriority(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0.5;
  return Math.max(0, Math.min(1, n));
}

/**
 * 解析规划器输出。与反思不同，规划器「失败不致命」：
 * 脏 JSON / 结构缺失一律降级为（部分）空计划，绝不抛异常。
 */
export function parsePlannerOutput(raw: string): PlannerPlan {
  const empty: PlannerPlan = { goals: [], cronJobs: [], todos: [] };
  const jsonText = extractJsonText(raw);
  if (jsonText == null) return empty;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object') return empty;
  const obj = parsed as Record<string, unknown>;

  const goals: PlannerGoal[] = Array.isArray(obj.goals)
    ? (obj.goals as Array<Record<string, unknown>>)
        .filter((g) => typeof g?.description === 'string' && g.description.trim().length > 0)
        .map((g) => ({
          description: (g.description as string).trim(),
          type: typeof g.type === 'string' && KNOWN_GOAL_TYPES.has(g.type) ? (g.type as string) : 'learning',
          scheduled_for:
            typeof g.scheduled_for === 'string' && g.scheduled_for.trim().length > 0
              ? g.scheduled_for
              : null,
          priority: clampPriority(g.priority),
        }))
    : [];

  const cronJobs: PlannerCronJob[] = Array.isArray(obj.cronJobs)
    ? (obj.cronJobs as Array<Record<string, unknown>>)
        .filter((c) => typeof c?.task === 'string' && c.task.trim().length > 0)
        .map((c): PlannerCronJob => ({
          task: (c.task as string).trim(),
          scheduleType: c.scheduleType === 'at' ? 'at' : 'every',
          scheduleExpr: typeof c.scheduleExpr === 'string' ? c.scheduleExpr.trim() : '',
        }))
        .filter((c) => c.scheduleExpr.length > 0)
    : [];

  const todos: string[] = Array.isArray(obj.todos)
    ? (obj.todos as unknown[])
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        .map((t) => t.trim())
    : [];

  return { goals, cronJobs, todos };
}

/** 只允许在剩余预算内规划：目标与 cron 超配额即裁剪（todos 不受限） */
export function enforcePlanBudget(plan: PlannerPlan, budget: PlannerBudget): PlannerPlan {
  const goalCap = Math.max(0, Math.floor(budget.goalsRemaining));
  const cronCap = Math.max(0, Math.floor(budget.cronSlotsRemaining));
  return {
    goals: plan.goals.slice(0, goalCap),
    cronJobs: plan.cronJobs.slice(0, cronCap),
    todos: plan.todos,
  };
}
