/**
 * SQLite Schema — DDL 常量
 *
 * 定义客户端本地存储的 8 张表。
 * 使用 node:sqlite 的 DatabaseSync 执行。
 */

/** 当前 schema 版本号 */
export const SCHEMA_VERSION = 9;

/**
 * V1 DDL — 初始 schema
 *
 * 包含 8 张表：
 * - conversations: 对话元数据
 * - conversation_participants: 对话参与者
 * - messages: 完整聊天记录
 * - agent_memories: Agent 记忆
 * - agent_definition_cache: Agent 定义缓存
 * - tasks: 任务列表
 * - tool_audit_log: 工具审计日志
 * - runtime_state: 运行时 KV 状态
 */
export const SCHEMA_V1 = `
-- conversations — 对话元数据
CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  type            TEXT NOT NULL DEFAULT 'direct'
    CHECK (type IN ('direct', 'group', 'broadcast')),
  title           TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  last_msg_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_conversations_user_active
  ON conversations (user_id, is_active, last_msg_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_last_msg
  ON conversations (last_msg_at DESC);

-- conversation_participants — 对话参与者
CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  participant_type TEXT NOT NULL CHECK (participant_type IN ('user', 'agent')),
  participant_id   TEXT NOT NULL,
  joined_at        TEXT NOT NULL,
  PRIMARY KEY (conversation_id, participant_type, participant_id)
);

CREATE INDEX IF NOT EXISTS idx_participants_agent
  ON conversation_participants (participant_id, participant_type)
  WHERE participant_type = 'agent';

-- messages — 完整聊天记录
CREATE TABLE IF NOT EXISTS messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id         TEXT,
  role             TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content_json     TEXT NOT NULL,
  is_proactive     INTEGER NOT NULL DEFAULT 0,
  timestamp        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_ts
  ON messages (conversation_id, timestamp ASC);

CREATE INDEX IF NOT EXISTS idx_messages_agent
  ON messages (agent_id, timestamp DESC)
  WHERE agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_role
  ON messages (conversation_id, role)
  WHERE role = 'assistant';

-- agent_memories — Agent 记忆
CREATE TABLE IF NOT EXISTS agent_memories (
  id                TEXT PRIMARY KEY,
  agent_id          TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  category          TEXT NOT NULL DEFAULT 'general'
    CHECK (category IN ('user', 'feedback', 'project', 'reference', 'general')),
  content           TEXT NOT NULL,
  importance        REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0.0 AND importance <= 1.0),
  tags              TEXT,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  last_used         TEXT NOT NULL,
  use_count         INTEGER NOT NULL DEFAULT 0,
  is_archived       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_memories_agent_user_active
  ON agent_memories (agent_id, user_id, is_archived, importance DESC);

CREATE INDEX IF NOT EXISTS idx_memories_category
  ON agent_memories (agent_id, user_id, category)
  WHERE is_archived = 0;

CREATE INDEX IF NOT EXISTS idx_memories_last_used
  ON agent_memories (agent_id, user_id, last_used ASC)
  WHERE is_archived = 0;

CREATE INDEX IF NOT EXISTS idx_memories_importance_desc
  ON agent_memories (agent_id, user_id, importance DESC)
  WHERE is_archived = 0;

-- agent_definition_cache — Agent 定义缓存
CREATE TABLE IF NOT EXISTS agent_definition_cache (
  agent_id    TEXT PRIMARY KEY,
  version     INTEGER NOT NULL,
  definition  TEXT NOT NULL,
  synced_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_cache_synced
  ON agent_definition_cache (synced_at DESC);

-- tasks — 任务列表
CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  subject          TEXT NOT NULL,
  description      TEXT,
  status           TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'blocked', 'done', 'cancelled')),
  owner            TEXT,
  blocked_by       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_conversation
  ON tasks (conversation_id, status);

CREATE INDEX IF NOT EXISTS idx_tasks_owner_status
  ON tasks (owner, status)
  WHERE status NOT IN ('done', 'cancelled');

-- tool_audit_log — 工具审计日志
CREATE TABLE IF NOT EXISTS tool_audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id        TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  args_hash       TEXT,
  result_summary  TEXT,
  is_error        INTEGER NOT NULL DEFAULT 0,
  duration_ms     INTEGER,
  timestamp       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_agent_ts
  ON tool_audit_log (agent_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_audit_tool
  ON tool_audit_log (tool_name, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_audit_errors
  ON tool_audit_log (agent_id, is_error)
  WHERE is_error = 1;

-- runtime_state — 运行时 KV 状态
CREATE TABLE IF NOT EXISTS runtime_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
`;

/**
 * 所有 migration — 按版本号排列
 *
 * 每个 migration 是一个 [version, sql] 元组。
 * LocalDatabase 会按序执行所有 version > currentVersion 的 migration。
 */
export const MIGRATIONS: ReadonlyArray<readonly [number, string]> = [
  [1, SCHEMA_V1],
  // V2: 助手流式行（delta 写库）标记，重启后过滤未完成行
  [
    2,
    `
ALTER TABLE messages ADD COLUMN is_streaming INTEGER NOT NULL DEFAULT 0;
`,
  ],
  // V3: 本地定时任务表（不依赖 Gateway WebSocket）
  [
    3,
    `
CREATE TABLE IF NOT EXISTS local_cron_jobs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  task_text   TEXT NOT NULL,
  agent_id    TEXT,
  schedule_type TEXT NOT NULL CHECK (schedule_type IN ('at', 'every', 'cron')),
  schedule_expr TEXT NOT NULL,
  next_run_at INTEGER NOT NULL,
  interval_ms INTEGER,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
`,
  ],
  // V4: 本地定时任务执行历史
  [
    4,
    `
CREATE TABLE IF NOT EXISTS local_cron_runs (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER NOT NULL,
  duration_ms   INTEGER NOT NULL,
  summary       TEXT,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_local_cron_runs_job_started
  ON local_cron_runs (job_id, started_at DESC);
`,
  ],
  // V5: 本地定时任务执行状态字段
  [
    5,
    `
ALTER TABLE local_cron_jobs ADD COLUMN last_run_at INTEGER;
ALTER TABLE local_cron_jobs ADD COLUMN last_status TEXT CHECK (last_status IN ('ok', 'error', 'running'));
`,
  ],
  // V6: 客户端本地文件管理表（Windows 客户端 Agent 生成文件 + 跨通道文件）
  [
    6,
    `
CREATE TABLE IF NOT EXISTS client_files (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  agent_id         TEXT,
  conversation_id  TEXT,
  message_id       TEXT,
  channel          TEXT NOT NULL DEFAULT 'windows',
  source_type      TEXT NOT NULL CHECK (source_type IN ('agent_output', 'channel_upload', 'user_upload')),
  file_name        TEXT NOT NULL,
  file_size        INTEGER,
  mime_type        TEXT,
  local_path       TEXT NOT NULL,
  category         TEXT NOT NULL DEFAULT 'output' CHECK (category IN ('upload', 'output')),
  metadata         TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at       TEXT,
  UNIQUE (conversation_id, local_path)
);

CREATE INDEX IF NOT EXISTS idx_client_files_user_agent
  ON client_files (user_id, agent_id);

CREATE INDEX IF NOT EXISTS idx_client_files_conversation
  ON client_files (conversation_id, deleted_at);

CREATE INDEX IF NOT EXISTS idx_client_files_channel
  ON client_files (channel);

CREATE INDEX IF NOT EXISTS idx_client_files_search
  ON client_files (user_id, created_at DESC);
`,
  ],
  // V7: 会话置顶标志
  [
    7,
    `
ALTER TABLE conversations ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_conversations_pinned
  ON conversations (user_id, is_pinned DESC, last_msg_at DESC);
`,
  ],
  // V8: 记忆分段表（段落总结提取，记忆系统升级阶段①）
  [
    8,
    `
CREATE TABLE IF NOT EXISTS memory_segments (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  agent_id          TEXT NOT NULL,
  start_message_id  TEXT NOT NULL,
  end_message_id    TEXT,
  status            TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closed', 'summarised')),
  turn_count        INTEGER NOT NULL DEFAULT 0,
  char_count        INTEGER NOT NULL DEFAULT 0,
  topic_tokens      TEXT,
  close_reason      TEXT,
  retry_count       INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  closed_at         TEXT,
  summarised_at     TEXT
);

-- 同一会话至多一个 open 段：observe 查询 open 段
CREATE INDEX IF NOT EXISTS idx_segments_conv_status
  ON memory_segments (conversation_id, status);

-- worker 重启恢复：扫描所有 closed 段续总结
CREATE INDEX IF NOT EXISTS idx_segments_closed
  ON memory_segments (status, created_at ASC)
  WHERE status = 'closed';

-- 多用户隔离查询
CREATE INDEX IF NOT EXISTS idx_segments_user_agent
  ON memory_segments (user_id, agent_id);
`,
  ],
  // V9: 记忆来源关联（原文回溯 + 宫殿互引，记忆系统升级阶段一 · 诉求 A）
  // - source_segment_id：记忆的来源段锚点（段已存 start/end_message_id，可 loadSegmentText 回读区间）
  // - palace_drawer_id（agent_memories）：该记忆对应的宫殿语义片段（内容寻址 ID）
  // - palace_drawer_id（memory_segments）：该段原文在宫殿中的归档位置（内容寻址 ID）
  [
    9,
    `
ALTER TABLE agent_memories ADD COLUMN source_segment_id TEXT;
ALTER TABLE agent_memories ADD COLUMN palace_drawer_id TEXT;

CREATE INDEX IF NOT EXISTS idx_memories_source_segment
  ON agent_memories (source_segment_id)
  WHERE source_segment_id IS NOT NULL;

ALTER TABLE memory_segments ADD COLUMN palace_drawer_id TEXT;
`,
  ],
] as const;
