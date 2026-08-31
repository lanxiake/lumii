/**
 * SQLite Schema — DDL 常量
 *
 * 定义客户端本地存储的 8 张表。
 * 使用 node:sqlite 的 DatabaseSync 执行。
 */

/** 当前 schema 版本号 */
export const SCHEMA_VERSION = 26;

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
  // V16: Wiki 知识库 P0 —— 收件箱 / 资料层 / 知识层 / 修订层 / 运行日志 / 派生索引
  //
  // 设计：`docs/design/记忆设计/2026-08-25-wiki-design-p0p1p2.md` §3.2
  // 中文检索沿用 V15 agent_memories_fts 已验证的 bigram 预分词方案（unicode61 对中文
  // 2 字词零命中，已实测确认），FTS5 表存预分词结果，索引维护在 wiki-index.ts 手动做。
  [
    16,
    `
-- wiki_inbox：自动摄入的待整理条目，整理后转入 wiki_sources/wiki_pages
CREATE TABLE IF NOT EXISTS wiki_inbox (
  id                  TEXT PRIMARY KEY,
  agent_id            TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  item_type           TEXT NOT NULL CHECK (item_type IN ('upload', 'output', 'search', 'chat')),
  source_path         TEXT,
  source_url          TEXT,
  title               TEXT NOT NULL,
  content_preview     TEXT,
  media_type          TEXT NOT NULL DEFAULT 'document'
    CHECK (media_type IN ('document', 'image', 'audio', 'video')),
  status              TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'organized', 'discarded')),
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  organized_source_id TEXT,
  content_hash        TEXT,
  created_at          TEXT NOT NULL,
  organized_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_wiki_inbox_status
  ON wiki_inbox (agent_id, user_id, status, created_at DESC);

-- wiki_sources：资料层，事实不可变；extracted_text 是多媒体可被检索的唯一途径
CREATE TABLE IF NOT EXISTS wiki_sources (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  title           TEXT NOT NULL,
  source_path     TEXT,
  content_md      TEXT,
  content_hash    TEXT,
  mime_type       TEXT,
  media_type      TEXT NOT NULL DEFAULT 'document'
    CHECK (media_type IN ('document', 'image', 'audio', 'video')),
  extracted_text  TEXT,
  media_meta      TEXT,
  preview_path    TEXT,
  origin_context  TEXT,
  archived_at     TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wiki_sources_agent_user
  ON wiki_sources (agent_id, user_id, created_at DESC);

-- wiki_pages：知识层，AI 与用户共写；不设权限字段，修订历史即保护
CREATE TABLE IF NOT EXISTS wiki_pages (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  path        TEXT NOT NULL,
  category    TEXT NOT NULL,
  title       TEXT NOT NULL,
  content_md  TEXT NOT NULL DEFAULT '',
  version     INTEGER NOT NULL DEFAULT 1,
  last_used   TEXT,
  use_count   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (agent_id, user_id, path)
);

CREATE INDEX IF NOT EXISTS idx_wiki_pages_category
  ON wiki_pages (agent_id, user_id, category);

-- wiki_page_revisions：每次写入的不可变快照，回滚即新增一版
CREATE TABLE IF NOT EXISTS wiki_page_revisions (
  id          TEXT PRIMARY KEY,
  page_id     TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  title       TEXT NOT NULL,
  path        TEXT NOT NULL,
  content_md  TEXT NOT NULL DEFAULT '',
  editor      TEXT NOT NULL CHECK (editor IN ('user', 'ai')),
  source_ref  TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (page_id, version)
);

-- wiki_organize_runs：全自动分类归档的可审计日志
CREATE TABLE IF NOT EXISTS wiki_organize_runs (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  inbox_ids      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'succeeded', 'degraded', 'partial', 'failed')),
  result_summary TEXT,
  error          TEXT,
  created_at     TEXT NOT NULL,
  finished_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_wiki_runs_agent_user
  ON wiki_organize_runs (agent_id, user_id, created_at DESC);

-- wiki_pages_fts：预分词后的标题/正文检索列，独立虚表（非 external content）
-- 分词逻辑变更时只需重建索引，不迁移 wiki_pages 主表
CREATE VIRTUAL TABLE IF NOT EXISTS wiki_pages_fts USING fts5(
  title_tokens,
  content_tokens
);

-- wiki_index_meta：索引健康状态、分词器实际生效类型，供 UI 诊断
CREATE TABLE IF NOT EXISTS wiki_index_meta (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
`,
  ],
  // V17: wiki_organize_runs 增加 'degraded' 终态。
  // 分类降级（落点兜底到 inbox/）此前被记为 succeeded，用户无从发现归档没真正分类。
  // SQLite 不支持改 CHECK 约束，按官方推荐的重建表流程搬迁数据。
  [
    17,
    `
CREATE TABLE wiki_organize_runs_new (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  inbox_ids      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'succeeded', 'degraded', 'partial', 'failed')),
  result_summary TEXT,
  error          TEXT,
  created_at     TEXT NOT NULL,
  finished_at    TEXT
);

INSERT INTO wiki_organize_runs_new
  SELECT id, agent_id, user_id, inbox_ids, status, result_summary, error, created_at, finished_at
  FROM wiki_organize_runs;

DROP TABLE wiki_organize_runs;
ALTER TABLE wiki_organize_runs_new RENAME TO wiki_organize_runs;

CREATE INDEX IF NOT EXISTS idx_wiki_runs_agent_user
  ON wiki_organize_runs (agent_id, user_id, created_at DESC);
`,
  ],
  // V18: Wiki 知识库 P1 —— 链接索引 + 附件表 + 页面状态列
  //
  // 设计：`docs/plans/记忆重构/2026-08-26-wiki-p1-implementation.md` Task 1
  // wiki_links：页面间有向链接索引（反链与 P2 图谱的数据源）；target_page_id 不带外键约束，
  // 删除目标页时链接索引级联清理由 WikiRepo 显式完成，其他页正文中的 [[...]] 文本保留为未解析。
  [
    18,
    `
CREATE TABLE IF NOT EXISTS wiki_links (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  source_page_id TEXT NOT NULL,
  target_page_id TEXT,
  anchor_text    TEXT NOT NULL,
  is_resolved    INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wiki_links_target ON wiki_links (agent_id, user_id, target_page_id, is_resolved);
CREATE INDEX IF NOT EXISTS idx_wiki_links_source ON wiki_links (source_page_id);

CREATE TABLE IF NOT EXISTS wiki_page_attachments (
  id          TEXT PRIMARY KEY,
  page_id     TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  source_id   TEXT,
  file_path   TEXT NOT NULL,
  media_type  TEXT NOT NULL DEFAULT 'document'
    CHECK (media_type IN ('document', 'image', 'audio', 'video')),
  display_name TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wiki_attachments_page ON wiki_page_attachments (page_id);

ALTER TABLE wiki_pages ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'outdated', 'doubtful', 'archived'));
`,
  ],
  // V19: Wiki 知识库 P2 —— 综述合成运行记录
  //
  // 设计：`docs/plans/记忆重构/2026-08-26-wiki-p2-implementation.md` Task 0
  // 候选是正式数据：先落 candidate_md + status='candidate'，用户接受后才建 syntheses/ 页面。
  // 拒绝的记录保留（可审计），不删除。
  [
    19,
    `
CREATE TABLE IF NOT EXISTS wiki_syntheses (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  page_id        TEXT,
  source_page_ids TEXT NOT NULL,
  source_ids     TEXT,
  title          TEXT NOT NULL,
  output_path    TEXT,
  candidate_md   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'accepted', 'rejected')),
  error          TEXT,
  created_at     TEXT NOT NULL,
  finished_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_wiki_syntheses_agent_user
  ON wiki_syntheses (agent_id, user_id, status, created_at DESC);
`,
  ],
  // V20: Wiki P2 扩展 —— ERO 最小模型 + 页面向量派生表
  //
  // ERO：实体 / 观察 / 关系；关系重复用概率并集强化 strength，不物理删观察（retired_at）。
  // 向量：wiki_page_embeddings 为可重建派生物；失败/关闭时检索降级 FTS 并显式提示。
  [
    20,
    `
CREATE TABLE IF NOT EXISTS wiki_entities (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  name           TEXT NOT NULL,
  entity_type    TEXT NOT NULL DEFAULT 'concept',
  page_id        TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (agent_id, user_id, name, entity_type)
);
CREATE INDEX IF NOT EXISTS idx_wiki_entities_agent_user
  ON wiki_entities (agent_id, user_id, name);

CREATE TABLE IF NOT EXISTS wiki_observations (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  entity_id      TEXT NOT NULL REFERENCES wiki_entities(id) ON DELETE CASCADE,
  content        TEXT NOT NULL,
  source_page_id TEXT,
  retired_at     TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wiki_observations_entity
  ON wiki_observations (entity_id, retired_at);

CREATE TABLE IF NOT EXISTS wiki_relations (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  source_entity_id TEXT NOT NULL REFERENCES wiki_entities(id) ON DELETE CASCADE,
  target_entity_id TEXT NOT NULL REFERENCES wiki_entities(id) ON DELETE CASCADE,
  relation_type  TEXT NOT NULL,
  strength       REAL NOT NULL DEFAULT 0.5
    CHECK (strength >= 0 AND strength <= 1),
  source_page_id TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (agent_id, user_id, source_entity_id, target_entity_id, relation_type)
);
CREATE INDEX IF NOT EXISTS idx_wiki_relations_source
  ON wiki_relations (source_entity_id);
CREATE INDEX IF NOT EXISTS idx_wiki_relations_target
  ON wiki_relations (target_entity_id);

CREATE TABLE IF NOT EXISTS wiki_page_embeddings (
  page_id        TEXT PRIMARY KEY REFERENCES wiki_pages(id) ON DELETE CASCADE,
  agent_id       TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  model_id       TEXT NOT NULL,
  dims           INTEGER NOT NULL,
  embedding      BLOB NOT NULL,
  content_hash   TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wiki_page_embeddings_agent
  ON wiki_page_embeddings (agent_id, user_id, model_id);
`,
  ],
  // V21: 归档运行日志逐条明细（JSON {"items":[...]}）
  [
    21,
    `ALTER TABLE wiki_organize_runs ADD COLUMN result_detail TEXT;`,
  ],
  // V22: wiki_sources 加用途两列（topic_category/topic_subtopic）与使用统计，
  // 资料层独立 FTS（wiki_sources_fts，与 wiki_pages_fts 同构，非 external content）；
  // ERO 三表加可空 source_id，便于未来实体/关系挂到资料而非页面。
  [
    22,
    `
ALTER TABLE wiki_sources ADD COLUMN topic_category TEXT;
ALTER TABLE wiki_sources ADD COLUMN topic_subtopic TEXT;
ALTER TABLE wiki_sources ADD COLUMN last_used TEXT;
ALTER TABLE wiki_sources ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_wiki_sources_topic
  ON wiki_sources (agent_id, user_id, topic_category, topic_subtopic);

CREATE VIRTUAL TABLE IF NOT EXISTS wiki_sources_fts USING fts5(
  title_tokens,
  content_tokens
);

ALTER TABLE wiki_entities ADD COLUMN source_id TEXT;
ALTER TABLE wiki_observations ADD COLUMN source_id TEXT;
ALTER TABLE wiki_relations ADD COLUMN source_id TEXT;
CREATE INDEX IF NOT EXISTS idx_wiki_entities_source ON wiki_entities (source_id);
CREATE INDEX IF NOT EXISTS idx_wiki_observations_source ON wiki_observations (source_id);
`,
  ],
  // V23: 区分「AI 拿不准，留待人工」与「真的出错了」。两者都记 attempt_count，
  // 但前者不是失败，UI 不该显示成「失败原因…（已重试 N 次）」。
  [
    23,
    `ALTER TABLE wiki_inbox ADD COLUMN last_outcome TEXT;`,
  ],
  // V24: 资料层向量派生表（可重建；结构对齐 wiki_page_embeddings）。
  // 与 wiki_sources_fts 做 RRF，失败/关闭时显式降级；不新增列，不改三期 source_id。
  [
    24,
    `
CREATE TABLE IF NOT EXISTS wiki_source_embeddings (
  source_id      TEXT PRIMARY KEY REFERENCES wiki_sources(id) ON DELETE CASCADE,
  agent_id       TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  model_id       TEXT NOT NULL,
  dims           INTEGER NOT NULL,
  embedding      BLOB NOT NULL,
  content_hash   TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wiki_source_embeddings_agent
  ON wiki_source_embeddings (agent_id, user_id, model_id);
`,
  ],
  // V25: 引用优先。origin_url 记住资料从哪来（网页/剪藏），storage_mode 区分
  // 「只存引用」「已复制进库」「正文在库」——UI 靠它决定要不要显示「保存副本」。
  // 历史行一律视为 ref：迁移前没有复制文件的动作。
  [
    25,
    `
ALTER TABLE wiki_sources ADD COLUMN origin_url TEXT;
ALTER TABLE wiki_sources ADD COLUMN storage_mode TEXT NOT NULL DEFAULT 'ref'
  CHECK (storage_mode IN ('ref', 'materialized', 'native'));
`,
  ],
  // V26: 分类体系 v2。大类机械改写（6 条规则）、小类整体置空待编目重填。
  // 旧小类值留存 legacy_subtopic 供审计；「计划与复盘」整类与「整合长文」小类
  // （综述产物专属落点，六大类下都有）无法机械映射到 v2 树，退回收件箱由用户/P5 编目重填。
  //
  // 设计：docs/design/记忆设计/2026-08-31-wiki-intelligent-vault-design.md v1.1 §3
  [
    26,
    `
ALTER TABLE wiki_sources ADD COLUMN legacy_subtopic TEXT;
ALTER TABLE wiki_sources ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wiki_sources ADD COLUMN summary TEXT;
ALTER TABLE wiki_sources ADD COLUMN summary_hash TEXT;
ALTER TABLE wiki_sources ADD COLUMN summary_level TEXT
  CHECK (summary_level IN ('heuristic','extractive','llm'));

-- 1) 旧小类留档（含即将回收件箱的「整合长文」，一并留痕）
UPDATE wiki_sources SET legacy_subtopic = topic_subtopic WHERE topic_subtopic IS NOT NULL;

-- 2) 计划与复盘 整类 + 整合长文 → 收件箱（两列置空，legacy_subtopic 已留痕）。
--    必须先于第 3 步的大类改写执行：「整合长文」同时挂在其余五个大类下，
--    若先跑大类改写会把 topic_subtopic 提前清空，这里就再也匹配不到了。
UPDATE wiki_sources SET topic_category=NULL, topic_subtopic=NULL
  WHERE topic_category='计划与复盘' OR topic_subtopic='整合长文';

-- 3) 大类改写（5 条无歧义），小类一律置空待编目重填
UPDATE wiki_sources SET topic_category='工作', topic_subtopic=NULL WHERE topic_category='做事记录';
UPDATE wiki_sources SET topic_category='学习', topic_subtopic=NULL WHERE topic_category='学习资料';
UPDATE wiki_sources SET topic_category='生活', topic_subtopic=NULL WHERE topic_category='证件凭据';
UPDATE wiki_sources SET topic_category='收藏', topic_subtopic=NULL WHERE topic_category='模板参考';
UPDATE wiki_sources SET topic_category='生活', topic_subtopic=NULL WHERE topic_category='随笔创作';
`,
  ],
] as const;
