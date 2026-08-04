/**
 * ActivationResolver — 客户端侧技能激活解析器
 *
 * 职责：在每次用户输入到达 Agent 前，根据 `SkillInfo.whenToUse` 与 `pathGlobs`
 *      计算当前轮次应「强制」或「建议」加载的技能，并转换为 `SkillActivationHint[]`
 *      注入到系统提示词的动态部分。
 *
 * 对齐参考：
 * - claude-code-rev/src/utils/attachments.ts（memoryFile.globs → load_reason=path_glob_match）
 * - claude-code-rev/src/tools/SkillTool/prompt.ts（whenToUse 注入列表）
 *
 * 设计要点：
 * 1. 纯函数 + 无副作用：只读取 SkillInfo 快照与当前上下文，不修改全局状态
 * 2. 激活分层（activationTier）：
 *    - mandatory → 视为 MUST-load，tier=mandatory
 *    - suggested → tier=suggested
 *    - background / 未声明 → 仅在强触发（path_glob / user_explicit）命中时才建议
 * 3. 触发原因（对齐 CCR hooks.load_reason）：
 *    - path_glob：用户 query 中包含的路径（@mention / 开头引用）匹配 skill.pathGlobs
 *    - intent_match：用户 query 文本包含 skill.whenToUse 中的关键短语
 *    - user_explicit：用户 query 明确提到 skill 名称（以 / 或 @技能名 等形式）
 *    - rule：其他由宿主注入的硬编码规则（例如"首次加载"）
 * 4. 幂等 / 可缓存：同输入同输出；调用方可以在会话级缓存结果。
 */

import type { SkillInfo, SkillActivationHint } from "../prompt/system-prompt-builder.js";

/** ActivationResolver 的输入上下文 */
export interface ActivationContext {
  /** 本轮用户原始输入（通常是最后一条 user 消息的文本） */
  readonly userInput: string;
  /**
   * 本轮用户输入中显式引用的路径（来自 `@file.ts` 或消息中的绝对/相对路径）
   * 可由调用方预解析；若缺省则仅基于 userInput 文本做简单启发式
   */
  readonly referencedPaths?: readonly string[];
  /** 可用的技能清单（宿主最新快照） */
  readonly skills: readonly SkillInfo[];
}

/** 单个 Skill 的匹配决策 */
interface MatchDecision {
  readonly shouldActivate: boolean;
  readonly tier: "mandatory" | "suggested";
  readonly reason: SkillActivationHint["reason"];
  readonly detail?: string;
}

/**
 * 主入口：计算本轮应激活的 Skills
 *
 * 分层策略：
 * - always：强制注入为 mandatory，不参与其他评估
 * - on_demand：跳过自动匹配，仅响应 user_explicit
 * - contextual（默认）：正常走 path_glob + intent_match 逻辑
 *
 * @returns 按 tier 降序（mandatory → suggested）排列的提示列表
 *          若无任何命中，返回空数组；调用方无需特殊处理。
 */
export function resolveSkillActivations(ctx: ActivationContext): readonly SkillActivationHint[] {
  const hints: SkillActivationHint[] = [];

  for (const skill of ctx.skills) {
    const scope = skill.activationScope ?? "contextual";

    // always：无条件注入，不参与其他评估
    if (scope === "always") {
      hints.push({
        skillName: skill.name,
        tier: "mandatory",
        reason: "rule",
        detail: "Skill activation_scope=always",
      });
      continue;
    }

    // on_demand：只允许 user_explicit 触发，跳过自动匹配
    if (scope === "on_demand") {
      const lowerInput = ctx.userInput.toLowerCase();
      if (matchesExplicitMention(skill.name, lowerInput)) {
        hints.push({
          skillName: skill.name,
          tier: "mandatory",
          reason: "user_explicit",
          detail: `User referenced on_demand skill "${skill.name}" directly`,
        });
      }
      continue;
    }

    // contextual（默认）：正常三层评估
    const decision = decideSkill(skill, ctx);
    if (!decision.shouldActivate) continue;
    hints.push({
      skillName: skill.name,
      tier: decision.tier,
      reason: decision.reason,
      detail: decision.detail,
    });
  }

  // 同等 tier 内按 skill.name 排序，便于确定性输出（单元测试可 reproducible）
  hints.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === "mandatory" ? -1 : 1;
    return a.skillName.localeCompare(b.skillName);
  });

  return hints;
}

/**
 * 决策单个 Skill 是否本轮应被激活
 *
 * 评估顺序（自强至弱）：
 * 1. user_explicit（最强，默认 mandatory）：用户输入里直接出现 "/skillName"
 *    或 "@skillName" 或 全名引用（例如 `使用 issue-manager 修复...`）
 * 2. path_glob（强）：referencedPaths 中至少一个匹配 skill.pathGlobs
 *    → 若 skill.activationTier=mandatory 则 mandatory，否则 suggested
 * 3. intent_match（中）：userInput 中包含 whenToUse 里的关键短语
 *    → tier 按 activationTier 降级
 */
function decideSkill(skill: SkillInfo, ctx: ActivationContext): MatchDecision {
  const lowerInput = ctx.userInput.toLowerCase();

  // 1. user_explicit: /skillName or @skillName or ` skillName ` 之类
  if (matchesExplicitMention(skill.name, lowerInput)) {
    return {
      shouldActivate: true,
      tier: "mandatory",
      reason: "user_explicit",
      detail: `User referenced skill "${skill.name}" directly`,
    };
  }

  // 2. path_glob
  if (skill.pathGlobs && skill.pathGlobs.length > 0 && ctx.referencedPaths?.length) {
    const matched = ctx.referencedPaths.find((p) => anyGlobMatches(p, skill.pathGlobs!));
    if (matched) {
      return {
        shouldActivate: true,
        tier: skill.activationTier === "mandatory" ? "mandatory" : "suggested",
        reason: "path_glob",
        detail: `File ${matched} matched skill path globs`,
      };
    }
  }

  // 3. intent_match（基于 whenToUse 关键短语）
  // background tier 技能噪声高，仅响应强触发（user_explicit / path_glob），跳过 intent_match
  if (skill.whenToUse && skill.activationTier !== "background") {
    const phrases = extractTriggerPhrases(skill.whenToUse);
    const hit = phrases.find((phrase) => phrase.length >= 3 && lowerInput.includes(phrase));
    if (hit) {
      return {
        shouldActivate: true,
        tier: skill.activationTier === "mandatory" ? "mandatory" : "suggested",
        reason: "intent_match",
        detail: `Matched phrase "${hit}" in when_to_use`,
      };
    }
  }

  return { shouldActivate: false, tier: "suggested", reason: "rule" };
}

/**
 * 判断用户输入是否显式提到 skill 名称
 *
 * 支持：
 * - /skill-name（斜杠指令风格）
 * - @skill-name（at 提及风格）
 * - "使用 <skill-name>"、"<skill-name> 帮我..." 之类（完整单词边界匹配）
 */
function matchesExplicitMention(skillName: string, lowerInput: string): boolean {
  const nameLower = skillName.toLowerCase();
  if (!nameLower) return false;
  if (lowerInput.includes(`/${nameLower}`)) return true;
  if (lowerInput.includes(`@${nameLower}`)) return true;
  // 完整单词边界（避免 "plan-agent" 误命中 "planning"）
  const boundary = new RegExp(`(^|[\\s"'\`\\-_/])${escapeRegex(nameLower)}([\\s"'\`\\-_/]|$)`);
  return boundary.test(lowerInput);
}

/**
 * 从 whenToUse 文本中提取触发关键短语
 *
 * 简化策略：
 * - 移除常见停用词（the/a/when/use 等）
 * - 保留 3+ 字符的词组（bigram / 单词）
 * - 去重
 *
 * 不追求语义级匹配，主要作为"弱信号"补充；真正强信号仍靠路径或显式引用。
 */
function extractTriggerPhrases(whenToUse: string): readonly string[] {
  const lowered = whenToUse.toLowerCase();
  // 按标点/空白切分为候选
  const words = lowered
    .split(/[\s.,;:!?"'()[\]{}<>/\\]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  // bigram（相邻两词合并）+ 单词
  const phrases = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    phrases.add(words[i]!);
    if (i + 1 < words.length) {
      phrases.add(`${words[i]} ${words[i + 1]}`);
    }
  }
  return Array.from(phrases);
}

/** 极简 glob 匹配（支持 `*` 与 `**`，用于轻量 path_glob 判断） */
function anyGlobMatches(path: string, globs: readonly string[]): boolean {
  const normalized = path.replace(/\\/g, "/");
  return globs.some((g) => globToRegex(g).test(normalized));
}

/**
 * 将 glob 模式转换为 RegExp（简化版）
 *
 * - `**` → `.*`
 * - `*` → `[^/]*`
 * - `?` → `[^/]`
 * - 其余字符转义
 */
function globToRegex(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  let out = "^";
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i]!;
    if (c === "*") {
      if (normalized[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (/[a-z0-9/_\-.]/i.test(c)) {
      out += c;
    } else {
      out += "\\" + c;
    }
  }
  out += "$";
  return new RegExp(out, "i");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const STOP_WORDS = new Set<string>([
  "the",
  "and",
  "for",
  "use",
  "when",
  "you",
  "this",
  "that",
  "with",
  "from",
  "into",
  "onto",
  "via",
  "are",
  "has",
  "have",
  "will",
  "should",
  "must",
  "may",
  "can",
  "would",
  "could",
  "their",
  "your",
  "not",
  "but",
  "also",
  "than",
  "like",
  "such",
  "any",
  "all",
  "new",
  "old",
  "one",
  "two",
  "three",
  "user",
  "users",
  "asks",
  "ask",
]);
