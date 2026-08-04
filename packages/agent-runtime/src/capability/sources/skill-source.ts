/**
 * skill-source — 将 SkillInfo[] 暴露为 CapabilityDescriptor[]
 *
 * 技能是只读/描述性能力，默认不带高风险权限。
 * mandatory/suggested 技能对所有 origin 可见；background 技能同样可见但优先级低。
 */

import type { SkillInfo } from "../../prompt/system-prompt-builder.js";
import type { CapabilityDescriptor } from "../types.js";

export function skillInfoToCapabilities(skills: readonly SkillInfo[]): CapabilityDescriptor[] {
  return skills.map((skill) => ({
    id: `skill:${skill.name}`,
    source: "skill" as const,
    name: skill.name,
    description: skill.description,
    permissions: ["read"] as const,
    isHighRisk: false,
  }));
}
