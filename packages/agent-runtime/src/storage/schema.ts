/**
 * SQLite Schema — DDL 常量
 *
 * 定义客户端本地存储的 8 张表。
 * 使用 node:sqlite 的 DatabaseSync 执行。
 */

/** 当前 schema 版本号 */
export const SCHEMA_VERSION = 15;

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

-- conversation_participants — 对话参与者
CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  participant_type TEXT NOT NULL CHECK (participant_type IN ('user', 'agent')),
  participant_id   TEXT NOT NULL,
  joined_at        TEXT NOT NULL,
  PRIMARY KEY (conversation_id, participant_type, participant_id)
);

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

CREATE INDEX IF NOT EXISTS idx_audit_ts
  ON tool_audit_log (timestamp DESC);

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
  // V10: 清理无查询命中的索引
  //
  // 这些索引的列组合没有任何 SQL 会用到（已逐条 grep 全仓确认），
  // 只增加写入成本。表结构与数据不变。
  // - idx_messages_agent：无按 messages.agent_id 过滤的查询
  // - idx_participants_agent：参与者查询一律按 conversation_id 过滤
  // - idx_segments_user_agent：无按 user_id/agent_id 查段的语句
  // - idx_conversations_last_msg：无全局按 last_msg_at 排序的查询
  // - idx_tasks_owner_status / idx_audit_tool / idx_audit_errors：对应 repo 方法已删除
  // - idx_memories_importance_desc：与 idx_memories_agent_user_active 前缀重复
  // - idx_client_files_channel：channel 只作为 user_id 之后的可选过滤，单列索引选不中
  //
  // idx_audit_ts 替代 idx_audit_agent_ts：审计只有 listRecentGlobally 一个读取入口，
  // 按 timestamp DESC 排序，agent_id 前缀反而让索引失效。
  [
    10,
    `
DROP INDEX IF EXISTS idx_messages_agent;
DROP INDEX IF EXISTS idx_participants_agent;
DROP INDEX IF EXISTS idx_segments_user_agent;
DROP INDEX IF EXISTS idx_conversations_last_msg;
DROP INDEX IF EXISTS idx_tasks_owner_status;
DROP INDEX IF EXISTS idx_audit_tool;
DROP INDEX IF EXISTS idx_audit_errors;
DROP INDEX IF EXISTS idx_audit_agent_ts;
DROP INDEX IF EXISTS idx_memories_importance_desc;
DROP INDEX IF EXISTS idx_client_files_channel;

CREATE INDEX IF NOT EXISTS idx_audit_ts
  ON tool_audit_log (timestamp DESC);
`,
  ],
  // V11: 定时任务的生效窗口、系统提示词与通知渠道
  //
  // - active_days：生效星期，"0,1,...,6"（0=周日，与 Date#getDay 对齐）；NULL 表示每天
  // - active_hour_start / active_hour_end：生效时段的起止小时 [start, end)，NULL 表示全天
  //   「按间隔」类型靠 setInterval 触发，无法用 cron 表达式限定星期与时段，
  //   故存成独立列，在 runLocalCronJob 入口做运行时过滤。
  // - system_prompt：预置任务的完整系统提示词；用户自建任务留空
  // - notify_targets：执行结果的推送目标，逗号分隔（system/news/focus/feishu）
  [
    11,
    `
ALTER TABLE local_cron_jobs ADD COLUMN active_days TEXT;
ALTER TABLE local_cron_jobs ADD COLUMN active_hour_start INTEGER;
ALTER TABLE local_cron_jobs ADD COLUMN active_hour_end INTEGER;
ALTER TABLE local_cron_jobs ADD COLUMN system_prompt TEXT;
ALTER TABLE local_cron_jobs ADD COLUMN notify_targets TEXT;
`,
  ],
  // V12: 上下文压缩由「物理删除」改为「标记排除」
  //
  // compacted_at 非空表示该消息已被上下文压缩排除出 LLM 请求，但仍是用户可回看的历史记录。
  // 读取分两条路径：
  // - 喂给模型（loadMessagesAsPiFormat）过滤 compacted_at IS NULL
  // - 展示给用户（loadMessagesPage）不过滤，靠 UI 懒加载分页控制量级
  // 配套的部分索引让「只取未压缩消息」这条热路径仍能走索引扫描。
  [
    12,
    `
ALTER TABLE messages ADD COLUMN compacted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_conv_active_ts
  ON messages (conversation_id, timestamp ASC)
  WHERE compacted_at IS NULL;
`,
  ],
  // V13: 工具累计使用统计（替代原 JSON 文件 tool-usage.json，避免升级/重启/迁移丢失）
  //
  // 工具名做主键，含累计调用次数、失败次数、最后使用时间戳（epoch ms）。
  // 启动时读入内存 Map，debounce 2s UPSERT，退出前强制 flush。
  [
    13,
    `
CREATE TABLE IF NOT EXISTS tool_usage_stats (
  tool_name    TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  error_count  INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER   -- epoch ms，NULL 表示未用过
);
`,
  ],
  // V14: 会话级配置载体
  //
  // 单一 JSON 列承载全部会话级设置：模型偏好、思考模式、MCP/技能/工具禁用集、压缩参数。
  // 设置页的配置是全局默认值，这里存的是该会话的覆盖值（详见 session-config.ts 的合并规则）。
  // 用 JSON 而非独立列：字段会持续增加，避免每加一项就一次迁移。
  [
    14,
    `
ALTER TABLE conversations ADD COLUMN session_config TEXT;
`,
  ],
  // V15: agent_memories 的 FTS5 派生全文索引（P0 记忆重构）
  //
  // 实测（node:sqlite 3.53.3）证明 FTS5 内置分词器都不支持中文 2 字关键词搜索：
  // unicode61 把连续中文整段当一个 token（"用户喜欢爬山"查"爬山"零命中）；
  // trigram 要求查询词 >=3 字符，"爬山"这类 2 字词同样零命中。
  // 故不用 external content + SQL 触发器（分词只能在 JS 侧做，SQL 触发器做不到），
  // 改为独立虚表存"应用层预分词"结果：写入前用 tokenizeBigram 把中文按 bigram、
  // 英文/数字按整词切分、空格拼接后存入，FTS5 侧仍用默认 unicode61 按空格切分。
  // 索引维护搬到 memory-index.ts 的 upsertRow/deleteRow，由 memory-repo.ts 写入点调用。
  //
  // 历史数据补齐（rebuild）需要 JS 分词，SQL migration 做不到，改为应用启动时
  // 检测 checkFtsHealth() 不健康（老库升级后 FTS 表为空）就调用一次 rebuildFts()。
  [
    15,
    `
CREATE VIRTUAL TABLE IF NOT EXISTS agent_memories_fts USING fts5(
  content,
  tags,
  tokenize='unicode61 remove_diacritics 2'
);
`,
  ],
] as const;
