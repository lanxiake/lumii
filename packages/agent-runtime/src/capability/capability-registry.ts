/**
 * CapabilityRegistry — 统一能力注册、查询与权限过滤
 *
 * 职责：
 * - 注册/注销 CapabilityDescriptor
 * - 按 AgentTurnOrigin 过滤（cloud_channel 默认最小权限）
 * - 按 CapabilityPermission 过滤
 * - 按 source 枚举
 *
 * 执行后端（tool-runner / skill / MCP）保持现状，不在此层修改。
 */

import type { AgentTurnOrigin } from "@mtbot/protocol";
import type { CapabilityDescriptor, CapabilityPermission, CapabilitySource } from "./types.js";

/** cloud_channel 默认被拒绝的高风险权限 */
const CLOUD_CHANNEL_DENIED_PERMISSIONS: ReadonlySet<CapabilityPermission> = new Set([
  "shell",
  "admin",
]);

export class CapabilityRegistry {
  private readonly capabilities = new Map<string, CapabilityDescriptor>();

  /** 注册单个能力（重复 id 会覆盖） */
  register(descriptor: CapabilityDescriptor): void {
    this.capabilities.set(descriptor.id, descriptor);
  }

  /** 批量注册 */
  registerAll(descriptors: readonly CapabilityDescriptor[]): void {
    for (const d of descriptors) {
      this.register(d);
    }
  }

  /** 注销 */
  unregister(id: string): boolean {
    return this.capabilities.delete(id);
  }

  /** 按 id 获取 */
  get(id: string): CapabilityDescriptor | undefined {
    return this.capabilities.get(id);
  }

  /** 获取全部已注册能力 */
  getAll(): CapabilityDescriptor[] {
    return [...this.capabilities.values()];
  }

  /** 按来源类型过滤 */
  getBySource(source: CapabilitySource): CapabilityDescriptor[] {
    return [...this.capabilities.values()].filter((c) => c.source === source);
  }

  /**
   * 按 origin 过滤可访问的能力
   *
   * 规则（优先级从高到低）：
   * 1. 若 descriptor.allowedOrigins 已设置，origin 必须在其中
   * 2. 若 isHighRisk=true 且 origin=cloud_channel，拒绝
   * 3. 若 origin=cloud_channel 且 permissions 包含 shell/admin，拒绝
   * 4. 否则允许
   */
  getForOrigin(origin: AgentTurnOrigin): CapabilityDescriptor[] {
    return [...this.capabilities.values()].filter((c) => this.isAllowedForOrigin(c, origin));
  }

  /**
   * 按 origin + 所需权限列表过滤
   *
   * 返回的能力必须同时满足 origin 规则且声明了所有请求的权限。
   */
  getForOriginWithPermissions(
    origin: AgentTurnOrigin,
    requiredPermissions: readonly CapabilityPermission[],
  ): CapabilityDescriptor[] {
    return this.getForOrigin(origin).filter((c) =>
      requiredPermissions.every((p) => c.permissions.includes(p)),
    );
  }

  /** 已注册能力数量 */
  get size(): number {
    return this.capabilities.size;
  }

  private isAllowedForOrigin(c: CapabilityDescriptor, origin: AgentTurnOrigin): boolean {
    // 显式白名单：origin 必须在其中
    if (c.allowedOrigins && c.allowedOrigins.length > 0) {
      return c.allowedOrigins.includes(origin);
    }

    if (origin === "cloud_channel") {
      // 高风险能力对 cloud_channel 默认拒绝
      if (c.isHighRisk) return false;
      // shell/admin 权限对 cloud_channel 默认拒绝
      if (c.permissions.some((p) => CLOUD_CHANNEL_DENIED_PERMISSIONS.has(p))) return false;
    }

    return true;
  }
}
