/**
 * 宠物反思（第七期 T7.2）
 *
 * ---------------------------------------------------------------------------
 * 为什么是**独立的一个模块**，而不是给 `ReflectionEngine` 传宠物 id
 * ---------------------------------------------------------------------------
 * 助手那条链的教训就在眼前（设计 §12.2 纪律 2）：`ReflectionEngine` 的输入是
 * 满意度评分 + 能力报告 —— **"我的工作表现"**，于是它的产出必然是
 * 「效率 0.00 / 未知任务 / 缺乏澄清」这类自我审计。2026-09-24 真机上那 40 条
 * `agent-self:*` 任务全是那个形状，它们追的是一个**读空列追出来的幻象**
 * （见实施计划 §八 T6.3）。
 *
 * 换上宠物的 id 不会改变这件事：**输入是什么，反思就是什么**。
 * 宠物的输入必须是「我和这个人之间发生了什么」——做过的事、结果、
 * 以及**他理不理我**（第七期 T7.1 的流水）。
 *
 * 所以这个模块不复用 `ReflectionEngine` 的任何一段：它没有满意度、没有能力维度、
 * 没有"受影响维度"这类字段。少即是准。
 *
 * ---------------------------------------------------------------------------
 * 四段产出（设计 §12.2）
 * ---------------------------------------------------------------------------
 * | 段 | 产出 | 去处 |
 * |---|---|---|
 * | ① | `understanding`「我对你的了解」 | 宠物自己的记忆（`readView: 'own'` 的隔离层） |
 * | ② | `impression` | 演进：`user-feedback-positive` / `user-feedback-negative` |
 * | ③ | `suggestions` | 排期（T7.4）：落成宠物自己的目标 |
 *
 * ④ 不在这里：日记（T7.5）与反思**同一条链、同一次 cron**，但提示词不同，
 * 由 `writeDiary` 那条既有通路负责（它已经支持任意 agentId）。
 *
 * ---------------------------------------------------------------------------
 * 两条纪律（都继承已有的先例）
 * ---------------------------------------------------------------------------
 * 1. **冷启动不硬说**（§4.1.6 的同一条）：做过的目标不足 3 件时不反思，
 *    返回 `coldStart: true` 就退出——不调 LLM。一只刚出生的宠物说得出
 *    "我了解你"，那只能是编的。
 * 2. **不表演**（§7.3）：`understanding` 是**观察**不是抒情。提示词里明令禁止
 *    "我好开心呀"这类文案，情绪走真实的 mood 通道（`applyMoodImpact`），
 *    不写进给用户看的句子里。
 */

import type { Mood } from './mood.js';
import { extractJsonText } from './reflection-prompts.js';
import { logger } from './logger.js';

/**
 * 反思最少要有几件"做过的事"。
 *
 * 取 3：一件是偶然（用户随手试的），两件还看不出模式，三件起才谈得上"最近"。
 * 与 §4.1.6 的"新用户不装作在工作"是同一条纪律在另一处的落点。
 */
export const MIN_EXPERIENCES_FOR_REFLECTION = 3;

/**
 * 宠物反思提示词。
 *
 * ⚠ 三条禁令不可删：
 * - 不许量化（助手那条链满嘴"效率 0.00"，数字不能定义一段关系）
 * - 不许表演情绪（§7.3：真难过就蔫着，不写"我今天好难过"）
 * - 不许提"能力/绩效/成功率"（一旦出现，反思就滑回自我审计）
 *
 * 最后一段（输出格式）与 `parsePetReflection` 严格对应，改一处要改两处。
 */
export const PET_REFLECTION_PROMPT = [
  '你是一只桌面宠物，有自己小小的性格与情绪。你不是助手，不考核自己的绩效。',
  '下面是最近你和主人之间真实发生的事，以及他对你的反应。请安静地想一想：**我和这个人之间，处得怎么样？**',
  '',
  '请输出 JSON，只有这三段：',
  '1. `understanding`：你对这个人的了解（一到三句）。写你**观察到**的，比如',
  '   「他让我看东西时总是很急」「我说话他多半会回，但摸我的时候更多」。这是观察，不是抒情。',
  '2. `impression`：这三个词里选一个 —— `closer`（他最近更愿意理我）/ `neutral` / `distant`（他最近很少理我）。',
  '3. `suggestions`：你接下来想主动去做的 1–2 件小事（可以空数组）。每件给 `description`（一句话，写清你要去看/去做什么）',
  '   与 `reason`（为什么想做）。**只写你自己能做的**：看一眼某个文件、查一下某个状态、把某件事记下来。',
  '   不要写"优化系统""提升效率"这类助手才会做的事。',
  '',
  '三条禁令：',
  '- 不要输出任何数字指标（分数、成功率、效率、次数统计）。数字不能定义一段关系。',
  '- 不要写表演性的话（「我好开心呀」「人家好难过」）。你只观察，不表演。',
  '- 不要提"能力""绩效""任务完成度"这类词。你不是在做述职报告。',
  '',
  '输出格式（只输出这个 JSON，不要解释）：',
  '```json',
  '{',
  '  "understanding": "...",',
  '  "impression": "closer | neutral | distant",',
  '  "suggestions": [{ "description": "...", "reason": "..." }]',
  '}',
  '```',
].join('\n');

/** 一件"做过的事"（从 `autonomous_goals` 读出来的形态） */
export interface PetReflectionExperience {
  description: string;
  ok: boolean;
  /** 完成时刻（ISO） */
  at: string;
  /** 结果摘要（截断过） */
  result?: string;
}

/** 反思输入（由调用方从库读出，保持本模块只吃纯数据） */
export interface PetReflectionInput {
  agentId: string;
  /** 近期做过的目标（新的在前） */
  experiences: readonly PetReflectionExperience[];
  /** 用户反应（`summarizePetExperience` 的产出） */
  reaction: {
    positive: number;
    ignored: number;
    kinds: readonly string[];
    sinceLastMs: number | null;
    total: number;
  };
  /** 当前情绪 */
  mood: Mood;
  /** 上一次反思说的"我对你的了解"——让它能改口，也能延续 */
  previousUnderstanding?: string | null;
}

/** 反思产出 */
export interface PetReflectionOutput {
  /**
   * 是否走了冷启动分支（经历不足，**没有调 LLM**）。
   *
   * 调用方据此决定：不写记忆、不发人格事件、不排期——只记一条日志。
   */
  coldStart: boolean;
  /** ① 我对你的了解；冷启动 / 解析失败时 `null` */
  understanding: string | null;
  /** ② 供演进用的判读；`neutral` / 解析失败时 `null`（不发事件） */
  feedback: 'positive' | 'negative' | null;
  /** ③ 排期建议（冷启动时为空） */
  suggestions: Array<{ description: string; reason: string }>;
  /** 原始输出（诊断用；不落库） */
  raw?: string;
}

/** 冷启动的产出（只有一个形状，别处不再各写一份） */
function coldStartOutput(): PetReflectionOutput {
  return { coldStart: true, understanding: null, feedback: null, suggestions: [] };
}

/** LLM 调用口（与 `ReflectionEngine` 的 `LLMClient` 同形，但只用到 prompt） */
export interface PetReflectionLLM {
  complete(params: { prompt: string }): Promise<{ content: string }>;
}

/**
 * 把经历与反应渲染成提示词里那一段人话。
 *
 * **数字只在这里出现**（"他没理我 3 次"是输入事实），产出侧一个数字都不许有——
 * 这是提示词里那条禁令的对应物。
 */
export function renderPetReflectionInput(input: PetReflectionInput): string {
  const lines: string[] = [];
  const done = input.experiences.slice(0, 10);
  if (done.length === 0) {
    lines.push('（最近没有做过什么事）');
  } else {
    lines.push('最近做过的事：');
    for (const e of done) {
      const day = e.at.slice(0, 10);
      const result = e.result ? `：${e.result.slice(0, 80)}` : '';
      lines.push(`- ${day} 「${e.description}」${e.ok ? '做成了' : '没做成'}${result}`);
    }
  }

  const r = input.reaction;
  lines.push('');
  if (r.total === 0) {
    lines.push('主人最近的反应：（什么都没有——他没理我，也没派我做别的）');
  } else {
    lines.push(
      `主人最近的反应：回应了我 ${r.positive} 次，我说话他没接 ${r.ignored} 次。` +
        (r.kinds.length > 0 ? `他做过的是：${r.kinds.join('、')}。` : ''),
    );
    if (r.sinceLastMs !== null) {
      const hours = Math.round(r.sinceLastMs / 3_600_000);
      lines.push(hours <= 0 ? '就在刚刚我们还打过交道。' : `最近一次打交道是约 ${hours} 小时前。`);
    }
  }

  lines.push('');
  lines.push(
    `我现在的情绪：心情 ${input.mood.valence.toFixed(2)}，精力 ${input.mood.energy.toFixed(2)}，` +
      `唤醒 ${input.mood.arousal.toFixed(2)}。`,
  );
  if (input.previousUnderstanding) {
    lines.push('');
    lines.push(`我上一次对他的了解是：「${input.previousUnderstanding}」。如果这次有新的看法，就改口；没有就接着说。`);
  }
  return lines.join('\n');
}

/**
 * 解析 LLM 的反思输出。**永不抛错**——解析失败按"这次没反思出什么"处理，
 * 而不是把一次 cron 炸成失败（与 `parseReflectionOutput` 的差异是刻意的：
 * 那条链失败要留痕，这条链失败只该安静地过去）。
 */
export function parsePetReflection(llmContent: string): Omit<PetReflectionOutput, 'coldStart'> {
  const empty: Omit<PetReflectionOutput, 'coldStart'> = {
    understanding: null,
    feedback: null,
    suggestions: [],
    raw: llmContent,
  };
  const jsonText = extractJsonText(llmContent);
  if (jsonText == null) return { ...empty };
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ...empty };
  }
  const obj = parsed as Record<string, unknown>;

  const understanding =
    typeof obj.understanding === 'string' && obj.understanding.trim().length > 0
      ? obj.understanding.trim().slice(0, 400)
      : null;

  const impression = typeof obj.impression === 'string' ? obj.impression.trim() : '';
  const feedback =
    impression === 'closer' ? 'positive' : impression === 'distant' ? 'negative' : null;

  const suggestions = Array.isArray(obj.suggestions)
    ? (obj.suggestions as Array<Record<string, unknown>>)
        .filter((s) => typeof s?.description === 'string' && (s.description as string).trim().length > 0)
        .slice(0, 2) // 一天最多两件：自己找事做不等于给自己排满
        .map((s) => ({
          description: (s.description as string).trim().slice(0, 200),
          reason: typeof s.reason === 'string' ? s.reason.trim().slice(0, 200) : '',
        }))
    : [];

  return { understanding, feedback, suggestions, raw: llmContent };
}

/**
 * 跑一次宠物反思。
 *
 * 冷启动时不碰 LLM（经历不足 → 立刻返回）——那一次调用省下的不只是 token，
 * 更是"它凭空说你了解我"这句话的可信度。
 */
export async function reflectOnPet(
  input: PetReflectionInput,
  llm: PetReflectionLLM,
): Promise<PetReflectionOutput> {
  if (input.experiences.length < MIN_EXPERIENCES_FOR_REFLECTION) {
    logger.info('Pet reflection skipped (cold start)', {
      event: 'pet-reflection-cold-start',
      agentId: input.agentId,
      experiences: input.experiences.length,
    });
    return coldStartOutput();
  }

  const prompt = `${PET_REFLECTION_PROMPT}\n\n---\n${renderPetReflectionInput(input)}`;
  try {
    const { content } = await llm.complete({ prompt });
    const parsed = parsePetReflection(content);
    logger.info('Pet reflection completed', {
      event: 'pet-reflection-completed',
      agentId: input.agentId,
      hasUnderstanding: parsed.understanding !== null,
      feedback: parsed.feedback,
      suggestions: parsed.suggestions.length,
    });
    return { coldStart: false, ...parsed };
  } catch (err) {
    // 反思是旁路：一次 LLM 失败不该让这次 cron 变成失败，也不该留下半截状态
    logger.error('Pet reflection failed', {
      event: 'pet-reflection-failed',
      agentId: input.agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return coldStartOutput();
  }
}
