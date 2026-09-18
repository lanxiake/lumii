/**
 * 个人记忆的**身份持久性**——条目元数据 `<!--m:id date-->` 不能被任何路径抹掉。
 *
 * 事故（2026-09-18 实测）：定时任务 `companion-memory-deep` 整理后直接写回、没做对账，
 * 9 条条目的身份在 12:01 一次性清零。四条写入路径里只有 `FileMemoryHandler` 做了对账。
 *
 * 本文件守两条纪律：
 * 1. **凡落盘的版本都要过对账**（写入点、同步导出、同步导入）
 * 2. 对账是幂等的——重复跑不会把身份换来换去
 */
import { describe, it, expect } from 'vitest'
import { reconcilePersonalMemory, parsePersonalMemory } from '@mtbot/agent-runtime'

const DOC_WITH_IDS = `## 基本信息

- 用户是程序员。 <!--m:aaaa1111bbbb2222 2026-09-18-->

## 交互偏好

- 规则：先给结论再列重点。原因：先理解再聚焦。 <!--m:cccc3333dddd4444 2026-09-18-->
- 规则：改代码前先给计划。原因：避免不可逆改动。 <!--m:eeee5555ffff6666 2026-09-18-->
`

/** 模拟"旧版本设备 / 未经对账的写入"产出的文档：内容相同但没有元数据 */
const DOC_WITHOUT_IDS = `## 基本信息

- 用户是程序员。

## 交互偏好

- 规则：先给结论再列重点。原因：先理解再聚焦。
- 规则：改代码前先给计划。原因：避免不可逆改动。
`

describe('个人记忆身份持久性', () => {
  it('未经对账的写入会产出一份无身份的文档（事故形态）', () => {
    expect(parsePersonalMemory(DOC_WITHOUT_IDS).entries.every((e) => !e.id)).toBe(true)
    expect(parsePersonalMemory(DOC_WITHOUT_IDS).entries).toHaveLength(3)
  })

  it('对账给无身份的文档补发 id（模拟"同步导入了旧版本"）', () => {
    const r = reconcilePersonalMemory(DOC_WITHOUT_IDS, DOC_WITH_IDS)
    const entries = parsePersonalMemory(r.content).entries
    expect(entries).toHaveLength(3)
    expect(entries.every((e) => e.id.length > 0)).toBe(true)
    expect(entries.every((e) => e.createdAt.length === 10)).toBe(true)
  })

  it('对账是幂等的：对带 id 的文档再对一次，id 不变', () => {
    const once = reconcilePersonalMemory(DOC_WITH_IDS, DOC_WITH_IDS).content
    const twice = reconcilePersonalMemory(once, once).content
    expect(parsePersonalMemory(twice).entries.map((e) => e.id)).toEqual(
      parsePersonalMemory(DOC_WITH_IDS).entries.map((e) => e.id),
    )
  })

  it('对账不会因为走了两遍就把条目数变多或变少', () => {
    const once = reconcilePersonalMemory(DOC_WITH_IDS, DOC_WITH_IDS)
    expect(once.added).toBe(0)
    expect(once.removed).toBe(0)
    expect(once.kept).toBe(3)
    expect(parsePersonalMemory(once.content).entries).toHaveLength(3)
  })

  it('"sync 副本无 id、本地有 id"的往返不会丢身份（导出→导入）', () => {
    // 导出：本地 → 对账 → sync
    const exported = reconcilePersonalMemory(DOC_WITHOUT_IDS, DOC_WITH_IDS).content
    // 导入：sync → 对账 → 本地
    const imported = reconcilePersonalMemory(exported, DOC_WITH_IDS).content
    const ids = parsePersonalMemory(imported).entries.map((e) => e.id)
    expect(ids).toEqual(['aaaa1111bbbb2222', 'cccc3333dddd4444', 'eeee5555ffff6666'])
  })
})
