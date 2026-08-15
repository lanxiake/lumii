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

  it('保留 button 节点，表单控件排在普通按钮之前', () => {
    const result = filterSnapshotNodes([
      node({ name: '发送', role: 'button' }),
      node({ name: '输入框', role: 'textbox' }),
    ])
    expect(result.refs.map((r) => r.name)).toEqual(['输入框', '发送'])
  })

  it('过滤被弹层遮挡的节点', () => {
    const result = filterSnapshotNodes([
      node({ name: '弹窗按钮', inDialog: true }),
      node({ name: '被遮挡的侧栏项', occluded: true }),
    ])
    expect(result.refs.map((r) => r.name)).toEqual(['弹窗按钮'])
  })

  it('同层内按阅读顺序（先上后下、先左后右）排列并分配递增 ref', () => {
    const result = filterSnapshotNodes([
      node({ name: '第二行', x: 10, y: 200 }),
      node({ name: '第一行右', x: 300, y: 100 }),
      node({ name: '第一行左', x: 10, y: 100 }),
    ])
    expect(result.refs.map((r) => r.name)).toEqual(['第一行左', '第一行右', '第二行'])
    expect(result.refs.map((r) => r.ref)).toEqual(['e1', 'e2', 'e3'])
  })

  it('弹层内表单控件优先于背景元素，避免被截断丢掉', () => {
    const result = filterSnapshotNodes([
      node({ name: '背景会话', y: 100 }),
      node({ name: '弹层普通按钮', y: 500, inDialog: true }),
      node({ name: '弹层输入框', role: 'textbox', y: 900, inDialog: true }),
      node({ name: '带标记入口', y: 50, appUi: 'nav-settings' }),
    ])
    expect(result.refs.map((r) => r.name)).toEqual([
      '弹层输入框',
      '弹层普通按钮',
      '带标记入口',
      '背景会话',
    ])
  })

  it('回传输入框当前值、placeholder 与下拉框选项', () => {
    const result = filterSnapshotNodes([
      node({ name: 'API Key', role: 'textbox', value: '', placeholder: 'sk-...' }),
      node({
        name: 'OpenAI 兼容',
        role: 'combobox',
        value: 'openai',
        options: [
          { value: 'openai', label: 'OpenAI 兼容' },
          { value: 'anthropic', label: 'Anthropic' },
        ],
      }),
    ])
    expect(result.refs[0]).toMatchObject({ value: '', placeholder: 'sk-...' })
    expect(result.refs[1]?.options).toHaveLength(2)
  })

  it(`超过上限 ${DEFAULT_SNAPSHOT_NODE_LIMIT} 时截断并标记 truncated`, () => {
    const raw = Array.from({ length: DEFAULT_SNAPSHOT_NODE_LIMIT + 5 }, (_, i) =>
      node({ name: `节点${i}`, y: i * 20 }),
    )
    const result = filterSnapshotNodes(raw, { limit: DEFAULT_SNAPSHOT_NODE_LIMIT })
    expect(result.refs).toHaveLength(DEFAULT_SNAPSHOT_NODE_LIMIT)
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

  it('采集遮挡状态、输入值与下拉选项', () => {
    expect(SNAPSHOT_SCRIPT).toContain('isOccluded')
    expect(SNAPSHOT_SCRIPT).toContain('getSelectOptions')
    expect(SNAPSHOT_SCRIPT).toContain('aria-modal')
    expect(SNAPSHOT_SCRIPT).toContain("type === 'password'")
  })
})
