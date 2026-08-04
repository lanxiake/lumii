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
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { SkillInfo } from "../../prompt/system-prompt-builder.js";

const MAX_DESC_CHARS = 150;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function skillsNotAvailable(): AgentToolResult<unknown> {
  return {
    content: [
      { type: "text", text: JSON.stringify({ error: "Skills not available in this context." }) },
    ],
    details: undefined,
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

// ─── skill_list ───────────────────────────────────────────────────────────────

const SkillListInput = Type.Object({});
type SkillListInputType = Static<typeof SkillListInput>;

export const skillListToolConfig: MtBotToolConfig<typeof SkillListInput> = {
  name: "skill_list",
  label: "List Skills",
  description: "List all available skills with name and description.",
  parameters: SkillListInput,
  category: "filesystem",
  isReadOnly: true,
  needsPermission: false,
  async execute(
    _toolCallId: string,
    _params: SkillListInputType,
    context,
  ): Promise<AgentToolResult<unknown>> {
    if (!context.getSkills) return skillsNotAvailable();
    const skills = context.getSkills();
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
  },
};

// ─── skill_search ─────────────────────────────────────────────────────────────

const SkillSearchInput = Type.Object({
  query: Type.String({
    description:
      "Search query supporting multi-keyword modes:\n" +
      "- Space-separated (AND): 'pr review' → skills matching BOTH 'pr' AND 'review'\n" +
      "- Comma-separated (OR): 'pr, review' → skills matching 'pr' OR 'review'\n" +
      "- Combined: 'pr review, code analysis' → (pr AND review) OR (code AND analysis)\n" +
      "Always search with BOTH Chinese and English keywords for better coverage, e.g. '公众号, wechat article, publish'. " +
      "Use multiple OR terms rather than a single keyword.",
  }),
});
type SkillSearchInputType = Static<typeof SkillSearchInput>;

export const skillSearchToolConfig: MtBotToolConfig<typeof SkillSearchInput> = {
  name: "skill_search",
  label: "Search Skills",
  description:
    "Search skills by keyword — searches name, description, and when-to-use fields. " +
    "Supports multi-keyword AND (space-separated) and OR (comma-separated) logic.",
  parameters: SkillSearchInput,
  category: "filesystem",
  isReadOnly: true,
  needsPermission: false,
  async execute(
    _toolCallId: string,
    params: SkillSearchInputType,
    context,
  ): Promise<AgentToolResult<unknown>> {
    if (!context.getSkills) return skillsNotAvailable();
    const skills = context.getSkills();

    // 支持逗号分隔的 OR 组，每组内空格分隔为 AND 条件
    // 例："pr review, code analysis" → (pr AND review) OR (code AND analysis)
    const orGroups = params.query
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
            hint: "No skills matched. Use skill_list to see all available skills.",
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
  description: "Load a skill's full SKILL.md instructions and list its available resources.",
  parameters: SkillInvokeInput,
  category: "filesystem",
  isReadOnly: true,
  needsPermission: false,
  async execute(
    _toolCallId: string,
    params: SkillInvokeInputType,
    context,
  ): Promise<AgentToolResult<unknown>> {
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
              hint: `Use skill_list to see available skills. Available: ${available || "(none)"}`,
            }),
          },
        ],
        details: undefined,
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
