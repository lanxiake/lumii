import { describe, expect, it } from 'vitest'

import {
  A2UI_LIMITS,
  looksLikeA2UISpec,
  normalizeA2UISpec,
  normalizeChart,
  normalizeDataTable,
} from './validate'

describe('normalizeChart', () => {
  it('接受合法规格', () => {
    const chart = normalizeChart({
      type: 'Chart',
      id: 'c1',
      chartType: 'bar',
      title: '销售',
      data: { labels: ['Q1', 'Q2'], datasets: [{ label: '收入', values: [1, 2] }] },
    })
    expect(chart).not.toBeNull()
    expect(chart?.data.labels).toEqual(['Q1', 'Q2'])
    expect(chart?.data.datasets[0]?.values).toEqual([1, 2])
  })

  it('数字字符串按数值收窄', () => {
    const chart = normalizeChart({
      type: 'Chart',
      chartType: 'line',
      data: { labels: ['a', 'b'], datasets: [{ label: 'x', values: ['10', '20'] }] },
    })
    expect(chart?.data.datasets[0]?.values).toEqual([10, 20])
  })

  // 回归：模型把 labels 写成字符串时 data.labels.map 抛 TypeError → 整页崩
  it('labels 不是数组时整张图丢弃，而不是抛错', () => {
    expect(
      normalizeChart({ type: 'Chart', chartType: 'line', data: { labels: 'Q1,Q2', datasets: [] } }),
    ).toBeNull()
  })

  it('datasets 是对象时整张图丢弃', () => {
    expect(
      normalizeChart({
        type: 'Chart',
        chartType: 'line',
        data: { labels: ['a'], datasets: { label: 'x', values: [1] } },
      }),
    ).toBeNull()
  })

  it('值含非数字时整条数据集丢弃（不补零画错图）', () => {
    const chart = normalizeChart({
      type: 'Chart',
      chartType: 'line',
      data: {
        labels: ['a', 'b'],
        datasets: [
          { label: 'bad', values: [1, 'abc'] },
          { label: 'good', values: [1, 2] },
        ],
      },
    })
    expect(chart?.data.datasets.map((d) => d.label)).toEqual(['good'])
  })

  it('未知 chartType 丢弃', () => {
    expect(
      normalizeChart({
        type: 'Chart',
        chartType: 'radar',
        data: { labels: ['a'], datasets: [{ label: 'x', values: [1] }] },
      }),
    ).toBeNull()
  })

  it('点数超限被截断到上限', () => {
    const n = A2UI_LIMITS.maxPoints + 50
    const chart = normalizeChart({
      type: 'Chart',
      chartType: 'line',
      data: { labels: Array.from({ length: n }, (_, i) => `l${i}`), datasets: [{ label: 'x', values: Array.from({ length: n }, () => 1) }] },
    })
    expect(chart?.data.labels).toHaveLength(A2UI_LIMITS.maxPoints)
    expect(chart?.data.datasets[0]?.values).toHaveLength(A2UI_LIMITS.maxPoints)
  })

  it('数据集缺 label 时补默认名', () => {
    const chart = normalizeChart({
      type: 'Chart',
      chartType: 'line',
      data: { labels: ['a'], datasets: [{ values: [1] }] },
    })
    expect(chart?.data.datasets[0]?.label).toBe('系列1')
  })
})

describe('normalizeDataTable', () => {
  it('接受合法规格', () => {
    const t = normalizeDataTable({
      type: 'DataTable',
      columns: [{ key: 'name', label: '名称' }, { key: 'v', label: '值', sortable: true }],
      rows: [{ name: 'A', v: 1 }],
    })
    expect(t?.columns).toHaveLength(2)
    expect(t?.rows).toHaveLength(1)
  })

  // 回归：rows 缺失时 sortedRows.length 抛错
  it('rows 不是数组时丢弃', () => {
    expect(normalizeDataTable({ type: 'DataTable', columns: [{ key: 'a' }], rows: null })).toBeNull()
  })

  it('columns 不是数组时丢弃', () => {
    expect(normalizeDataTable({ type: 'DataTable', columns: 'a,b', rows: [{}] })).toBeNull()
  })

  it('没有可用列时丢弃', () => {
    expect(normalizeDataTable({ type: 'DataTable', columns: [{ label: '无 key' }], rows: [{}] })).toBeNull()
  })

  it('行不是对象时被过滤', () => {
    const t = normalizeDataTable({
      type: 'DataTable',
      columns: [{ key: 'a' }],
      rows: [1, 'str', null, { a: 1 }],
    })
    expect(t?.rows).toEqual([{ a: 1 }])
  })

  it('pageSize 非法时回落默认，过大被钳制', () => {
    expect(normalizeDataTable({ type: 'DataTable', columns: [{ key: 'a' }], rows: [{}], pageSize: 0 })?.pageSize).toBeUndefined()
    expect(normalizeDataTable({ type: 'DataTable', columns: [{ key: 'a' }], rows: [{}], pageSize: 9999 })?.pageSize).toBe(200)
  })

  it('行数/列数超限被截断', () => {
    const t = normalizeDataTable({
      type: 'DataTable',
      columns: Array.from({ length: A2UI_LIMITS.maxColumns + 5 }, (_, i) => ({ key: `c${i}` })),
      rows: Array.from({ length: A2UI_LIMITS.maxRows + 5 }, () => ({ c0: 1 })),
    })
    expect(t?.columns).toHaveLength(A2UI_LIMITS.maxColumns)
    expect(t?.rows).toHaveLength(A2UI_LIMITS.maxRows)
  })
})

describe('normalizeA2UISpec', () => {
  it('过滤掉已下线的组件类型', () => {
    const spec = normalizeA2UISpec({
      components: [
        { type: 'MathVisualizer', expression: 'x' },
        { type: 'DataTable', columns: [{ key: 'a' }], rows: [{ a: 1 }] },
      ],
    })
    expect(spec?.components).toHaveLength(1)
    expect(spec?.components[0]?.type).toBe('DataTable')
  })

  it('全部无效时返回 null（调用方降级为 markdown）', () => {
    expect(normalizeA2UISpec({ components: [{ type: 'Text', content: 'x' }] })).toBeNull()
  })

  it('id 按下标重写，保证稳定且唯一', () => {
    const raw = {
      components: [
        { type: 'DataTable', columns: [{ key: 'a' }], rows: [{ a: 1 }] },
        { type: 'DataTable', columns: [{ key: 'b' }], rows: [{ b: 2 }] },
      ],
    }
    const a = normalizeA2UISpec(raw)
    const b = normalizeA2UISpec(raw)
    expect(a?.components.map((c) => c.id)).toEqual(['c0', 'c1'])
    // 同一输入两次解析 id 必须一致，否则子树每次重挂、Table 状态被重置
    expect(b?.components.map((c) => c.id)).toEqual(a?.components.map((c) => c.id))
  })

  it('组件数超限被截断', () => {
    const spec = normalizeA2UISpec({
      components: Array.from({ length: A2UI_LIMITS.maxComponents + 5 }, () => ({
        type: 'DataTable',
        columns: [{ key: 'a' }],
        rows: [{ a: 1 }],
      })),
    })
    expect(spec?.components).toHaveLength(A2UI_LIMITS.maxComponents)
  })
})

describe('looksLikeA2UISpec', () => {
  it('非对象 / 无 components 返回 false', () => {
    expect(looksLikeA2UISpec(null)).toBe(false)
    expect(looksLikeA2UISpec({})).toBe(false)
    expect(looksLikeA2UISpec({ components: [] })).toBe(false)
  })

  it('普通 JSON（无已知组件）返回 false', () => {
    expect(looksLikeA2UISpec({ components: [{ type: 'Config' }] })).toBe(false)
  })

  it('含 Chart / DataTable 返回 true', () => {
    expect(looksLikeA2UISpec({ components: [{ type: 'Chart' }] })).toBe(true)
    expect(looksLikeA2UISpec({ components: [{ type: 'DataTable' }] })).toBe(true)
  })
})
