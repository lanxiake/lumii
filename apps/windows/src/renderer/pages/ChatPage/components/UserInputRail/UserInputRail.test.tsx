/**
 * 右侧条纹导轨的判据：
 * 1. 不超过一条用户输入时不渲染（一条没有导航价值）；
 * 2. 悬停提示是前 20 个字符——压平空白、超长补省略号；
 * 3. 当前所在消息的条纹要能被辨识（aria-current），点击回传消息 id。
 */
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { UserInputRail } from './UserInputRail'

afterEach(cleanup)

describe('UserInputRail', () => {
  it('只有一条用户输入时不显示', () => {
    const { container } = render(
      <UserInputRail items={[{ id: 'm1', text: '第一句' }]} onJump={vi.fn()} />,
    )
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  it('超过一条时每条一个条纹，点击回传消息 id', () => {
    const onJump = vi.fn()
    const { getAllByRole } = render(
      <UserInputRail
        items={[
          { id: 'm1', text: '第一句' },
          { id: 'm2', text: '第二句' },
        ]}
        onJump={onJump}
      />,
    )
    const buttons = getAllByRole('button')
    expect(buttons).toHaveLength(2)
    buttons[1]!.click()
    expect(onJump).toHaveBeenCalledWith('m2')
  })

  it('悬停时立刻给出前 20 字的提示（不等原生 title 的系统延迟）', () => {
    const { getAllByRole, getByRole, queryByRole } = render(
      <UserInputRail
        items={[
          { id: 'm1', text: '短句' },
          { id: 'm2', text: '帮我看看这个报错\n   顺便把日志也分析一下' },
        ]}
        onJump={vi.fn()}
      />,
    )
    expect(queryByRole('tooltip')).toBeNull()

    fireEvent.mouseEnter(getAllByRole('button')[1]!)
    // 换行被压成单个空格
    expect(getByRole('tooltip').textContent).toBe('帮我看看这个报错 顺便把日志也分析一下')
  })

  it('超过 20 个字符时截断并补省略号', () => {
    const { getAllByRole, getByRole } = render(
      <UserInputRail
        items={[
          { id: 'm1', text: '短句' },
          { id: 'm2', text: '一二三四五六七八九十一二三四五六七八九十多出来的部分' },
        ]}
        onJump={vi.fn()}
      />,
    )
    fireEvent.mouseEnter(getAllByRole('button')[1]!)
    expect(getByRole('tooltip').textContent).toBe('一二三四五六七八九十一二三四五六七八九十…')
  })

  it('当前所在消息的条纹标 aria-current，其余不标', () => {
    const { getAllByRole } = render(
      <UserInputRail
        items={[
          { id: 'm1', text: '第一句' },
          { id: 'm2', text: '第二句' },
        ]}
        onJump={vi.fn()}
        activeId="m2"
      />,
    )
    const buttons = getAllByRole('button')
    expect(buttons[0]!.getAttribute('aria-current')).toBeNull()
    expect(buttons[1]!.getAttribute('aria-current')).toBe('true')
  })
})
