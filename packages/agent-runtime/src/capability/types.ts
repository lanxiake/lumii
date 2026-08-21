/**
 * CapabilityRegistry 类型定义
 *
 * 统一描述 Tool、Skill、MCP 能力的元数据，供权限过滤和发现使用。
 * 执行逻辑继续委托现有 tool-runner / skill / MCP 代码，不在此层实现。
 */

import type { AgentTurnOrigin } from "../kernel/agent-turn-types.js";

/** 能力来源类型 */
export type CapabilitySource = "tool" | "skill" | "mcp" | "channel";

/**
 * 能力所需的权限级别
 *
 * 用于 origin 过滤：cloud_channel 默认不授予 shell/admin 权限。
 */
export type CapabilityPermission = "read" | "write" | "execute" | "network" | "shell" | "admin";

/** 能力统一描述符 */
export interface CapabilityDescriptor {
  /** 唯一标识（与工具名/技能ID一致） */
  readonly id: string;
  /** 能力来源 */
  readonly source: CapabilitySource;
  /** 显示名称 */
  readonly name: string;
  /** 功能描述 */
  readonly description: string;
  /** 所需权限列表 */
  readonly permissions: readonly CapabilityPermission[];
  /**
   * 允许访问此能力的 origin 白名单
   * 未设置时视为"全部 origin 均可访问"（再由 permission 二次过滤）
   */
  readonly allowedOrigins?: readonly AgentTurnOrigin[];
  /**
   * 是否为高风险能力
   * 高风险能力对 cloud_channel origin 默认拒绝，需显式列入 allowedOrigins
   */
  readonly isHighRisk?: boolean;
}

/** 执行时传入 Registry 的上下文（供未来执行后端对接，当前仅做类型预留） */
export interface CapabilityExecutionContext {
  /** turn 来源 */
  origin: AgentTurnOrigin;
  /** Agent 实例 ID */
  instanceId?: string;
  /** 用户 ID */
  userId?: string;
}
