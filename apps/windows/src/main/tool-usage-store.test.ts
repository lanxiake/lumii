import { describe, expect, it, beforeEach, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { createMigratedTestDb } from '../../../../packages/agent-runtime/src/__tests__/helpers/sqlite-test-db'

/** 每个用例独立数据根，避免相互污染 */
async function store() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumii-tool-usage-'))
  vi.doMock('./client-data-root', () => ({ resolveWindowsClientDataRoot: () => dir }))
  vi.resetModules()
  const mod = await import('./tool-usage-store')
  mod.__resetToolUsageCacheForTest()
  return { ...mod, dir }
}

beforeEach(() => {
  vi.resetModules()
  vi.doUnmock('./client-data-root')
})

describe('tool-usage-store', () => {
  it('累加调用次数并区分失败次数', async () => {
    const { recordToolUsage, getToolUsage } = await store()
    await recordToolUsage('system-keeper', 'file_read')
    await recordToolUsage('system-keeper', 'file_read')
    await recordToolUsage('system-keeper', 'file_read', true)

    const usage = await getToolUsage()
    expect(usage['file_read']?.count).toBe(3)
    expect(usage['file_read']?.errorCount).toBe(1)
    expect(usage['file_read']?.lastUsedAt).toBeGreaterThan(0)
  })

  it('未调用过的工具不出现在统计中', async () => {
    const { recordToolUsage, getToolUsage } = await store()
    await recordToolUsage('system-keeper', 'bash')
    const usage = await getToolUsage()
    expect(usage['web_search']).toBeUndefined()
  })

  it('MCP 工具按全名独立计数', async () => {
    const { recordToolUsage, getToolUsage } = await store()
    await recordToolUsage('assistant', 'mcp__ynote__createNote')
    await recordToolUsage('assistant', 'mcp__ynote__listNotes')
    await recordToolUsage('assistant', 'mcp__ynote__createNote')

    const usage = await getToolUsage()
    expect(usage['mcp__ynote__createNote']?.count).toBe(2)
    expect(usage['mcp__ynote__listNotes']?.count).toBe(1)
  })

  it('同一工具按 Agent 分别记账，互不覆盖', async () => {
    const { recordToolUsage, getToolUsageByAgent } = await store()
    await recordToolUsage('system-keeper', 'wiki_read')
    await recordToolUsage('system-keeper', 'wiki_read')
    await recordToolUsage('info-curator', 'wiki_read', true)

    const byAgent = await getToolUsageByAgent()
    expect(byAgent['system-keeper']?.['wiki_read']).toMatchObject({ count: 2, errorCount: 0 })
    expect(byAgent['info-curator']?.['wiki_read']).toMatchObject({ count: 1, errorCount: 1 })
  })

  it('跨 Agent 汇总保持老口径（高频工具排序仍可用）', async () => {
    const { recordToolUsage, getToolUsage } = await store()
    await recordToolUsage('system-keeper', 'bash')
    await recordToolUsage('assistant', 'bash', true)
    await recordToolUsage('assistant', 'bash')

    const usage = await getToolUsage()
    expect(usage['bash']).toMatchObject({ count: 3, errorCount: 1 })
  })

  it('agentId 为空时落 unknown，不编一个假 Agent', async () => {
    const { recordToolUsage, getToolUsageByAgent, UNKNOWN_AGENT_ID } = await store()
    await recordToolUsage('', 'grep')

    const byAgent = await getToolUsageByAgent()
    expect(byAgent[UNKNOWN_AGENT_ID]?.['grep']?.count).toBe(1)
  })

  it('逐 Agent 读回是深拷贝，改不动内部状态', async () => {
    const { recordToolUsage, getToolUsageByAgent } = await store()
    await recordToolUsage('assistant', 'glob')

    const first = await getToolUsageByAgent()
    first['assistant']['glob'].count = 999

    const second = await getToolUsageByAgent()
    expect(second['assistant']?.['glob']?.count).toBe(1)
  })

  it('flush 后落盘，重新加载能读回计数', async () => {
    const { recordToolUsage, flushToolUsage, dir } = await store()
    await recordToolUsage('assistant', 'grep')
    await recordToolUsage('assistant', 'grep')
    await flushToolUsage()

    const raw = await fs.readFile(path.join(dir, 'usage', 'tool-usage.json'), 'utf-8')
    expect(JSON.parse(raw)['grep'].count).toBe(2)
  })

  it('文件损坏时退回空统计而不抛错', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumii-tool-usage-bad-'))
    await fs.mkdir(path.join(dir, 'usage'), { recursive: true })
    await fs.writeFile(path.join(dir, 'usage', 'tool-usage.json'), '{ not json', 'utf-8')

    vi.doMock('./client-data-root', () => ({ resolveWindowsClientDataRoot: () => dir }))
    vi.resetModules()
    const mod = await import('./tool-usage-store')
    mod.__resetToolUsageCacheForTest()

    await expect(mod.getToolUsage()).resolves.toEqual({})
  })

  it('空工具名不计数', async () => {
    const { recordToolUsage, getToolUsage } = await store()
    await recordToolUsage('assistant', '')
    expect(await getToolUsage()).toEqual({})
  })
})

describe('tool-usage-store · SQLite 路径', () => {
  /** 注入真实内存库（已迁移到最新 schema），验证 agent 维度真的进出数据库 */
  async function storeWithDb() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumii-tool-usage-db-'))
    vi.doMock('./client-data-root', () => ({ resolveWindowsClientDataRoot: () => dir }))
    vi.resetModules()
    const mod = await import('./tool-usage-store')
    mod.__resetToolUsageCacheForTest()
    const db = createMigratedTestDb()
    mod.initToolUsageStore(db)
    return { ...mod, db }
  }

  it('逐 Agent 落库，重新加载后按 Agent 读回', async () => {
    const first = await storeWithDb()
    await first.recordToolUsage('system-keeper', 'asset_checkup')
    await first.recordToolUsage('system-keeper', 'asset_checkup')
    await first.recordToolUsage('info-curator', 'dashboard_feed_write')
    await first.flushToolUsage()

    const rows = first.db
      .prepare<{ agent_id: string; tool_name: string; count: number }>(
        'SELECT agent_id, tool_name, count FROM tool_usage_stats ORDER BY agent_id, tool_name',
      )
      .all()
    expect(rows).toEqual([
      { agent_id: 'info-curator', tool_name: 'dashboard_feed_write', count: 1 },
      { agent_id: 'system-keeper', tool_name: 'asset_checkup', count: 2 },
    ])

    // 模拟重启：清内存态，从库里重新载入
    first.__resetToolUsageCacheForTest()
    first.initToolUsageStore(first.db)
    const byAgent = await first.getToolUsageByAgent()
    expect(byAgent['system-keeper']?.['asset_checkup']?.count).toBe(2)
    expect(byAgent['info-curator']?.['dashboard_feed_write']?.count).toBe(1)
    first.db.close()
  })

  it('V44 之前的老库升上来后读得回，整批归到 unknown', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumii-tool-usage-v44-'))
    vi.doMock('./client-data-root', () => ({ resolveWindowsClientDataRoot: () => dir }))
    vi.resetModules()
    const mod = await import('./tool-usage-store')
    mod.__resetToolUsageCacheForTest()

    // 造一个 V44 之前形态的库：老表结构 + 存量行，再跑 V44
    const { createPreV44TestDb, runMigration44 } = await import(
      '../../../../packages/agent-runtime/src/__tests__/helpers/sqlite-test-db'
    )
    const db = createPreV44TestDb()
    db.prepare(
      'INSERT INTO tool_usage_stats (tool_name, count, error_count, last_used_at) VALUES (?, ?, ?, ?)',
    ).run('web_search', 472, 181, 1789544009079)
    runMigration44(db)

    mod.initToolUsageStore(db)
    const byAgent = await mod.getToolUsageByAgent()
    expect(byAgent[mod.UNKNOWN_AGENT_ID]?.['web_search']).toMatchObject({
      count: 472,
      errorCount: 181,
    })
    db.close()
  })
})
