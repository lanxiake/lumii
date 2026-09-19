/**
 * Skill Tools — skill_list / skill_search / skill_invoke
 *
 * 技能系统工具化：将技能发现与加载从系统提示词静态注入改为按需工具调用，
 * 解决技能膨胀问题（~1500 tokens → ~40 tokens）。
 *
 * 目录结构约束：
 *   /skills/pr-manager/SKILL.md          ← 无分类（1 层）
 *   /skills/aaa/pr-manager/SKILL.md      ← 有分类（2 层，最多嵌套一层）
 *
 * SkillInfo.location 存储 SKILL.md 完整路径，skillDir = dirname(location)。
 */

import { Type, type Static } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../tool-adapter.js";
import type { MtBotToolResult } from "../../types/tool.js";
import type { SkillInfo } from "../../prompt/system-prompt-builder.js";

const MAX_DESC_CHARS = 150;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function skillsNotAvailable(): MtBotToolResult<unknown> {
  return {
    content: [
      { type: "text", text: JSON.stringify({ error: "Skills not available in this context." }) },
    ],
    details: undefined,
    isError: true,
  };
}

/** 从 SKILL.md 完整路径推导技能目录（跨平台） */
function skillDir(location: string): string {
  const sep = location.includes("\\") ? "\\" : "/";
  const parts = location.split(sep);
  return parts.slice(0, -1).join(sep);
}

/** 格式化单条技能为列表项 */
function formatSkill(s: SkillInfo): { name: string; description: string } {
  return { name: s.name, description: truncate(s.description, MAX_DESC_CHARS) };
}

// ─── skill_search（并入原 skill_list：不带 query 即列出全部） ────────────────

const SkillSearchInput = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        "Search query supporting multi-keyword modes:\n" +
        "- Omitted: list ALL local skills (use this instead of a separate list tool)\n" +
        "- Space-separated (AND): 'pr review' → skills matching BOTH 'pr' AND 'review'\n" +
        "- Comma-separated (OR): 'pr, review' → skills matching 'pr' OR 'review'\n" +
        "- Combined: 'pr review, code analysis' → (pr AND review) OR (code AND analysis)\n" +
        "Always search with BOTH Chinese and English keywords for better coverage, e.g. '公众号, wechat article, publish'. " +
        "Use multiple OR terms rather than a single keyword.",
    }),
  ),
});
type SkillSearchInputType = Static<typeof SkillSearchInput>;

export const skillSearchToolConfig: MtBotToolConfig<typeof SkillSearchInput> = {
  name: "skill_search",
  label: "Search Skills",
  description:
    "Discover skills: list or search LOCAL skills by name, description, and when-to-use. " +
    "Call WITHOUT query to list every local skill; pass query for multi-keyword AND (space-separated) " +
    "and OR (comma-separated) logic. " +
    "Use this FIRST whenever the question is which skills exist (e.g. “有没有…的技能”), and answer from its results. " +
    "If nothing local matches, say so — the remote marketplace (the `skillnet` skill) is a separate, " +
    "user-initiated step, loaded via `skill_invoke` rather than `execute_skill`.",
  parameters: SkillSearchInput,
  category: "filesystem",
  isReadOnly: true,
  needsPermission: false,
  async execute(
    _toolCallId: string,
    params: SkillSearchInputType,
    context,
  ): Promise<MtBotToolResult<unknown>> {
    if (!context.getSkills) return skillsNotAvailable();
    const skills = context.getSkills();

    // 不带 query = 列出全部。这不是"顺手加的分支"——原来有个独立的 skill_list，
    // 它的全部实现就是「无过滤条件的列举」，与这里的唯一区别是没有 query 参数。
    const query = params.query?.trim() ?? "";
    if (!query) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              skills: skills.map(formatSkill),
              total: skills.length,
            }),
          },
        ],
        details: undefined,
      };
    }

    // 支持逗号分隔的 OR 组，每组内空格分隔为 AND 条件
    // 例："pr review, code analysis" → (pr AND review) OR (code AND analysis)
    const orGroups = query
      .split(",")
      .map((group) => group.toLowerCase().trim().split(/\s+/).filter(Boolean))
      .filter((g) => g.length > 0);

    const matched = skills.filter((s) => {
      const haystack = [s.name, s.description, s.whenToUse ?? ""].join(" ").toLowerCase();
      return orGroups.some((andTerms) => andTerms.every((t) => haystack.includes(t)));
    });

    const result =
      matched.length > 0
        ? { skills: matched.map(formatSkill), total: matched.length }
        : {
            skills: [],
            total: 0,
            // 不再教 execute_skill：本机 skillnet 是**文档技能**（无 [executable]），
            // 原提示让模型去执行一个必然失败的 id，失败文案又把它推向 skill_invoke
            // （2026-09-19 t11 实测的完整越级链）。
            hint:
              "No local skills matched — report this to the user. Searching the remote marketplace is a separate, " +
              "user-initiated step: load the `skillnet` skill (`skill_invoke`) only when the user asks to look beyond local skills.",
          };

    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      details: undefined,
    };
  },
};

// ─── skill_invoke ─────────────────────────────────────────────────────────────

const SkillInvokeInput = Type.Object({
  skillName: Type.String({ description: "Skill name to load (case-insensitive)" }),
});
type SkillInvokeInputType = Static<typeof SkillInvokeInput>;

export const skillInvokeToolConfig: MtBotToolConfig<typeof SkillInvokeInput> = {
  name: "skill_invoke",
  label: "Invoke Skill",
  description:
    "Load a skill's full SKILL.md instructions and list its available resources. " +
    "Pass a name you ALREADY have — from the skills list in the system prompt or from skill_search results. " +
    "If you don't have an exact name yet, call skill_search first; never guess a name.",
  parameters: SkillInvokeInput,
  category: "filesystem",
  isReadOnly: true,
  needsPermission: false,
  async execute(
    _toolCallId: string,
    params: SkillInvokeInputType,
    context,
  ): Promise<MtBotToolResult<unknown>> {
    if (!context.getSkills) return skillsNotAvailable();

    const skills = context.getSkills();
    const nameLower = params.skillName.toLowerCase();
    const skill = skills.find((s) => s.name.toLowerCase() === nameLower);

    if (!skill) {
      const available = skills.map((s) => s.name).join(", ");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `Skill "${params.skillName}" not found.`,
              hint: `Use skill_search (no query) to list all skills. Available: ${available || "(none)"}`,
            }),
          },
        ],
        details: undefined,
        isError: true,
      };
    }

    const dir = skillDir(skill.location);

    let content: string;
    try {
      content = await context.readFile(skill.location);
    } catch {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `Failed to read SKILL.md for "${skill.name}".`,
              skillDir: dir,
            }),
          },
        ],
        details: undefined,
        isError: true,
      };
    }

    // 列出技能目录下一层所有文件（排除 SKILL.md 本身）
    let resources: string[] = [];
    try {
      const sep = skill.location.includes("\\") ? "\\" : "/";
      const skillMdName = skill.location.split(sep).at(-1) ?? "SKILL.md";
      const all = await context.glob("**/*", { cwd: dir });
      resources = all.filter((f) => f !== skillMdName && !f.toLowerCase().endsWith("skill.md"));
    } catch {
      // glob 失败不影响主流程
    }

    // 通知宿主层：技能已被加载（用于累计 executionCount）
    try {
      await context.recordSkillExecution?.(skill.id ?? skill.name);
    } catch {
      // 宿主回调失败绝不影响工具结果返回
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            skill: skill.name,
            skillDir: dir,
            content,
            resources,
            note:
              resources.length > 0
                ? `Resources are relative to skillDir. Use file_read with absolute path: skillDir + '/' + resource`
                : "No additional resources in this skill directory.",
          }),
        },
      ],
      details: undefined,
    };
  },
};
