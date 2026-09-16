/**
 * 维护体检报告存储测试。
 *
 * 用真实 node:sqlite 内存库跑 V42 的建表语句，验的是存储契约本身：
 * 读写往返、跨期差分的语义、脏输入的兜底。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createTestSqliteAdapter } from '../../../../packages/agent-runtime/src/__tests__/helpers/sqlite-test-db'
import type { DatabaseAdapter } from '@mtbot/agent-runtime'
import { MIGRATIONS } from '../../../../packages/agent-runtime/src/storage/schema'
import {
  __testables,
  diffFindings,
  listMaintenanceReports,
  readLatestMaintenanceReport,
  setMaintenanceReportDb,
  writeMaintenanceReport,
  type MaintenanceFinding,
} from './maintenance-report-store'

function createReportDb(): DatabaseAdapter {
  const db = createTestSqliteAdapter()
  const v42 = MIGRATIONS.find(([v]) => v === 42)
  if (!v42) throw new Error('缺少 V42 迁移')
  db.exec(v42[1])
  return db
}

afterEach(() => {
  setMaintenanceReportDb(null)
})

const finding = (key: string, title = `问题 ${key}`): MaintenanceFinding => ({
  key,
  severity: 'medium',
  title,
})

describe('maintenance-report-store', () => {
  it('写入后能读回最新一期，字段原样保留', async () => {
    const db = createReportDb()
    setMaintenanceReportDb(db)

    const written = await writeMaintenanceReport({
      agentId: 'system-keeper',
      scope: 'memory',
      summary: '工作记忆 228 条，发现 2 处重复',
      findings: [
        { key: 'memory:duplicate', severity: 'high', title: '两条重复', evidence: 'id=a/b', suggestion: '删一条' },
      ],
      checked: ['Wiki：无重复页'],
      trigger: 'manual',
      conversationId: 'conv-1',
    })

    const latest = readLatestMaintenanceReport()
    expect(latest?.id).toBe(written.id)
    expect(latest?.scope).toBe('memory')
    expect(latest?.summary).toBe('工作记忆 228 条，发现 2 处重复')
    expect(latest?.findings).toHaveLength(1)
    expect(latest?.findings[0]).toMatchObject({ key: 'memory:duplicate', severity: 'high' })
    expect(latest?.checked).toEqual(['Wiki：无重复页'])
    expect(latest?.conversationId).toBe('conv-1')
    db.close()
  })

  it('列表按时间倒序，limit 生效', async () => {
    const db = createReportDb()
    setMaintenanceReportDb(db)
    await writeMaintenanceReport({ agentId: 'system-keeper', summary: '第一期' })
    await writeMaintenanceReport({ agentId: 'system-keeper', summary: '第二期' })
    await writeMaintenanceReport({ agentId: 'system-keeper', summary: '第三期' })

    const list = listMaintenanceReports({ limit: 2 })
    expect(list).toHaveLength(2)
    expect(list[0].summary).toBe('第三期')
    expect(readLatestMaintenanceReport()?.summary).toBe('第三期')
    db.close()
  })

  it('summary 为空时拒绝写入（没有结论的报告等于没写）', async () => {
    const db = createReportDb()
    setMaintenanceReportDb(db)
    await expect(writeMaintenanceReport({ agentId: 'system-keeper', summary: '   ' })).rejects.toThrow(
      /summary/,
    )
    expect(listMaintenanceReports()).toHaveLength(0)
    db.close()
  })

  it('模型漏填 key 时用 title 兜底派生，不丢条目', async () => {
    const db = createReportDb()
    setMaintenanceReportDb(db)
    await writeMaintenanceReport({
      agentId: 'system-keeper',
      summary: '有一条没给 key',
      findings: [{ severity: 'low', title: '用户指南有段过期' }],
    })
    const latest = readLatestMaintenanceReport()
    expect(latest?.findings).toHaveLength(1)
    expect(latest?.findings[0].key).toBe('misc:用户指南有段过期')
    expect(latest?.findings[0].severity).toBe('low')
    db.close()
  })

  it('没有 title 的条目被丢弃，其余照常写入', async () => {
    const db = createReportDb()
    setMaintenanceReportDb(db)
    await writeMaintenanceReport({
      agentId: 'system-keeper',
      summary: '一条空标题',
      findings: [{ key: 'x' } as never, finding('memory:duplicate')],
    })
    expect(readLatestMaintenanceReport()?.findings).toHaveLength(1)
    db.close()
  })

  it('未注入 db 时读取返回空、写入抛明确错误（不静默丢报告）', async () => {
    expect(listMaintenanceReports()).toEqual([])
    expect(readLatestMaintenanceReport()).toBeNull()
    await expect(writeMaintenanceReport({ agentId: 'system-keeper', summary: 'x' })).rejects.toThrow(
      /未就绪/,
    )
  })

  it('findings 存成坏 JSON 时按「没有发现」处理，不打挂整张卡片', async () => {
    const db = createReportDb()
    setMaintenanceReportDb(db)
    await writeMaintenanceReport({ agentId: 'system-keeper', summary: '坏数据' })
    db.prepare(`UPDATE maintenance_reports SET findings = 'not json'`).run()
    const latest = readLatestMaintenanceReport()
    expect(latest?.findings).toEqual([])
    expect(latest?.summary).toBe('坏数据')
    db.close()
  })
})

describe('diffFindings 跨期差分', () => {
  it('key 相同算仍在，新 key 算新增，消失的 key 算已解决', () => {
    const previous = [finding('a'), finding('b'), finding('c')]
    const current = [finding('b'), finding('c'), finding('d')]
    const diff = diffFindings(previous, current)
    expect(diff.added.map((f) => f.key)).toEqual(['d'])
    expect(diff.persisting.map((f) => f.key)).toEqual(['b', 'c'])
    expect(diff.resolved.map((f) => f.key)).toEqual(['a'])
  })

  it('身份用 key 而非 title：措辞变了不算新增', () => {
    const previous: MaintenanceFinding[] = [{ key: 'memory:duplicate', severity: 'medium', title: '有两处重复' }]
    const current: MaintenanceFinding[] = [
      { key: 'memory:duplicate', severity: 'high', title: '重复条目已增至两处（措辞变了）' },
    ]
    const diff = diffFindings(previous, current)
    expect(diff.added).toHaveLength(0)
    expect(diff.resolved).toHaveLength(0)
    expect(diff.persisting).toHaveLength(1)
    // 展示取本期的措辞与严重度
    expect(diff.persisting[0].severity).toBe('high')
  })

  it('上期没问题、这期有问题时全是新增', () => {
    const diff = diffFindings([], [finding('a')])
    expect(diff.added).toHaveLength(1)
    expect(diff.resolved).toHaveLength(0)
  })
})

describe('输入归一化', () => {
  it('scope / trigger / severity 取非法值时回落到安全缺省', async () => {
    const db = createReportDb()
    setMaintenanceReportDb(db)
    await writeMaintenanceReport({
      agentId: 'system-keeper',
      scope: 'nonsense',
      summary: '越界取值',
      trigger: 'hacker',
      findings: [{ key: 'k', severity: 'critical' as never, title: 't' }],
    })
    const latest = readLatestMaintenanceReport()
    expect(latest?.scope).toBe('full')
    expect(latest?.trigger).toBe('manual')
    expect(latest?.findings[0].severity).toBe('medium')
    db.close()
  })

  it('超长文本被截断而不是整条丢弃', () => {
    const long = 'x'.repeat(500)
    expect(__testables.clampText(long, 120)).toHaveLength(120)
    expect(__testables.clampText(long, 120).endsWith('…')).toBe(true)
  })
})
