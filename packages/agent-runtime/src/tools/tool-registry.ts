/**
 * ToolRegistry — 工具注册中心
 *
 * 管理 MtBotTool 实例的注册、查询和过滤。
 * 提供到 pi-agent-core AgentTool[] 的转换，用于注入 Agent。
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { MtBotTool, ToolCategory, ToolExecutionContext } from "../types/tool.js";
import type { HookAgentToolResult, ToolRunLifecycle } from "./tool-hooks.js";
import { ToolRunner } from "./tool-runner.js";

export class ToolRegistry {
  private readonly tools: Map<string, MtBotTool> = new Map();
  /** 用户手动禁用的工具名称集合（优先于工具自身 isEnabled） */
  private readonly userDisabled: Set<string> = new Set();

  /** 注册单个工具（重复 name 会覆盖） */
  register(tool: MtBotTool): void {
    this.tools.set(tool.name, tool);
  }

  /** 批量注册 */
  registerAll(tools: readonly MtBotTool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /** 按名称获取工具 */
  get(name: string): MtBotTool | undefined {
    return this.tools.get(name);
  }

  /** 获取当前启用的所有工具（过滤 isEnabled() 及用户禁用集合） */
  getEnabledTools(): MtBotTool[] {
    return [...this.tools.values()].filter((t) => !this.userDisabled.has(t.name) && t.isEnabled());
  }

  /** 按分类获取工具 */
  getByCategory(category: ToolCategory): MtBotTool[] {
    return [...this.tools.values()].filter((t) => t.category === category);
  }

  /** 获取所有已注册的工具 */
  getAll(): MtBotTool[] {
    return [...this.tools.values()];
  }

  /**
   * 获取所有工具的状态快照（含用户启用/禁用状态）
   *
   * 用于 UI 展示。
   */
  getToolStatus(): Array<{
    name: string;
    label: string;
    description: string;
    category: ToolCategory;
    isReadOnly: boolean;
    needsPermission: boolean;
    enabled: boolean;
  }> {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      label: t.label,
      description: t.description,
      category: t.category,
      isReadOnly: t.isReadOnly,
      needsPermission: t.needsPermission,
      enabled: !this.userDisabled.has(t.name) && t.isEnabled(),
    }));
  }

  /**
   * 用户手动启用工具
   *
   * 从用户禁用集合中移除，使工具恢复到其 isEnabled() 判断。
   */
  enableTool(name: string): boolean {
    if (!this.tools.has(name)) return false;
    this.userDisabled.delete(name);
    return true;
  }

  /**
   * 用户手动禁用工具
   *
   * 加入用户禁用集合，getEnabledTools() 将不再返回该工具。
   */
  disableTool(name: string): boolean {
    if (!this.tools.has(name)) return false;
    this.userDisabled.add(name);
    return true;
  }

  /** 工具是否被用户禁用 */
  isUserDisabled(name: string): boolean {
    return this.userDisabled.has(name);
  }

  /** 注销工具 */
  unregister(name: string): boolean {
    this.userDisabled.delete(name);
    return this.tools.delete(name);
  }

  /** 已注册工具数量 */
  get size(): number {
    return this.tools.size;
  }

  /** 转换为 pi-agent-core AgentTool[]（仅启用的工具） */
  toAgentTools(): AgentTool[] {
    return this.getEnabledTools();
  }

  /**
   * 将已启用工具包装为经过 ToolRunner 的 AgentTool[]
   *
   * @param runner 已注册 hooks 的执行器
   * @param executionContext 与 createMtBotTool 注入的上下文一致（供 hooks 读取）
   * @param lifecycle 仅在真实调用工具 execute 前后触发（缓存短路不触发）
   */
  toAgentToolsWithRunner(
    runner: ToolRunner,
    executionContext: ToolExecutionContext,
    lifecycle?: ToolRunLifecycle,
  ): AgentTool[] {
    return wrapMtBotToolsWithRunner(this.getEnabledTools(), runner, executionContext, lifecycle);
  }
}

/**
 * 从工具返回体提取可读错误信息。
 * pi-agent-core 仅在 execute 抛错时标记 isError；返回体带 isError:true 时需转为 throw。
 */
function toolResultErrorMessage(result: HookAgentToolResult): string {
  const block = result.content?.find((c) => c.type === "text");
  const text = block && "text" in block ? String(block.text) : "";
  if (!text) return "工具执行失败";
  try {
    const parsed = JSON.parse(text) as { message?: string };
    if (typeof parsed.message === "string" && parsed.message) return parsed.message;
  } catch {
    // 非 JSON，使用原文
  }
  return text;
}

/**
 * 将指定的 MtBotTool 列表包装为 AgentTool[]（每条 execute 走 ToolRunner）
 */
export function wrapMtBotToolsWithRunner(
  tools: readonly MtBotTool[],
  runner: ToolRunner,
  executionContext: ToolExecutionContext,
  lifecycle?: ToolRunLifecycle,
): AgentTool[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (toolCallId, params, signal?, onUpdate?) => {
      const result = await runner.run(
        tool,
        executionContext,
        toolCallId,
        params as Record<string, unknown>,
        signal,
        onUpdate,
        lifecycle,
      );
      // pi-agent-core 不读取 result.isError，必须通过 throw 才能让 UI/Agent 识别失败
      if ((result as { isError?: boolean }).isError) {
        throw new Error(toolResultErrorMessage(result));
      }
      return result;
    },
  }));
}
