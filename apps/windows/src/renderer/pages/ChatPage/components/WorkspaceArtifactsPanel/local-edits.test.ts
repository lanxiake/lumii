/**
 * 本地编辑合并进 Agent 台账（P2 T1）：不新增重复卡、不伪造 turn、保留折叠规则。
 */
import { describe, expect, it } from 'vitest'
import type { LocalArtifactEdit } from '../../../../../shared/artifact-edit-types'
import { buildArtifactLedger, type LedgerMessageLike } from './ledger'
import { mergeLocalEdits } from './local-edits'

function edit(overrides: Partial<LocalArtifactEdit> = {}): LocalArtifactEdit {
  return {
    editId: 'edit-1',
    sessionKey: 'conv-1',
    path: 'outputs/demo/doc.md',
    action: 'manual',
    scope: { type: 'text-range', start: 0, end: 1 },
    at: 2000,
    bytes: 10,
    ...overrides,
  }
}

function assistant(
  id: string,
  timestamp: number,
  paths: string[],
): LedgerMessageLike {
  return {
    id,
    role: 'assistant',
    timestamp,
    fileChanges: paths.map((path) => ({ path, status: 'modified' as const })),
  }
}

describe('mergeLocalEdits', () => {
  it('已存在的路径只更新时间与来源，不新增卡片', () => {
    const ledger = buildArtifactLedger([
      { id: 'u1', role: 'user', timestamp: 900, text: '做一份文档' },
      assistant('m1', 1000, ['outputs/demo/doc.md']),
    ])
    const merged = mergeLocalEdits(ledger, [edit()])

    const items = merged.groups.flatMap((group) => group.deliverables)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      path: 'outputs/demo/doc.md',
      turnId: 'm1',
      timestamp: 2000,
      origin: 'local',
    })
    expect(merged.counts.deliverables).toBe(1)
    // 组时间跟着更新，排序仍按最新
    expect(merged.groups[0]?.timestamp).toBe(2000)
  })

  it('本地新增路径建卡；没有对应任务组时建「本地修改」组，turnId 为空', () => {
    const ledger = buildArtifactLedger([
      assistant('m1', 1000, ['outputs/demo/doc.md']),
    ])
    const merged = mergeLocalEdits(ledger, [
      edit({ editId: 'edit-2', path: 'outputs/other/notes.md', at: 3000 }),
    ])

    const group = merged.groups.find((item) => item.key === 'outputs/other')
    expect(group?.label).toBe('本地修改')
    expect(group?.deliverables[0]).toMatchObject({
      path: 'outputs/other/notes.md',
      turnId: '',
      origin: 'local',
      status: 'modified',
    })
    expect(merged.counts.deliverables).toBe(2)
  })

  it('本地编辑早于 Agent 回合时，不以本地为准', () => {
    const ledger = buildArtifactLedger([assistant('m1', 5000, ['outputs/demo/doc.md'])])
    const merged = mergeLocalEdits(ledger, [edit({ at: 2000 })])
    const item = merged.groups.flatMap((group) => group.deliverables)[0]
    expect(item?.timestamp).toBe(5000)
    expect(item?.origin).toBeUndefined()
  })

  it('同一路径多条本地编辑只取最新一条', () => {
    const ledger = buildArtifactLedger([assistant('m1', 1000, ['outputs/demo/doc.md'])])
    const merged = mergeLocalEdits(ledger, [
      edit({ editId: 'old', at: 2000 }),
      edit({ editId: 'new', at: 5000 }),
    ])
    const items = merged.groups.flatMap((group) => group.deliverables)
    expect(items).toHaveLength(1)
    expect(items[0]?.timestamp).toBe(5000)
  })

  it('internal / ephemeral 路径不进入台账', () => {
    const ledger = buildArtifactLedger([assistant('m1', 1000, ['outputs/demo/doc.md'])])
    const merged = mergeLocalEdits(ledger, [
      edit({ editId: 'a', path: '.lumii/cache/x.md' }),
      edit({ editId: 'b', path: 'temp/x.md' }),
    ])
    expect(merged.counts.deliverables).toBe(1)
    expect(merged.groups).toHaveLength(1)
  })

  it('保留中间产物折叠（>=20 项）与 versions 映射', () => {
    const paths = Array.from({ length: 20 }, (_, index) => `outputs/demo/parts/cut-${index}.png`)
    const ledger = buildArtifactLedger([assistant('m1', 1000, paths)])
    expect(ledger.groups[0]?.intermediates).toHaveLength(20)

    const merged = mergeLocalEdits(ledger, [
      edit({ editId: 'edit-part', path: 'outputs/demo/parts/cut-3.png', at: 4000 }),
    ])
    const group = merged.groups[0]
    expect(group?.intermediates).toHaveLength(20)
    expect(group?.deliverables).toHaveLength(0)
    expect(merged.versions.get('outputs/demo/parts/cut-3.png')).toBe(
      ledger.versions.get('outputs/demo/parts/cut-3.png'),
    )
  })

  it('变体：新路径建卡并带上 derivedFrom 来源', () => {
    const ledger = buildArtifactLedger([
      assistant('m1', 1000, ['outputs/demo/cover.png']),
    ])
    const merged = mergeLocalEdits(ledger, [
      edit({
        editId: 'edit-v',
        path: 'outputs/demo/cover-variant-153012.png',
        action: 'variant',
        scope: { type: 'image-variant' },
        at: 3000,
        derivedFrom: 'outputs/demo/cover.png',
      }),
    ])
    const group = merged.groups[0]
    expect(group?.deliverables.map((item) => item.path)).toEqual([
      'outputs/demo/cover-variant-153012.png',
      'outputs/demo/cover.png',
    ])
    const variant = group?.deliverables.find((item) => item.path.includes('-variant-'))
    expect(variant).toMatchObject({
      kind: 'image',
      origin: 'local',
      status: 'modified',
      derivedFrom: 'outputs/demo/cover.png',
      turnId: '',
    })
    // 变体是新文件：不给原路径伪造版本
    expect(merged.versions.get('outputs/demo/cover.png')).toBe(
      ledger.versions.get('outputs/demo/cover.png'),
    )
  })

  it('没有本地编辑时原样返回，避免无谓重建', () => {
    const ledger = buildArtifactLedger([assistant('m1', 1000, ['outputs/demo/doc.md'])])
    expect(mergeLocalEdits(ledger, [])).toBe(ledger)
  })
})
