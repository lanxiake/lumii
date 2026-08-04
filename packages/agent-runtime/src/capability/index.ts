export type {
  CapabilityDescriptor,
  CapabilitySource,
  CapabilityPermission,
  CapabilityExecutionContext,
} from "./types.js";
export { CapabilityRegistry } from "./capability-registry.js";
export { toolRegistryToCapabilities } from "./sources/tool-source.js";
export { skillInfoToCapabilities } from "./sources/skill-source.js";
export { mcpToolsToCapabilities } from "./sources/mcp-source.js";
