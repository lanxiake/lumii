/**
 * 工具适配器 — MtBotTool 构建辅助
 *
 * 简化从 plain config 创建 MtBotTool 实例的过程。
 */

import type { TSchema, Static } from "@sinclair/typebox";
import type {
  MtBotTool,
  ToolCategory,
  ToolExecutionContext,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "../types/tool.js";

export interface MtBotToolConfig<T extends TSchema = TSchema, TDetails = unknown> {
  name: string;
  label: string;
  description: string;
  parameters: T;
  category: ToolCategory;
  isReadOnly: boolean;
  needsPermission: boolean;
  /** 可选的自定义启用检查，默认 always true */
  isEnabled?: () => boolean;
  execute: (
    toolCallId: string,
    params: Static<T>,
    context: ToolExecutionContext,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
}

/**
 * 创建 MtBotTool 实例
 *
 * 将工具执行绑定到提供的 ToolExecutionContext。
 * 这允许工具定义独立于平台层，执行时由平台注入 context。
 */
export function createMtBotTool<T extends TSchema, TDetails = unknown>(
  config: MtBotToolConfig<T, TDetails>,
  context: ToolExecutionContext,
): MtBotTool<T, TDetails> {
  return {
    name: config.name,
    label: config.label,
    description: config.description,
    parameters: config.parameters,
    category: config.category,
    isReadOnly: config.isReadOnly,
    needsPermission: config.needsPermission,
    isEnabled: config.isEnabled ?? (() => true),
    execute: (toolCallId, params, signal?, onUpdate?) =>
      config.execute(toolCallId, params, context, signal, onUpdate),
  };
}
