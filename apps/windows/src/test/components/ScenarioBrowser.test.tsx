/**
 * ScenarioBrowser（预置场景全量浏览弹窗）测试。
 *
 * 守四件事：
 * - 默认铺开**全部**预置场景（数量与数据源一致，不写死）；
 * - 按触发方式分组，且**每条只出现一次**（分类互斥，漏了或重了都看得见）；
 * - 搜索同时匹配名称与正文 —— 用户记得「要个京都有啥玩的」但忘了场景叫什么，靠的就是正文命中；
 * - 点卡片回传该场景并关闭。
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

const { ScenarioBrowser } = await import('../../renderer/components/ScenarioBrowser')
const { ALL_SCENARIOS, SCENARIO_GROUPS, FEATURED_LABELS, getFeaturedScenarios } = await import(
  '../../renderer/data/preset-scenarios'
)

const noop = () => {}

describe('ScenarioBrowser', () => {
  it('默认铺开全部预置场景', () => {
    render(<ScenarioBrowser open onClose={noop} onSelect={noop} />)

    expect(screen.getByText('全部场景')).toBeInTheDocument()
    expect(screen.getByText(`${ALL_SCENARIOS.length} / ${ALL_SCENARIOS.length}`)).toBeInTheDocument()
  })

  it('按触发方式分组，且每条场景只出现一次', () => {
    render(<ScenarioBrowser open onClose={noop} onSelect={noop} />)

    for (const group of SCENARIO_GROUPS) {
      expect(screen.getByText(group.label)).toBeInTheDocument()
    }

    // 互斥：所有卡片加起来 = 总数，没有重复渲染的
    const cards = SCENARIO_GROUPS.flatMap((g) => ALL_SCENARIOS.filter((s) => s.group === g.id))
    expect(cards).toHaveLength(ALL_SCENARIOS.length)
    expect(new Set(cards.map((c) => c.label)).size).toBe(ALL_SCENARIOS.length)
  })

  it('搜索按名称命中，且只剩命中项所在的组', () => {
    render(<ScenarioBrowser open onClose={noop} onSelect={noop} />)

    fireEvent.change(screen.getByLabelText('搜索场景'), { target: { value: '菜谱' } })

    expect(screen.getByRole('button', { name: /菜谱推荐/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /设置定时提醒/ })).not.toBeInTheDocument()
    // 「菜谱推荐」属「现在就做」，另两组应整组消失
    expect(screen.queryByText('定时自动')).not.toBeInTheDocument()
    expect(screen.queryByText('长期设定')).not.toBeInTheDocument()
  })

  it('搜索也能命中 prompt 正文（记不住场景名的入口）', () => {
    render(<ScenarioBrowser open onClose={noop} onSelect={noop} />)

    // 「京都」只出现在「旅行规划」的 prompt 正文里，不在任何场景名里
    fireEvent.change(screen.getByLabelText('搜索场景'), { target: { value: '京都' } })

    expect(screen.getByRole('button', { name: /旅行规划/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /菜谱推荐/ })).not.toBeInTheDocument()
  })

  it('无匹配时给出空态，而不是一片空白', () => {
    render(<ScenarioBrowser open onClose={noop} onSelect={noop} />)

    fireEvent.change(screen.getByLabelText('搜索场景'), { target: { value: 'zzz-不存在' } })

    expect(screen.getByText(/没有匹配/)).toBeInTheDocument()
    expect(screen.queryAllByRole('button')).toHaveLength(1) // 只剩右上角关闭
  })

  it('点领域标签只看这一类，点「全部」还原', () => {
    render(<ScenarioBrowser open onClose={noop} onSelect={noop} />)

    fireEvent.click(screen.getByRole('button', { name: /^生活/ }))
    expect(screen.getByRole('button', { name: /菜谱推荐/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /写工作邮件/ })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '全部' }))
    expect(screen.getByRole('button', { name: /写工作邮件/ })).toBeInTheDocument()
  })

  it('点卡片：回传该场景并关闭弹窗', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(<ScenarioBrowser open onClose={onClose} onSelect={onSelect} />)

    fireEvent.click(screen.getByRole('button', { name: /设置定时提醒/ }))

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0]![0]).toMatchObject({ label: '设置定时提醒' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('精选场景清单', () => {
  /**
   * `getFeaturedScenarios()` 是按 label 查表，**查不到会静默丢掉**——改一次标签文案
   * 就可能悄悄少一条精选，界面上看不出来。这条用例把这种静默失败钉死。
   */
  it('FEATURED_LABELS 每一条都能在 ALL_SCENARIOS 里查到', () => {
    expect(getFeaturedScenarios()).toHaveLength(FEATURED_LABELS.length)
  })
})
