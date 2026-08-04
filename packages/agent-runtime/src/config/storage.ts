/**
 * 本地 SQLite 存储相关常量（容量、保留策略等）
 *
 * 与 M05 实施计划中的 STORAGE_CONFIG 对齐，供后续自动清理 / VACUUM 使用。
 */

/** 单会话消息数上限（归档/清理策略预留） */
export const MAX_MESSAGES_PER_CONVERSATION = 10_000;

/** 单 Agent 活跃记忆条数上限（与 M06 协调） */
export const MAX_ACTIVE_MEMORIES = 1000;

/** 超过该文件大小时尝试执行 VACUUM 压缩（字节） */
export const AUTO_VACUUM_THRESHOLD_BYTES = 100 * 1024 * 1024;

/** 消息默认保留天数（与产品设置联动前占位） */
export const DEFAULT_RETENTION_DAYS = 365;
