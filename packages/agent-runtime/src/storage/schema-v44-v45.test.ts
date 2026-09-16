/**
 * V44 / V45 / V46 迁移验证：测量的三个维度。
 *
 * V44 把 `tool_usage_stats` 从「只有 tool_name 主键」重建为 `(agent_id, tool_name)`。
 * 动因：原表答不了「维护到底用没用过 wiki_read」这类逐 Agent 的取舍问题，
 * 逐 Agent 的工具收敛决策只能靠猜。
 *
 * V45 给 `tool_audit_log` 补 `definition_id`。动因：它的 agent_id 存的是**实例 id**
 * （`agent-1789048421480-wst9ns`），实例不落库，等于存了个没人能解的外键。
 *
 * V46 加 `tool_usage_daily`。动因：V44 答得了「谁在用」，答不了「**最近**还在用吗」——
 * 而 B1 的靶子搞错正是因为拿累计数字当当前状态看。
 *
 * V44/V45 共同的取舍：**旧数据不假装能归因**——落 'unknown' / 留 NULL。这些用例守住它。
 * V46 的另一条：旧数据**不进按日表**——没有时间信息，硬塞一个日期就是编造。
 */
import { describe, expect, it } from 'vitest'
import {
  createMigratedTestDb,
  createPreV44TestDb,
  createPreV45TestDb,
  runMigration44,
  runMigration45,
} from '../__tests__/helpers/sqlite-test-db.js'
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js'

interface UsageRow {
  agent_id: string
  tool_name: string
  count: number
  error_count: number
  last_used_at: number | null
}

function columns(db: ReturnType<typeof createMigratedTestDb>, table: string): string[] {
  return db
    .prepare<{ name: string }>(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name)
}

describe('schema V44 tool_usage_stats 加 agent 维度', () => {
  it('SCHEMA_VERSION 已递增到 46', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(46)
  })

  it('新建库直接带 agent_id 列', () => {
    const db = createMigratedTestDb()
    expect(columns(db, 'tool_usage_stats')).toContain('agent_id')
    db.close()
  })

  it('存量行整表搬到 unknown，计数一字不改', () => {
    const db = createPreV44TestDb()
    // 老表结构（只有 tool_name 主键）
    expect(columns(db, 'tool_usage_stats')).not.toContain('agent_id')
    db.prepare(
      `INSERT INTO tool_usage_stats (tool_name, count, error_count, last_used_at) VALUES (?, ?, ?, ?)`,
    ).run('web_search', 472, 181, 1789544009079)
    db.prepare(
      `INSERT INTO tool_usage_stats (tool_name, count, error_count, last_used_at) VALUES (?, ?, ?, ?)`,
    ).run('bash', 1726, 2, null)

    runMigration44(db)

    const rows = db
      .prepare<UsageRow>(`SELECT agent_id, tool_name, count, error_count, last_used_at FROM tool_usage_stats ORDER BY tool_name`)
      .all()
    expect(rows).toEqual([
      {
        agent_id: 'unknown',
        tool_name: 'bash',
        count: 1726,
        error_count: 2,
        last_used_at: null,
      },
      {
        agent_id: 'unknown',
        tool_name: 'web_search',
        count: 472,
        error_count: 181,
        last_used_at: 1789544009079,
      },
    ])
    db.close()
  })

  it('迁移后同一工具可被多个 Agent 分别记账，且不再互相覆盖', () => {
    const db = createPreV44TestDb()
    runMigration44(db)

    const stmt = db.prepare(
      `INSERT INTO tool_usage_stats (agent_id, tool_name, count, error_count, last_used_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, tool_name) DO UPDATE SET count = excluded.count`,
    )
    stmt.run('system-keeper', 'wiki_read', 7, 0, 1)
    stmt.run('info-curator', 'wiki_read', 3, 1, 2)

    const rows = db
      .prepare<UsageRow>(`SELECT agent_id, tool_name, count, error_count, last_used_at FROM tool_usage_stats WHERE tool_name = 'wiki_read' ORDER BY count DESC`)
      .all()
    expect(rows.map((r) => [r.agent_id, r.count])).toEqual([
      ['system-keeper', 7],
      ['info-curator', 3],
    ])
    db.close()
  })

  it('迁移表 tool_usage_stats_v43 不留在库里', () => {
    const db = createPreV44TestDb()
    runMigration44(db)
    const tables = db
      .prepare<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((t) => t.name)
    expect(tables).toContain('tool_usage_stats')
    expect(tables).not.toContain('tool_usage_stats_v43')
    db.close()
  })

  it('重放会毁掉已归因的数据，所以必须靠 isMigrationAlreadyApplied 守卫（此处固化这条认识）', () => {
    // 这不是「测重放是安全的」——恰恰相反：重放会把 agent 维度压回 unknown。
    // 记下这个事实，是为了让 guard 一旦被误删，这里立刻红。
    const db = createPreV44TestDb()
    runMigration44(db)
    db.prepare(
      `INSERT INTO tool_usage_stats (agent_id, tool_name, count, error_count, last_used_at) VALUES ('system-keeper', 'asset_checkup', 5, 0, 1)`,
    ).run()

    runMigration44(db)

    const row = db
      .prepare<UsageRow>(`SELECT agent_id, count FROM tool_usage_stats WHERE tool_name = 'asset_checkup'`)
      .get()
    expect(row?.agent_id).toBe('unknown')
    db.close()
  })
})

describe('schema V45 tool_audit_log 补 definition_id', () => {
  it('新建库直接带 definition_id 列', () => {
    const db = createMigratedTestDb()
    expect(columns(db, 'tool_audit_log')).toContain('definition_id')
    db.close()
  })

  it('存量审计行留空，不强填一个假定义', () => {
    const db = createPreV45TestDb()
    expect(columns(db, 'tool_audit_log')).not.toContain('definition_id')
    db.prepare(
      `INSERT INTO tool_audit_log (agent_id, tool_name, result_summary, is_error, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('agent-1789048421480-wst9ns', 'bash', '允许(仅本次)', 0, new Date().toISOString())

    runMigration45(db)

    const row = db
      .prepare<{ agent_id: string; definition_id: string | null }>(`SELECT agent_id, definition_id FROM tool_audit_log`)
      .get()
    // agent_id 的语义不改（它确实记的是实例），定义维度留 NULL
    expect(row?.agent_id).toBe('agent-1789048421480-wst9ns')
    expect(row?.definition_id).toBeNull()
    db.close()
  })

  it('迁移版本在 MIGRATIONS 中按序且唯一', () => {
    const versions = MIGRATIONS.map(([v]) => v)
    expect(versions).toEqual([...versions].sort((a, b) => a - b))
    expect(new Set(versions).size).toBe(versions.length)
  })
})

describe('schema V46 tool_usage_daily 按日维度', () => {
  it('新建库直接带按日表', () => {
    const db = createMigratedTestDb()
    const cols = columns(db, 'tool_usage_daily')
    expect(cols).toEqual(
      expect.arrayContaining(['day', 'agent_id', 'tool_name', 'count', 'error_count', 'last_used_at']),
    )
    db.close()
  })

  it('同一天同一 Agent 同一工具只能有一行（累加而不是堆行）', () => {
    const db = createMigratedTestDb()
    const stmt = db.prepare(
      `INSERT INTO tool_usage_daily (day, agent_id, tool_name, count, error_count, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(day, agent_id, tool_name) DO UPDATE SET count = excluded.count`,
    )
    stmt.run('2026-09-16', 'assistant', 'bash', 3, 0, 1)
    stmt.run('2026-09-16', 'assistant', 'bash', 9, 1, 2)

    const rows = db
      .prepare<{ count: number; error_count: number }>(
        `SELECT count, error_count FROM tool_usage_daily WHERE day = '2026-09-16'`,
      )
      .all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.count).toBe(9)
    db.close()
  })

  it('V46 是纯新增：不碰累计表，历史存量原样留着', () => {
    // 这条守住「加按日维度不能顺手把累计数据也改了」——
    // 两张表分家的主要理由就是「清理旧数据」不该等于「删掉历史总数」。
    const db = createPreV45TestDb()
    runMigration45(db)
    db.prepare(
      `INSERT INTO tool_usage_stats (agent_id, tool_name, count, error_count, last_used_at) VALUES ('unknown', 'bash', 1940, 2, 1)`,
    ).run()

    const entry = MIGRATIONS.find(([v]) => v === 46)
    expect(entry).toBeDefined()
    db.exec(entry![1])

    const stat = db
      .prepare<{ count: number }>(`SELECT count FROM tool_usage_stats WHERE tool_name = 'bash'`)
      .get()
    expect(stat?.count).toBe(1940)
    // 旧数据不进按日表：没有时间信息，硬塞一个日期就是编造
    expect(db.prepare(`SELECT COUNT(*) n FROM tool_usage_daily`).get()).toMatchObject({ n: 0 })
    db.close()
  })
})
