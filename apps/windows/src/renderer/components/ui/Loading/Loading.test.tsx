/**
 * Loading 仪式双环结构自检
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Loading } from './Loading'

describe('Loading', () => {
  it('渲染双环轨道与中心光点', () => {
    const { container } = render(<Loading />)
    expect(container.querySelector('[class*="loading-orbit"]')).toBeTruthy()
    expect(container.querySelectorAll('[class*="loading-ring"]').length).toBeGreaterThanOrEqual(2)
    expect(container.querySelector('[class*="loading-core"]')).toBeTruthy()
  })

  it('有文案时展示文本，并带 status 语义', () => {
    render(<Loading text="同步中" />)
    expect(screen.getByText('同步中')).toBeTruthy()
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', '同步中')
  })
})
