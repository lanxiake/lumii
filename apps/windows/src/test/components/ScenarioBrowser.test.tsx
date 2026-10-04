/**
 * ScenarioBrowser（预置场景全量浏览弹窗）测试。
 *
 * 守三件事：
 * - 默认铺开**全部**预置场景（数量与数据源一致，不写死）；
 * - 搜索同时匹配名称与正文 —— 用户记得「要个京都有啥玩的」但忘了场景叫什么，靠的就是正文命中；
 * - 点卡片回传该场景并关闭。
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

const { ScenarioBrowser } = await import('../../renderer/components/ScenarioBrowser')
const { ALL_SCENARIOS } = await import('../../renderer/data/preset-scenarios')

const noop = () => {}

describe('ScenarioBrowser', () => {
  it('默认铺开全部预置场景', () => {
    render(<ScenarioBrowser open onClose={noop} onSelect={noop} />)

    expect(screen.getByText('全部场景')).toBeInTheDocument()
    expect(screen.getByText(`${ALL_SCENARIOS.length} / ${ALL_SCENARIOS.length}`)).toBeInTheDocument()
  })

  it('搜索按名称命中', () => {
    render(<ScenarioBrowser open onClose={noop} onSelect={noop} />)

    fireEvent.change(screen.getByLabelText('搜索场景'), { target: { value: '菜谱' } })

    expect(screen.getByRole('button', { name: /菜谱推荐/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /设置定时提醒/ })).not.toBeInTheDocument()
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
