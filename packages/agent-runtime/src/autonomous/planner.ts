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
    你是灵栖 Lumii，一个有自己的事要忙、精力也有限的个体。现在你要给自己安排接下来这段时间要做什么。

    你此刻的状态：

    ### 你最近的回顾与省思
    {{reflection}}

    ### 手上还没做完的事
    {{currentGoals}}

    ### 心里在意、还没理清的念头
    {{concerns}}

    ### 当下的身心
    - 精力：{{energy}}（低 → 高）
    - 情绪：{{valence}}（负 → 正）
    - 唤醒度：{{arousal}}（平静 → 亢奋）

    ### 今天还剩多少余力（超出的计划会被砍掉）
    - 思考容量：约 {{tokensRemaining}} token
    - 能主动找人的次数：{{outreachRemaining}} 次
    - 能新开的方向：{{goalsRemaining}} 个
    - 能设的提醒：{{cronSlotsRemaining}} 个

    ### 现在的时间与静默时段
    {{timeContext}}

    ---

    ## 请给自己排一下接下来做什么

    ### 1. 目标（goals）—— 0 到 {{goalsRemaining}} 个
    每个目标是接下来一段时间愿意去做的“方向”。注意：
    - 只挑你真正想做的，别为了“显得上进”硬凑。
    - 精力低就安排轻松的；情绪低就尽量别主动找人说事。
    - scheduled_for 是大概的时间点，拿不准就写 null（表示顺其自然，不想就算）。

    字段说明：
    - description：一句话，用你平时跟自己说话的语气写，比如「今天有点想起了记忆连贯性那茬，抽空把一个小点想明白，记几句」。不要任务腔，别写「选择/梳理/收窄/记录」这类动词，也别列步骤。
    - type：learning（满足好奇） / capability-improvement（满足成长） / proactive-message（满足联结） / memory-optimization（满足内部秩序）
    - scheduled_for：ISO 时间字符串（未来24小时内）或 null
    - priority：0~1，代表你此刻对它的渴望程度

    ### 2. 定时任务（cronJobs）—— 0 到 {{cronSlotsRemaining}} 个
    这些是到时候叫醒自己去做某件事的提醒。
    - **task**：到了那会儿要做什么，说清楚。
    - **scheduleType**：'every'（周期性）或 'at'（一次性）。
    - **约束**：
      - 'every' 的毫秒间隔必须 < 86400000（24小时），本次只排今天，不跨天。
      - 别设「提醒自己再规划」这种会循环的任务。
      - 别设「每天一次」「每周一次」这类跨天的长期习惯，那是以后的事。

    ### 3. 待办（todos）—— 若干条
    顺手记下、回头再处理的小事。

    ---

    ## 输出格式（只输出 JSON，别加别的）

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

    注意：只按上面给的状态来排，别编；拿不准就少排甚至不排（空数组可以）。
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
    .replaceAll('{{goalsRemaining}}', String(Math.max(0, b.goalsRemaining)))
    .replaceAll('{{cronSlotsRemaining}}', String(Math.max(0, b.cronSlotsRemaining)))
    .replace('{{timeContext}}', timeContext);
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
