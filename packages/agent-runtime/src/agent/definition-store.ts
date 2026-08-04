/**
 * AgentDefinitionStore — 内存 + SQLite 缓存 + API 同步
 *
 * 架构说明（v13 重构后）：
 *   内存缓存 → SQLite 缓存 → API（api-server）
 *
 * 关键约束：
 * - 内置 Agent（含 Explore / Plan / Verify 等新增子 Agent）的**权威数据源**是
 *   api-server 的 PostgreSQL `system_agents` 表，由
 *   `src/db/seed/system-agents.ts::seedSystemAgentsWithDb` 在服务端 seed。
 * - 客户端（Windows/桌面端）只做**缓存与离线 fallback**，不再在本地 SQLite 做种子写入。
 * - 当 api-server 不可达时，`findBuiltInAgent` 的硬编码镜像仅作为"最小可用兜底"
 *   （避免用户在首次冷启动或网络异常时完全选不到任何 Agent）。
 *
 * 加载顺序：
 *   1. 内存缓存（已同步过的定义）
 *   2. SQLite 缓存（上一次 API/兜底同步的镜像）
 *   3. API 远程（GET /api/agents/:id）
 *   4. 内置兜底常量（仅 id 匹配 findBuiltInAgent 时，供完全离线场景）
 *
 * 设计依据:
 * - .qoder/plan/client-agent-runtime/2026-04-18-技能触发-预制子Agent-协调层-询问工具-实施计划.md (Phase 3)
 * - claude-code-rev src/tools/AgentTool/builtInAgents.ts
 */

import type { DatabaseAdapter } from "../storage/local-database.js";
import type { AgentDefinition } from "../types/agent-definition.js";
import { findBuiltInAgent } from "./builtin/definitions.js";
import { mapApiRecordToAgentDefinition } from "./api-agent-mapper.js";

/** 与 UI / IPC 对齐的同步状态快照 */
export interface DefinitionSyncStatus {
  /** 最近一次成功同步完成时间 */
  lastSyncAt: Date | null;
  /** 是否正在同步 */
  isSyncing: boolean;
  /** 最近一次同步错误信息 */
  lastError: string | null;
  /** 最近一次同步结果统计 */
  lastResult: { synced: number; failed: number } | null;
}

export interface AgentDefinitionStoreOptions {
  /** 已打开的 SQLite 适配器 */
  readonly db: DatabaseAdapter;
  /**
   * 按 ID 从远程拉取定义（通常 GET /api/agents/:id）
   * 未配置时仅使用内置与本地缓存
   */
  readonly fetchById?: (id: string) => Promise<AgentDefinition | undefined>;
  /**
   * 列出可缓存的全部 Agent（通常 GET /api/agents）
   * 用于 syncUserAgents
   */
  readonly fetchAll?: () => Promise<readonly AgentDefinition[]>;
}

/**
 * 统一解析 Agent 定义：内存、SQLite、API、离线兜底
 */
export class AgentDefinitionStore {
  private readonly db: DatabaseAdapter;
  private readonly fetchById?: (id: string) => Promise<AgentDefinition | undefined>;
  private readonly fetchAll?: () => Promise<readonly AgentDefinition[]>;

  private readonly memory = new Map<string, AgentDefinition>();

  private lastSyncAt: Date | null = null;
  private isSyncing = false;
  private lastError: string | null = null;
  private lastResult: { synced: number; failed: number } | null = null;

  constructor(options: AgentDefinitionStoreOptions) {
    this.db = options.db;
    this.fetchById = options.fetchById;
    this.fetchAll = options.fetchAll;
  }

  /**
   * 按 ID 获取 AgentDefinition
   *
   * 优先级: 内存缓存 → SQLite 缓存 → API 远程 → 内置离线兜底
   */
  async get(id: string): Promise<AgentDefinition | undefined> {
    // 1. 内存缓存（已包含从 DB / API 同步过来的完整定义）
    const mem = this.memory.get(id);
    if (mem) return mem;

    // 2. SQLite 缓存
    const cached = this.loadFromDb(id);
    if (cached) {
      this.memory.set(id, cached);
      return cached;
    }

    // 3. API 远程拉取
    if (this.fetchById) {
      try {
        const remote = await this.fetchById(id);
        if (remote) {
          this.upsertMemoryAndDb(remote);
          return remote;
        }
      } catch {
        // 远程失败时回落到离线兜底，避免完全不可用
      }
    }

    // 4. 内置离线兜底（仅匹配 id）
    const fallback = findBuiltInAgent(id);
    if (fallback) {
      this.memory.set(id, fallback);
      return fallback;
    }

    return undefined;
  }

  /**
   * 将 API 返回的原始记录写入缓存（供主进程批量同步时调用）
   */
  upsertFromApiRecord(raw: Record<string, unknown>): void {
    const def = mapApiRecordToAgentDefinition(raw);
    this.upsertMemoryAndDb(def);
  }

  /**
   * 全量同步：拉取列表并写入 SQLite + 内存
   */
  async syncUserAgents(): Promise<{ synced: number; failed: number }> {
    if (!this.fetchAll) {
      return { synced: 0, failed: 0 };
    }

    this.isSyncing = true;
    this.lastError = null;

    try {
      const list = await this.fetchAll();
      let synced = 0;
      let failed = 0;
      for (const def of list) {
        try {
          this.upsertMemoryAndDb(def);
          synced++;
        } catch {
          failed++;
        }
      }
      this.lastError = null;
      this.lastSyncAt = new Date();
      this.lastResult = { synced, failed };
      return { synced, failed };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      this.lastResult = { synced: 0, failed: 0 };
      throw err;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 当前同步状态（供 IPC / UI）
   */
  getSyncStatus(): DefinitionSyncStatus {
    return {
      lastSyncAt: this.lastSyncAt,
      isSyncing: this.isSyncing,
      lastError: this.lastError,
      lastResult: this.lastResult,
    };
  }

  /**
   * 列出 SQLite 中缓存的条目（不含仅内存命中）
   */
  listCachedRows(): Array<{
    agentId: string;
    version: number;
    syncedAt: string;
    name: string;
    sourceType: string;
    definitionBytes: number;
  }> {
    const rows = this.db
      .prepare<{
        agent_id: string;
        version: number;
        definition: string;
        synced_at: string;
      }>(
        "SELECT agent_id, version, definition, synced_at FROM agent_definition_cache ORDER BY synced_at DESC",
      )
      .all();

    return rows.map((r) => {
      let name = r.agent_id;
      let sourceType = "unknown";
      try {
        const parsed = JSON.parse(r.definition) as AgentDefinition;
        name = parsed.name || name;
        sourceType = parsed.sourceType || sourceType;
      } catch {
        /* 保持默认 */
      }
      return {
        agentId: r.agent_id,
        version: r.version,
        syncedAt: r.synced_at,
        name,
        sourceType,
        definitionBytes: r.definition.length,
      };
    });
  }

  /**
   * 删除单个缓存
   */
  removeCached(agentId: string): boolean {
    const n = this.db
      .prepare("DELETE FROM agent_definition_cache WHERE agent_id = ?")
      .run(agentId).changes;
    this.memory.delete(agentId);
    return n > 0;
  }

  /**
   * 删除 synced_at 早于 cutoff 的缓存行
   */
  removeOlderThan(cutoffIso: string): number {
    const stmt = this.db.prepare<{ agent_id: string }>(
      "SELECT agent_id FROM agent_definition_cache WHERE synced_at < ?",
    );
    const rows = stmt.all(cutoffIso);
    let removed = 0;
    for (const row of rows) {
      if (this.removeCached(row.agent_id)) removed++;
    }
    return removed;
  }

  /**
   * 清空缓存表
   */
  clearAllCached(): void {
    this.db.exec("DELETE FROM agent_definition_cache");
    this.memory.clear();
  }

  /**
   * 按 ID 从远程刷新并写入缓存
   *
   * 回退顺序：远程 → 内置离线兜底（避免 API 不可用时彻底查不到内置 Agent）
   */
  async refreshOne(agentId: string): Promise<AgentDefinition | undefined> {
    if (this.fetchById) {
      try {
        const def = await this.fetchById(agentId);
        if (def) {
          this.upsertMemoryAndDb(def);
          return def;
        }
      } catch {
        /* fallthrough → 离线兜底 */
      }
    }
    return findBuiltInAgent(agentId);
  }

  // --- 内部 ---

  private loadFromDb(id: string): AgentDefinition | undefined {
    const row = this.db
      .prepare<{ definition: string }>(
        "SELECT definition FROM agent_definition_cache WHERE agent_id = ?",
      )
      .get(id);
    if (!row) return undefined;
    try {
      return JSON.parse(row.definition) as AgentDefinition;
    } catch {
      return undefined;
    }
  }

  private upsertMemoryAndDb(def: AgentDefinition): void {
    this.memory.set(def.id, def);
    const version = def.version ?? 1;
    const syncedAt = new Date().toISOString();
    const json = JSON.stringify(def);
    this.db
      .prepare(
        "INSERT OR REPLACE INTO agent_definition_cache (agent_id, version, definition, synced_at) VALUES (?, ?, ?, ?)",
      )
      .run(def.id, version, json, syncedAt);
  }
}
