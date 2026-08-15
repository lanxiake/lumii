import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SNAPSHOT_NODE_LIMIT,
  filterSnapshotNodes,
  nextSnapshotId,
  SNAPSHOT_SCRIPT,
} from './snapshot'
import type { RawSnapshotNode } from './types'

/** 构造测试用原始节点，省略字段时使用合理默认值 */
function node(partial: Partial<RawSnapshotNode> & Pick<RawSnapshotNode, 'name'>): RawSnapshotNode {
  return {
    role: 'button',
    x: 10,
    y: 20,
    w: 100,
    h: 40,
    ...partial,
  }
}

describe('filterSnapshotNodes', () => {
  it('过滤 hidden 节点', () => {
    const result = filterSnapshotNodes([
      node({ name: '可见', hidden: false }),
      node({ name: '隐藏', hidden: true }),
    ])
    expect(result.refs).toHaveLength(1)
    expect(result.refs[0]?.name).toBe('可见')
    expect(result.truncated).toBe(false)
  })

  it('过滤零尺寸节点', () => {
    const result = filterSnapshotNodes([
      node({ name: '正常', w: 50, h: 30 }),
      node({ name: '零宽', w: 0, h: 30 }),
      node({ name: '零高', w: 50, h: 0 }),
    ])
    expect(result.refs).toHaveLength(1)
    expect(result.refs[0]?.name).toBe('正常')
  })

  it('过滤 data-app-ui-ignore 节点', () => {
    const result = filterSnapshotNodes([
      node({ name: '保留', ignored: false }),
      node({ name: '忽略', ignored: true }),
    ])
    expect(result.refs).toHaveLength(1)
    expect(result.refs[0]?.name).toBe('保留')
  })

  it('保留带 data-app-ui 标记的节点', () => {
    const result = filterSnapshotNodes([
      node({ name: '设置导航', role: 'link', appUi: 'nav-settings' }),
    ])
    expect(result.refs).toHaveLength(1)
    expect(result.refs[0]?.name).toBe('设置导航')
    expect(result.refs[0]?.role).toBe('link')
  })

  it('保留 button 节点', () => {
    const result = filterSnapshotNodes([
      node({ name: '发送', role: 'button' }),
      node({ name: '输入框', role: 'textbox' }),
    ])
    expect(result.refs.map((r) => r.name)).toEqual(['发送', '输入框'])
  })

  it('按面积降序排列并分配递增 ref', () => {
    const result = filterSnapshotNodes([
      node({ name: '小', w: 10, h: 10 }),
      node({ name: '大', w: 200, h: 100 }),
      node({ name: '中', w: 50, h: 50 }),
    ])
    expect(result.refs.map((r) => r.name)).toEqual(['大', '中', '小'])
    expect(result.refs.map((r) => r.ref)).toEqual(['e1', 'e2', 'e3'])
  })

  it('超过上限 80 时截断并标记 truncated', () => {
    const raw = Array.from({ length: 85 }, (_, i) =>
      node({ name: `节点${i}`, w: 10 + i, h: 10 }),
    )
    const result = filterSnapshotNodes(raw, { limit: DEFAULT_SNAPSHOT_NODE_LIMIT })
    expect(result.refs).toHaveLength(80)
    expect(result.truncated).toBe(true)
  })

  it('未超上限时 truncated 为 false', () => {
    const result = filterSnapshotNodes([node({ name: '唯一' })])
    expect(result.truncated).toBe(false)
  })
})

describe('nextSnapshotId', () => {
  it('从 0 起生成递增字符串 id', () => {
    const first = nextSnapshotId(0)
    expect(first.snapshotId).toBe('1')
    expect(first.nextSequence).toBe(1)

    const second = nextSnapshotId(first.nextSequence)
    expect(second.snapshotId).toBe('2')
    expect(second.nextSequence).toBe(2)
  })
})

describe('SNAPSHOT_SCRIPT', () => {
  it('为非空可注入脚本字符串', () => {
    expect(typeof SNAPSHOT_SCRIPT).toBe('string')
    expect(SNAPSHOT_SCRIPT.length).toBeGreaterThan(0)
    expect(SNAPSHOT_SCRIPT).toContain('data-app-ui-ignore')
  })
})
