/**
 * tool-source — 将 ToolRegistry 暴露为 CapabilityDescriptor[]
 *
 * 映射规则：
 * - needsPermission=true → permissions 含 "execute"
 * - isReadOnly=false     → permissions 含 "write"
 * - category="shell"     → permissions 含 "shell"
 * - category="shell" 或 needsPermission=true → isHighRisk=true
 */

import type { ToolRegistry } from "../../tools/tool-registry.js";
import type { CapabilityDescriptor, CapabilityPermission } from "../types.js";

export function toolRegistryToCapabilities(registry: ToolRegistry): CapabilityDescriptor[] {
  return registry.getAll().map((tool) => {
    const permissions: CapabilityPermission[] = ["read"];

    if (!tool.isReadOnly) permissions.push("write");
    if (tool.needsPermission) permissions.push("execute");
    if (tool.category === "shell") permissions.push("shell");
    if (tool.category === "web") permissions.push("network");

    const isHighRisk = tool.category === "shell" || tool.needsPermission;

    return {
      id: tool.name,
      source: "tool" as const,
      name: tool.label,
      description: tool.description,
      permissions,
      isHighRisk,
    };
  });
}
