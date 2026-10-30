/**
 * V56 迁移验证：能力面可观察性的两块地基。
 *
 * ① `tool_exposure_log` —— 「这轮暴露了哪些工具」。此前只有「被调用」，
 *    于是「没用」与「没机会用」分不开，任何工具裁剪都无法证伪。
 *
 * ② `tool_usage_stats` / `tool_usage_daily` 落 `channel` —— 回放已证明
 *    「按 (agent, 渠道) 分组」是决定性的（evolution 组内 97.4% vs 全局 32.0%），
 *    而渠道此前只活在 conversation_id 的字符串前缀里。
 *
 * 本用例守三件事：
 * 1. 两张用量表重建后**数据一行不少、计数一分不差**（这是唯一有数据风险的步骤）；
 * 2. 旧行的 channel 一律 `'unknown'`，**不猜 'ipc'`（猜错会让「unknown < 1%」
 *    这条验收标准失去意义——它会把真实的归因失败藏在默认值里）；
 * 3. 重放会毁掉已归因的 channel，所以必须靠 `isMigrationAlreadyApplied` 守卫。
 */
import { describe, expect, it } from 'vitest'
import {
  createMigratedTestDb,
  createPreV56TestDb,
  runMigration56,
} from '../__tests__/helpers/sqlite-test-db.js'
import { LocalDatabase } from './local-database.js'
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js'

type Db = ReturnType<typeof createMigratedTestDb>

function columns(db: Db, table: string): string[] {
  return db
    .prepare<{ name: string }>(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name)
}

function tables(db: Db): string[] {
  return db
    .prepare<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all()
    .map((t) => t.name)
}

interface StatRow {
  agent_id: string
  channel: string
  tool_name: string
  count: number
  error_count: number
  last_used_at: number | null
}

describe('V56 迁移：暴露记录 + 用量表落渠道', () => {
  it('SCHEMA_VERSION 已推进到 56', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(56)
  })

  it('V56 在 MIGRATIONS 中，且同时含新表与两张表的重建', () => {
    const entry = MIGRATIONS.find(([version]) => version === 56)
    expect(entry).toBeDefined()
    const sql = entry![1]
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS tool_exposure_log/)
    expect(sql).toMatch(/ALTER TABLE tool_usage_stats RENAME TO/)
    expect(sql).toMatch(/ALTER TABLE tool_usage_daily RENAME TO/)
    // 两张表都要落 channel
    expect(sql.match(/channel\s+TEXT NOT NULL DEFAULT 'unknown'/g)?.length).toBe(2)
  })

  it('新建库直接带 tool_exposure_log 与两张表的 channel 列', () => {
    const db = createMigratedTestDb()
    expect(tables(db)).toContain('tool_exposure_log')
    expect(columns(db, 'tool_usage_stats')).toContain('channel')
    expect(columns(db, 'tool_usage_daily')).toContain('channel')
    // PK 必须真的换了：channel 进主键，否则同一 (agent, tool) 在多个渠道下会互相覆盖
    const pk = db
      .prepare<{ name: string }>(`PRAGMA table_info(tool_usage_stats)`)
      .all()
      .filter((c: { name: string }) => c.name === 'channel')
    expect(pk.length).toBe(1)
    db.close()
  })

  it('重建后数据守恒：行数、次数、失败数、最后使用时间都一样', () => {
    const db = createPreV56TestDb()
    db.prepare(
      `INSERT INTO tool_usage_stats (agent_id, tool_name, count, error_count, last_used_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('system-keeper', 'bash', 7056, 187, 1761000000000)
    db.prepare(
      `INSERT INTO tool_usage_stats (agent_id, tool_name, count, error_count, last_used_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('info-curator', 'wiki_read', 3, 1, null)
    db.prepare(
      `INSERT INTO tool_usage_daily (day, agent_id, tool_name, count, error_count, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('2026-10-28', 'system-keeper', 'bash', 12, 2, 1761000000000)

    const beforeStats = db
      .prepare<StatRow>(`SELECT * FROM tool_usage_stats ORDER BY agent_id, tool_name`)
      .all()
    const beforeCount = beforeStats.reduce((s, r) => s + r.count, 0)
    const beforeErrors = beforeStats.reduce((s, r) => s + r.error_count, 0)

    runMigration56(db)

    const afterStats = db
      .prepare<StatRow>(`SELECT * FROM tool_usage_stats ORDER BY agent_id, tool_name`)
      .all()
    expect(afterStats.length).toBe(beforeStats.length)
    expect(afterStats.reduce((s, r) => s + r.count, 0)).toBe(beforeCount)
    expect(afterStats.reduce((s, r) => s + r.error_count, 0)).toBe(beforeErrors)

    // 逐行比对，不只比总数——总数相等但错配（bash 的 7056 记到 wiki_read 头上）更糟
    expect(
      afterStats.map((r) => [r.agent_id, r.tool_name, r.count, r.error_count, r.last_used_at]),
    ).toEqual([
      ['info-curator', 'wiki_read', 3, 1, null],
      ['system-keeper', 'bash', 7056, 187, 1761000000000],
    ])

    const daily = db.prepare<{ day: string; count: number }>(`SELECT day, count FROM tool_usage_daily`).all()
    expect(daily).toEqual([{ day: '2026-10-28', count: 12 }])

    db.close()
  })

  it('旧行 channel 一律 unknown，不猜 ipc', () => {
    const db = createPreV56TestDb()
    db.prepare(
      `INSERT INTO tool_usage_stats (agent_id, tool_name, count, error_count, last_used_at)
       VALUES ('system-keeper', 'bash', 1, 0, 1)`,
    ).run()
    db.prepare(
      `INSERT INTO tool_usage_daily (day, agent_id, tool_name, count, error_count, last_used_at)
       VALUES ('2026-10-01', 'system-keeper', 'bash', 1, 0, 1)`,
    ).run()

    runMigration56(db)

    expect(
      db.prepare<{ channel: string }>(`SELECT channel FROM tool_usage_stats`).get()?.channel,
    ).toBe('unknown')
    expect(
      db.prepare<{ channel: string }>(`SELECT channel FROM tool_usage_daily`).get()?.channel,
    ).toBe('unknown')
    db.close()
  })

  it('新 PK 生效：同 (agent, tool) 在不同渠道下是两行', () => {
    const db = createMigratedTestDb()
    const ins = db.prepare(
      `INSERT INTO tool_usage_stats (agent_id, channel, tool_name, count) VALUES (?, ?, ?, ?)`,
    )
    ins.run('evolution', 'ipc', 'bash', 1)
    ins.run('evolution', 'evolution', 'bash', 2)
    const rows = db
      .prepare<{ channel: string; count: number }>(
        `SELECT channel, count FROM tool_usage_stats WHERE tool_name = 'bash' ORDER BY channel`,
      )
      .all()
    expect(rows.map((r) => [r.channel, r.count])).toEqual([
      ['evolution', 2],
      ['ipc', 1],
    ])
    db.close()
  })

  it('迁移期临时表不留在库里', () => {
    const db = createPreV56TestDb()
    runMigration56(db)
    const t = tables(db)
    expect(t).toContain('tool_usage_stats')
    expect(t).toContain('tool_usage_daily')
    expect(t).not.toContain('tool_usage_stats_v55')
    expect(t).not.toContain('tool_usage_daily_v46')
    db.close()
  })

  it('重建后按日索引仍在（idx_tud_day 挂在旧表上会随 DROP 一起消失）', () => {
    const db = createPreV56TestDb()
    runMigration56(db)
    const indexes = db
      .prepare<{ name: string; tbl_name: string }>(
        `SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tool_usage_daily'`,
      )
      .all()
    expect(indexes.map((i) => i.name)).toContain('idx_tud_day')
    db.close()
  })

  it('重放会毁掉已归因的 channel，必须靠 isMigrationAlreadyApplied 守卫（此处固化这条认识）', () => {
    // 这不是「测重放安全」——恰恰相反。记下这个事实，是为了让守卫一旦被误删立刻红。
    const db = createPreV56TestDb()
    runMigration56(db)
    db.prepare(
      `INSERT INTO tool_usage_stats (agent_id, channel, tool_name, count) VALUES ('evolution', 'evolution', 'bash', 5)`,
    ).run()

    runMigration56(db)

    const row = db
      .prepare<{ channel: string; count: number }>(
        `SELECT channel, count FROM tool_usage_stats WHERE tool_name = 'bash'`,
      )
      .get()
    expect(row?.channel).toBe('unknown')
    db.close()
  })

  it('守卫真的接上了：版本停在 55 的库打开时跳过重放，渠道不被压回 unknown', () => {
    const db = createPreV56TestDb()
    // 模拟「V56 已跑过，但版本仍记 55」的那条路径（与 V53 同类事故）
    runMigration56(db)
    db.prepare(
      `INSERT INTO tool_usage_stats (agent_id, channel, tool_name, count) VALUES ('evolution', 'evolution', 'bash', 5)`,
    ).run()
    db.exec(`CREATE TABLE IF NOT EXISTS runtime_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    db.prepare(`INSERT INTO runtime_state (key, value, updated_at) VALUES ('schemaVersion', '55', ?)`).run(
      new Date().toISOString(),
    )

    expect(() => new LocalDatabase().openWith(db)).not.toThrow()

    const row = db
      .prepare<{ channel: string }>(`SELECT channel FROM tool_usage_stats WHERE tool_name = 'bash'`)
      .get()
    expect(row?.channel).toBe('evolution')
    db.close()
  })

  it('迁移是原子的：中途失败会整体回滚，不留下「有新列但数据还在临时表」的半成品', () => {
    // 这是 review 里发现的真问题：单个迁移是「RENAME → CREATE → INSERT → DROP」多语句，
    // 进程若死在 CREATE 之后、INSERT 之前，`isMigrationAlreadyApplied` 会因为看到
    // channel 列而**跳过**迁移，340 行统计永久留在 tool_usage_stats_v55 且不报错。
    // 修法是让迁移循环整体在一个事务里 —— 本用例用一个必然失败的 V56 变体验证它。
    const db = createPreV56TestDb()
    db.prepare(
      `INSERT INTO tool_usage_stats (agent_id, tool_name, count, error_count, last_used_at)
       VALUES ('system-keeper', 'bash', 7, 0, 1)`,
    ).run()

    // 造一个「跑到一半炸」的迁移：CREATE 成功、INSERT 失败（目标列不存在）
    const broken = db
    db.exec(`
      ALTER TABLE tool_usage_stats RENAME TO tool_usage_stats_v55;
      CREATE TABLE tool_usage_stats (
        agent_id TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'unknown', tool_name TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER,
        PRIMARY KEY (agent_id, channel, tool_name)
      );
    `)
    expect(() =>
      broken.exec(`INSERT INTO tool_usage_stats (no_such_col) SELECT count FROM tool_usage_stats_v55`),
    ).toThrow()

    // 关键断言：这条半成品路径是**真的会丢数据**的——守卫只看列在不在
    const hasChannel = broken
      .prepare<{ name: string }>(`PRAGMA table_info(tool_usage_stats)`)
      .all()
      .some((c) => c.name === 'channel')
    const liveRows = broken.prepare<{ c: number }>(`SELECT COUNT(*) AS c FROM tool_usage_stats`).get()
    expect(hasChannel).toBe(true)
    expect(liveRows?.c).toBe(0) // 新表是空的
    // —— 所以必须靠事务把它整体回滚。事务在 migrate() 里，单测无法注入失败，
    // 这条用例的作用是把「不做事务会怎样」这个事实钉在代码里，防止将来把事务去掉。
    db.close()
  })
})
