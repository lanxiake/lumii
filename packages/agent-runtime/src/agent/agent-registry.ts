/**
 * AgentRegistry — 管理多个 AgentInstance
 *
 * 提供 Agent 实例的创建、查找、销毁等生命周期管理。
 * 支持父子实例关系与子实例级联销毁。
 */

import { AgentInstance, type AgentInstanceConfig } from "./agent-instance.js";

/** create() 可携带父实例 ID（spawn_agent 等场景） */
export type AgentRegistryCreateConfig = AgentInstanceConfig & {
  readonly parentInstanceId?: string;
};

export class AgentRegistry {
  private readonly instances = new Map<string, AgentInstance>();
  /** 子实例 → 父实例 */
  private readonly parentOf = new Map<string, string>();
  /** 父实例 → 子实例集合 */
  private readonly childrenOf = new Map<string, Set<string>>();

  /** 创建并注册 Agent 实例 */
  create(config: AgentRegistryCreateConfig): AgentInstance {
    if (this.instances.has(config.id)) {
      throw new Error(`AgentInstance with id "${config.id}" already exists`);
    }
    const instance = new AgentInstance(config);
    this.instances.set(config.id, instance);

    const parentId = config.parentInstanceId;
    if (parentId) {
      this.parentOf.set(config.id, parentId);
      let set = this.childrenOf.get(parentId);
      if (!set) {
        set = new Set();
        this.childrenOf.set(parentId, set);
      }
      set.add(config.id);
    }

    return instance;
  }

  /** 按 ID 获取实例 */
  get(id: string): AgentInstance | undefined {
    return this.instances.get(id);
  }

  /** 获取父实例 ID（若有） */
  getParentId(childId: string): string | undefined {
    return this.parentOf.get(childId);
  }

  /** 获取所有实例 */
  getAll(): AgentInstance[] {
    return [...this.instances.values()];
  }

  /** 获取指定定义 ID 的所有实例 */
  getByDefinitionId(definitionId: string): AgentInstance[] {
    return [...this.instances.values()].filter((i) => i.definitionId === definitionId);
  }

  /**
   * 销毁实例
   *
   * @param cascadeChildren 为 true（默认）时先递归销毁子实例
   */
  destroy(id: string, options?: { cascadeChildren?: boolean }): boolean {
    const cascade = options?.cascadeChildren !== false;

    if (cascade) {
      const children = this.childrenOf.get(id);
      if (children) {
        for (const childId of [...children]) {
          this.destroy(childId, { cascadeChildren: true });
        }
      }
    }

    const instance = this.instances.get(id);
    if (!instance) return false;
    instance.destroy();
    this.instances.delete(id);

    const parentId = this.parentOf.get(id);
    if (parentId) {
      const set = this.childrenOf.get(parentId);
      set?.delete(id);
      if (set && set.size === 0) {
        this.childrenOf.delete(parentId);
      }
    }
    this.parentOf.delete(id);
    this.childrenOf.delete(id);
    return true;
  }

  /** 销毁所有实例 */
  destroyAll(): void {
    for (const instance of this.instances.values()) {
      instance.destroy();
    }
    this.instances.clear();
    this.parentOf.clear();
    this.childrenOf.clear();
  }

  /** 获取直接子实例 ID 列表 */
  getChildrenOf(parentId: string): string[] {
    const children = this.childrenOf.get(parentId);
    return children ? [...children] : [];
  }

  /** 已注册实例数量 */
  get size(): number {
    return this.instances.size;
  }
}
