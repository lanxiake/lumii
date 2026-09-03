/**
 * 会话级配置：类型、读写与合并规则
 *
 * 设置页里的配置是**全局默认值**，本模块存的是**会话覆盖值**。
 * 合并语义统一为「全局启用 且 会话未禁用 = 生效」——只用禁用集表达覆盖，
 * 不用启用集，这样新增的 server/技能默认可用，无需回填每个历史会话。
 *
 * 全局关闭的项，会话级无法单独开启（UI 应置灰并提示已被全局关闭）。
 */

import type { DatabaseAdapter } from "./local-database.js";

/** 会话级配置（存 conversations.session_config，JSON 序列化） */
export interface SessionConfig {
  /** 该会话使用的模型（原始 ref 字符串，与 UI 模型选择同步） */
  readonly preferredModel?: string;
  /** 会话级禁用的 MCP server 名 */
  readonly disabledMcpServers?: readonly string[];
  /** 会话级禁用的技能 id */
  readonly disabledSkills?: readonly string[];
  /** 会话级禁用的工具名 */
  readonly disabledTools?: readonly string[];
  /** 压缩参数覆盖（未设则用全局常量） */
  readonly compaction?: {
    readonly triggerRatio?: number;
    readonly keepRecentTurns?: number;
  };
}

const EMPTY: SessionConfig = {};

/**
 * 判断某项在该会话是否生效。
 *
 * @param globallyEnabled 全局总开关状态
 * @param disabledInSession 会话禁用集
 * @param name 待判定的 server/技能/工具名
 */
export function isEnabledForSession(
  globallyEnabled: boolean,
  disabledInSession: readonly string[] | undefined,
  name: string,
): boolean {
  if (!globallyEnabled) return false;
  return !disabledInSession?.includes(name);
}

/**
 * 按会话禁用集过滤条目。
 *
 * @param items 全局已启用的条目
 * @param disabledInSession 会话禁用集
 * @param nameOf 从条目取名字
 */
export function filterEnabledForSession<T>(
  items: readonly T[],
  disabledInSession: readonly string[] | undefined,
  nameOf: (item: T) => string,
): T[] {
  if (!disabledInSession?.length) return [...items];
  const disabled = new Set(disabledInSession);
  return items.filter((item) => !disabled.has(nameOf(item)));
}

/** 读会话配置；无记录或 JSON 损坏时返回空配置（不抛错，配置缺失不该阻断会话） */
export function readSessionConfig(db: DatabaseAdapter, conversationId: string): SessionConfig {
  const row = db
    .prepare<{ session_config: string | null }>(
      "SELECT session_config FROM conversations WHERE id = ?",
    )
    .get(conversationId);
  if (!row?.session_config) return EMPTY;
  try {
    const parsed = JSON.parse(row.session_config) as unknown;
    if (!parsed || typeof parsed !== "object") return EMPTY;
    return parsed as SessionConfig;
  } catch {
    return EMPTY;
  }
}

/** 局部更新会话配置（读改写；patch 里显式 undefined 的键会删除该项） */
export function patchSessionConfig(
  db: DatabaseAdapter,
  conversationId: string,
  patch: Partial<SessionConfig>,
): SessionConfig {
  const current = readSessionConfig(db, conversationId);
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  db.prepare("UPDATE conversations SET session_config = ? WHERE id = ?").run(
    JSON.stringify(next),
    conversationId,
  );
  return next as SessionConfig;
}

/**
 * 删除已不在当前 chat provider 可用列表中的会话模型覆盖。
 *
 * 仅移除 preferredModel，保留会话内的工具、技能和压缩设置。
 */
export function clearInvalidSessionPreferredModels(
  db: DatabaseAdapter,
  availableModelIds: readonly string[],
): number {
  const available = new Set(
    availableModelIds.map((modelId) => modelId.trim()).filter(Boolean),
  );
  const rows = db
    .prepare<{ id: string }>(
      "SELECT id FROM conversations WHERE session_config IS NOT NULL AND session_config != ''",
    )
    .all();
  let cleared = 0;

  for (const row of rows) {
    const preferredModel = readSessionConfig(db, row.id).preferredModel?.trim();
    if (!preferredModel || available.has(preferredModel)) continue;
    patchSessionConfig(db, row.id, { preferredModel: undefined });
    cleared += 1;
  }

  return cleared;
}

/** 切换某项的会话级禁用状态，返回更新后的禁用集 */
export function toggleSessionDisabled(
  db: DatabaseAdapter,
  conversationId: string,
  field: "disabledMcpServers" | "disabledSkills" | "disabledTools",
  name: string,
  disabled: boolean,
): readonly string[] {
  const current = readSessionConfig(db, conversationId);
  const set = new Set(current[field] ?? []);
  if (disabled) set.add(name);
  else set.delete(name);
  const nextList = [...set];
  patchSessionConfig(db, conversationId, { [field]: nextList });
  return nextList;
}
