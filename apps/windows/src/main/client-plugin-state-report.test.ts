// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'

import {
  __resetClientPluginStateReportForTest,
  getClientPluginStateReport,
  setClientPluginStateReport,
} from './client-plugin-state-report'

describe('client-plugin-state-report', () => {
  beforeEach(() => {
    __resetClientPluginStateReportForTest()
  })

  it('只保留合法条目，坏载荷退化成空而不是变形', () => {
    setClientPluginStateReport([
      { id: 'a', name: 'A', version: '1', dir: 'a', enabled: true, state: 'loaded' },
      { name: '没有 id' },
      { id: 'b', enabled: false, state: '乱写的状态' },
      '不是对象',
    ])

    const { states, reportedAt } = getClientPluginStateReport()
    expect(states).toHaveLength(2)
    expect(states[0]).toMatchObject({ id: 'a', state: 'loaded' })
    // 非法 state 归一成 unknown；缺失字段用 id 兜底
    expect(states[1]).toMatchObject({ id: 'b', name: 'b', state: 'unknown', enabled: false })
    expect(reportedAt).toBeGreaterThan(0)
  })

  it('非数组载荷直接忽略', () => {
    setClientPluginStateReport({ id: 'a' })
    expect(getClientPluginStateReport().states).toEqual([])
  })
})
