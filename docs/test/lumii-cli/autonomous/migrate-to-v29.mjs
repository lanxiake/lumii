#!/usr/bin/env node
/**
 * 手动运行数据库迁移到 V29
 * 用于测试 P1 新增的数据库表
 */

import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db')

console.log(`数据库路径: ${DB_PATH}\n`)

const db = new DatabaseSync(DB_PATH)

// 获取当前版本
const versionRow = db.prepare('PRAGMA user_version').get()
const currentVersion = versionRow.user_version

console.log(`当前版本: ${currentVersion}`)

// V29 迁移 SQL
const V29_SQL = `
-- 更新 autonomous_goals 表，添加 capability-improvement 类型
-- SQLite 不支持 ALTER TABLE ... ALTER COLUMN，需要重建表
-- 1. 创建新表
CREATE TABLE IF NOT EXISTS autonomous_goals_new (
  id                   TEXT PRIMARY KEY,
  agent_id             TEXT NOT NULL,
  type                 TEXT NOT NULL CHECK (type IN ('learning', 'proactive-message', 'capability-improvement')),
  description          TEXT NOT NULL,
  trigger_reason       TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'executing', 'completed', 'failed')),
  priority             REAL NOT NULL CHECK (priority BETWEEN 0 AND 1),
  satisfaction_before  REAL,
  satisfaction_after   REAL,
  metadata             TEXT,
  created_at           TEXT NOT NULL,
  approved_at          TEXT,
  executed_at          TEXT,
  completed_at         TEXT
);

-- 2. 复制旧数据
INSERT INTO autonomous_goals_new
SELECT * FROM autonomous_goals;

-- 3. 删除旧表
DROP TABLE autonomous_goals;

-- 4. 重命名新表
ALTER TABLE autonomous_goals_new RENAME TO autonomous_goals;

-- 5. 重建索引
CREATE INDEX IF NOT EXISTS idx_goals_agent_status_created
  ON autonomous_goals (agent_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_goals_created
  ON autonomous_goals (created_at DESC);

-- capability_dimensions: 能力维度追踪表
CREATE TABLE IF NOT EXISTS capability_dimensions (
  agent_id      TEXT NOT NULL,
  dimension     TEXT NOT NULL,
  level         REAL NOT NULL DEFAULT 0.5 CHECK (level BETWEEN 0 AND 1),
  confidence    REAL NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  boundary      REAL NOT NULL DEFAULT 0.5 CHECK (boundary BETWEEN 0 AND 1),
  test_count    INTEGER NOT NULL DEFAULT 0,
  last_updated  TEXT NOT NULL,
  PRIMARY KEY (agent_id, dimension)
);
CREATE INDEX IF NOT EXISTS idx_capability_agent_dimension
  ON capability_dimensions (agent_id, dimension);

-- capability_tests: 能力测试记录表
CREATE TABLE IF NOT EXISTS capability_tests (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  dimension     TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  task_summary  TEXT NOT NULL,
  difficulty    REAL NOT NULL CHECK (difficulty BETWEEN 0 AND 1),
  result        TEXT NOT NULL CHECK (result IN ('success', 'partial', 'failure')),
  level_before  REAL,
  level_after   REAL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_capability_tests_agent_dimension_created
  ON capability_tests (agent_id, dimension, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_capability_tests_session
  ON capability_tests (session_id);

-- reflections: 自我反思记录表
CREATE TABLE IF NOT EXISTS reflections (
  id                      TEXT PRIMARY KEY,
  agent_id                TEXT NOT NULL,
  trigger_reason          TEXT NOT NULL CHECK (trigger_reason IN ('scheduled', 'low-satisfaction', 'user-request')),
  primary_issue           TEXT NOT NULL,
  affected_dimensions     TEXT NOT NULL,
  root_cause              TEXT NOT NULL,
  recommendations         TEXT NOT NULL,
  suggested_goals         TEXT NOT NULL,
  analysis_window_start   TEXT NOT NULL,
  analysis_window_end     TEXT NOT NULL,
  created_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reflections_agent_created
  ON reflections (agent_id, created_at DESC);
`

if (currentVersion < 29) {
  console.log('\n执行 V29 迁移...')

  try {
    db.exec(V29_SQL)
    db.prepare('PRAGMA user_version = 29').run()
    console.log('✓ V29 迁移成功\n')
  } catch (err) {
    console.error('✗ V29 迁移失败:', err.message)
    process.exit(1)
  }
} else {
  console.log('\n数据库已是最新版本，无需迁移\n')
}

// 验证表是否创建
const tables = db.prepare(`
  SELECT name FROM sqlite_master WHERE type='table' AND name IN ('capability_dimensions', 'capability_tests', 'reflections')
`).all()

console.log('验证表创建:')
console.log(`  capability_dimensions: ${tables.some(t => t.name === 'capability_dimensions') ? '✓' : '✗'}`)
console.log(`  capability_tests: ${tables.some(t => t.name === 'capability_tests') ? '✓' : '✗'}`)
console.log(`  reflections: ${tables.some(t => t.name === 'reflections') ? '✓' : '✗'}`)

const finalVersion = db.prepare('PRAGMA user_version').get()
console.log(`\n最终版本: ${finalVersion.user_version}\n`)

db.close()
