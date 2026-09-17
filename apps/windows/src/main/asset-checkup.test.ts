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

function makeDeps(
  rows: readonly MemoryRow[],
  markdown: string | null = '# 用户记忆\n## 基本信息\n- 称呼：老张\n',
  /** 命名空间分布（默认与 rows 自洽：全部 local-user） */
  namespaces: readonly { user_id: string; c: number }[] = [{ user_id: 'local-user', c: rows.length }],
  /** 宫殿状态（P2-3）：默认与索引自洽的 3 段 */
  palace: { segments?: number; withId?: number; active?: number; fts?: number } = {},
) {
  const p = { segments: 3, withId: 3, active: 3, fts: 3, ...palace }
  const db = {
    prepare: (sql: string) => ({
      all: () => (sql.includes('GROUP BY user_id') ? namespaces : rows),
      get: () => {
        if (sql.includes('FROM memory_segments')) return { total: p.segments, withId: p.withId }
        if (sql.includes('SUM(deleted_at IS NULL)')) return { active: p.active, tombstoned: 0 }
        if (sql.includes('FROM palace_drawers_fts')) return { c: p.fts }
        return undefined
      },
    }),
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
    // 段落管线项在未注入统计时为 skipped（不假装检查过），故排除它
    expect(result.checks.filter((c) => c.key !== 'memory:segment-pipeline').every((c) => c.status === 'ok')).toBe(true)
    expect(checkOf(result, 'memory:segment-pipeline').status).toBe('skipped')
  })

  it('宫殿：索引与主表不一致时报 issue（检索会静默漏结果）', async () => {
    const deps = makeDeps([row()], undefined, undefined, { active: 73, fts: 1 })
    const check = checkOf(await runMemoryCheckup(deps), 'memory:palace-coverage')
    expect(check.status).toBe('issue')
    expect(check.detail).toContain('派生索引与主表不一致')
    expect(check.detail).toContain('73')
  })

  it('宫殿：本进程归档失败计数 > 0 时报 issue（写入点自己数的）', async () => {
    const deps = {
      ...makeDeps([row()]),
      getPalaceStats: () => ({
        attempted: 5,
        archived: 3,
        notStored: 1,
        failed: 1,
        lastError: { at: '2026-09-17T11:00:00.000Z', message: 'database is locked' },
      }),
    }
    const check = checkOf(await runMemoryCheckup(deps), 'memory:palace-coverage')
    expect(check.status).toBe('issue')
    expect(check.detail).toContain('归档失败 1 次')
    expect(check.detail).toContain('未落库 1 段')
    expect(check.candidates?.[0].label).toContain('database is locked')
  })

  it('宫殿：历史欠账（老段没 id）不算 issue，只报覆盖率', async () => {
    // 老段的原文所在会话已被删、或本身是碎段，补不回来——推断式的判据会变成永远报警的假警报
    const deps = makeDeps([row()], undefined, undefined, {
      segments: 101,
      withId: 73,
      active: 73,
      fts: 73,
    })
    const check = checkOf(await runMemoryCheckup(deps), 'memory:palace-coverage')
    expect(check.status).toBe('ok')
    expect(check.detail).toContain('73/101 = 72.3%')
  })

  it('宫殿：本进程全部归档成功时报 ok 并带上计数', async () => {
    const deps = {
      ...makeDeps([row()]),
      getPalaceStats: () => ({ attempted: 4, archived: 4, notStored: 0, failed: 0, lastError: null }),
    }
    const check = checkOf(await runMemoryCheckup(deps), 'memory:palace-coverage')
    expect(check.status).toBe('ok')
    expect(check.detail).toContain('本进程归档 4/4 段')
  })

  it('宫殿：宫殿表不可读（迁移未跑）时 skipped，不假装检查过', async () => {
    const db = {
      prepare: (sql: string) => ({
        all: () => (sql.includes('GROUP BY user_id') ? [{ user_id: 'local-user', c: 1 }] : [row()]),
        get: () => {
          if (sql.includes('FROM memory_segments')) throw new Error('no such table: palace_drawers')
          return undefined
        },
      }),
    } as unknown as DatabaseAdapter
    const deps = { db, readUserMemory: async () => null, now: () => NOW }
    const check = checkOf(await runMemoryCheckup(deps), 'memory:palace-coverage')
    expect(check.status).toBe('skipped')
    expect(check.detail).toContain('V49')
  })

  it('段落管线：有失败时报 issue，放弃段单独提示', async () => {
    const deps = {
      ...makeDeps([row()]),
      getSegmentStats: () => ({
        summarised: 12,
        emptyCandidates: 3,
        noText: 1,
        failed: 2,
        abandoned: 1,
        lastError: { at: '2026-09-17T09:00:00.000Z', message: 'LLM 连接超时' },
      }),
    }
    const check = checkOf(await runMemoryCheckup(deps), 'memory:segment-pipeline')
    expect(check.status).toBe('issue')
    expect(check.detail).toContain('1 个段因反复失败被放弃')
    expect(check.candidates?.[0].label).toContain('LLM 连接超时')
  })

  it('段落管线：无失败时报 ok 并给出产出计数', async () => {
    const deps = {
      ...makeDeps([row()]),
      getSegmentStats: () => ({
        summarised: 8,
        emptyCandidates: 2,
        noText: 0,
        failed: 0,
        abandoned: 0,
        lastError: null,
      }),
    }
    const check = checkOf(await runMemoryCheckup(deps), 'memory:segment-pipeline')
    expect(check.status).toBe('ok')
    expect(check.detail).toContain('已总结 8 段')
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
    // 形状取自库中真实残片：被截断的字符串 + 悬空的 JSON 对象闭合
    const rows = [row({ id: 'x', content: '我的幸运数字是 47。只回复\\"好的\\"\\"}]' })]
    const check = checkOf(await runMemoryCheckup(makeDeps(rows)), 'memory:json-residue')
    expect(check.status).toBe('issue')
    expect(check.candidates?.[0].id).toBe('x')
  })

  it('含完整 JSON 字面量的正常记忆不算残迹（判据与写入门共用）', async () => {
    // 旧模式 /["!\]}]{2,}\s*$/ 会把这两条误报成残迹
    const rows = [
      row({ id: 'a', content: '配置项是 ["a","b"]，注意顺序' }),
      row({ id: 'b', content: '接口返回 {"code":0}，表示成功' }),
    ]
    const check = checkOf(await runMemoryCheckup(makeDeps(rows)), 'memory:json-residue')
    expect(check.status).toBe('ok')
  })

  it('命名空间：全部 local-user 时 ok', async () => {
    const check = checkOf(await runMemoryCheckup(makeDeps([row()])), 'memory:namespace-scope')
    expect(check.status).toBe('ok')
  })

  it('命名空间：出现非 local-user 的行时报 issue（幽灵命名空间回归断言）', async () => {
    const namespaces = [
      { user_id: 'local-user', c: 220 },
      { user_id: 'local', c: 24 },
    ]
    const check = checkOf(
      await runMemoryCheckup(makeDeps([row()], undefined, namespaces)),
      'memory:namespace-scope',
    )
    expect(check.status).toBe('issue')
    expect(check.detail).toContain('24 条')
    expect(check.candidates?.map((c) => c.id)).toEqual(['local'])
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
    // 段落管线项在未注入统计时为 skipped，不计入 checkedCount
    expect(result.checkedCount).toBe(8) // 7 项机械检查 + 命名空间 + 宫殿（P2-3）
    expect(result.summary).toContain('8 项')
    expect(result.summary).toContain('1 项')
  })
})
