import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import { A2UIRenderer } from './index'
import { PluginErrorBoundary } from '../../components/slots/PluginErrorBoundary'
import { registerCard, __resetCardRegistryForTest } from './card-registry'
import type { A2UISpec } from './types'

// recharts 在 jsdom 下没有布局尺寸，ResponsiveContainer/XAxis 会直接抛 invariant；
// 图表的数据形状由 validate.test.ts 覆盖，这里只验「规格能走到组件」与错误隔离，
// 所以把 recharts 换成透传壳（显式列出用到的导出，不用 Proxy：后者会让 vitest 卡住）。
vi.mock('recharts', () => {
  const shell = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    ResponsiveContainer: shell,
    LineChart: shell,
    Line: shell,
    BarChart: shell,
    Bar: shell,
    AreaChart: shell,
    Area: shell,
    PieChart: shell,
    Pie: shell,
    Cell: shell,
    ScatterChart: shell,
    Scatter: shell,
    XAxis: shell,
    YAxis: shell,
    CartesianGrid: shell,
    Tooltip: shell,
    Legend: shell,
  }
})

const tableSpec: A2UISpec = {
  components: [
    {
      type: 'DataTable',
      id: 'c0',
      columns: [
        { key: 'name', label: '名称', sortable: true },
        { key: 'val', label: '值' },
      ],
      rows: [
        { name: '项目A', val: 42 },
        { name: '项目B', val: 7 },
      ],
    },
  ],
}

describe('A2UIRenderer', () => {
  it('渲染 DataTable 的表头与行', () => {
    render(<A2UIRenderer spec={tableSpec} />)
    expect(screen.getByText('名称')).toBeTruthy()
    expect(screen.getByText('项目A')).toBeTruthy()
    expect(screen.getByText('42')).toBeTruthy()
  })

  it('渲染 Chart 的标题', () => {
    render(
      <A2UIRenderer
        spec={{
          components: [
            {
              type: 'Chart',
              id: 'c0',
              chartType: 'line',
              title: '用户增长',
              data: { labels: ['1月', '2月'], datasets: [{ label: '用户数', values: [1, 2] }] },
            },
          ],
        }}
      />,
    )
    expect(screen.getByText('用户增长')).toBeTruthy()
  })

  it('空规格不渲染任何内容', () => {
    const { container } = render(<A2UIRenderer spec={{ components: [] }} />)
    expect(container.firstChild).toBeNull()
  })

  it('未知组件类型显示兜底文案而不是抛错', () => {
    const spec = { components: [{ type: 'Mystery', id: 'x' }] } as unknown as A2UISpec
    render(<A2UIRenderer spec={spec} />)
    expect(screen.getByText(/未知组件类型/)).toBeTruthy()
  })

  // 回归：插件卡片抛错曾能让整个客户端变成「界面加载失败」
  it('插件卡片抛错时被错误边界隔离，同页其他内容照常', () => {
    __resetCardRegistryForTest()
    const Boom: React.FC = () => {
      throw new Error('card exploded')
    }
    registerCard('acme.boom', Boom as never)
    const spec = { components: [{ type: 'acme.boom', id: 'x' }] } as unknown as A2UISpec
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(
      <>
        <span>旁边的正常内容</span>
        <PluginErrorBoundary label="a2ui">
          <A2UIRenderer spec={spec} />
        </PluginErrorBoundary>
      </>,
    )

    expect(screen.getByText('旁边的正常内容')).toBeTruthy()
    expect(screen.getByText(/渲染失败/)).toBeTruthy()
    spy.mockRestore()
    __resetCardRegistryForTest()
  })
})
