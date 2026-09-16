/**
 * 资产体检（机械检查项）测试。
 *
 * 这些判定是「模型只做判断」分工的地基：它们必须是确定的——同一条数据两次跑出同一结论，
 * 阈值边界（正好 2400 字、正好 30 天）也要钉死，否则报告会随口径漂移。
 */

import { describe, expect, it } from 'vitest'
import type { DatabaseAdapter } from '@mtbot/agent-runtime'
import {
  PROFILE_BUDGET_CHARS,
  STALE_DAYS,
  runMemoryCheckup,
  type MemoryRow,
} from './asset-checkup'

const NOW = Date.parse('2026-09-16T00:00:00.000Z')

function row(over: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: 'm1',
    agent_id: 'assistant',
    category: 'general',
    content: '一条正常的工作记忆',
    importance: 0.8,
    created_at: '2026-09-15T00:00:00.000Z',
    last_used: '2026-09-15T00:00:00.000Z',
    is_archived: 0,
    ...over,
  }
}

function makeDeps(rows: readonly MemoryRow[], markdown: string | null = '# 用户记忆\n## 基本信息\n- 称呼：老张\n') {
  const db = {
    prepare: () => ({ all: () => rows }),
  } as unknown as DatabaseAdapter
  return { db, readUserMemory: async () => markdown, now: () => NOW }
}

const checkOf = (r: Awaited<ReturnType<typeof runMemoryCheckup>>, key: string) =>
  r.checks.find((c) => c.key === key)!

describe('runMemoryCheckup', () => {
  it('干净的数据：机械项全 ok，0 命中', async () => {
    const result = await runMemoryCheckup(makeDeps([row()]))
    expect(result.issueCount).toBe(0)
    expect(result.summary).toContain('均未发现问题')
    expect(result.checks.every((c) => c.status === 'ok')).toBe(true)
  })

  it('偏好层超预算：报出实际字数与超出量', async () => {
    const long = `# 用户记忆\n## 基本信息\n${'字'.repeat(PROFILE_BUDGET_CHARS + 100)}`
    const result = await runMemoryCheckup(makeDeps([row()], long))
    const check = checkOf(result, 'memory:profile-budget')
    expect(check.status).toBe('issue')
    expect(check.detail).toContain('超出')
  })

  it('正好等于预算不算超（边界钉死）', async () => {
    const exact = '字'.repeat(PROFILE_BUDGET_CHARS)
    const check = checkOf(await runMemoryCheckup(makeDeps([row()], exact)), 'memory:profile-budget')
    expect(check.status).toBe('ok')
  })

  it('偏好层有内容但空章节要报出来', async () => {
    const md = '# 用户记忆\n## 基本信息\n- 称呼：老张\n\n## 空的章节\n\n## 另一个空的\n'
    const check = checkOf(await runMemoryCheckup(makeDeps([row()], md)), 'memory:profile-budget')
    expect(check.status).toBe('issue')
    expect(check.candidates?.map((c) => c.id)).toEqual(['section:空的章节', 'section:另一个空的'])
  })

  it('偏好层文件不存在：skipped 而不是 ok（不能把「没查」说成「没事」）', async () => {
    const check = checkOf(await runMemoryCheckup(makeDeps([row()], null)), 'memory:profile-budget')
    expect(check.status).toBe('skipped')
  })

  it('内容逐字相同（含空白差异）算重复，并给出两侧候选', async () => {
    const rows = [
      row({ id: 'a', content: '我写代码习惯用 pnpm' }),
      row({ id: 'b', content: '我写代码习惯用  pnpm ' }),
    ]
    const check = checkOf(await runMemoryCheckup(makeDeps(rows)), 'memory:working-duplicates')
    expect(check.status).toBe('issue')
    expect(check.candidates?.map((c) => c.id).sort()).toEqual(['a', 'b'])
  })

  it('JSON 序列化残迹', async () => {
    const rows = [row({ id: 'x', content: '我的幸运数字是 47。只回复"好的"}]' })]
    const check = checkOf(await runMemoryCheckup(makeDeps(rows)), 'memory:json-residue')
    expect(check.status).toBe('issue')
    expect(check.candidates?.[0].id).toBe('x')
  })

  it('指令式话术残留', async () => {
    const rows = [row({ id: 'y', content: '青花瓷是周杰伦的歌，请只回复"已了解"' })]
    const check = checkOf(await runMemoryCheckup(makeDeps(rows)), 'memory:instruction-residue')
    expect(check.status).toBe('issue')
    expect(check.candidates?.[0].id).toBe('y')
  })

  it('长期未用且低重要度才算过期（正好 30 天不算）', async () => {
    const boundary = new Date(NOW - STALE_DAYS * 86_400_000).toISOString()
    const older = new Date(NOW - (STALE_DAYS + 1) * 86_400_000).toISOString()

    const clean = checkOf(
      await runMemoryCheckup(makeDeps([row({ last_used: boundary, importance: 0.1 })])),
      'memory:stale',
    )
    expect(clean.status).toBe('ok')

    const stale = checkOf(
      await runMemoryCheckup(makeDeps([row({ id: 'z', last_used: older, importance: 0.1 })])),
      'memory:stale',
    )
    expect(stale.status).toBe('issue')
    expect(stale.candidates?.[0].id).toBe('z')
  })

  it('重要度高就不算过期，哪怕很久没用', async () => {
    const older = new Date(NOW - 200 * 86_400_000).toISOString()
    const check = checkOf(
      await runMemoryCheckup(makeDeps([row({ last_used: older, importance: 0.9 })])),
      'memory:stale',
    )
    expect(check.status).toBe('ok')
  })

  it('过短条目算噪声', async () => {
    const check = checkOf(await runMemoryCheckup(makeDeps([row({ id: 't', content: '好' })])), 'memory:tiny-entries')
    expect(check.status).toBe('issue')
  })

  it('summary 同时给出检查项数与命中数', async () => {
    const result = await runMemoryCheckup(makeDeps([row({ id: 't', content: '好' })]))
    expect(result.issueCount).toBe(1)
    expect(result.checkedCount).toBe(6)
    expect(result.summary).toContain('6 项')
    expect(result.summary).toContain('1 项')
  })
})
