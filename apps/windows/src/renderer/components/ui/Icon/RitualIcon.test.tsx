/**
 * RitualIcon 尺寸与仪式 class 自检
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Zap } from 'lucide-react'
import { RitualIcon, RITUAL_ICON_SIZE_PX } from './RitualIcon'

describe('RitualIcon', () => {
  it('md 档默认 16px，strokeWidth 1.75', () => {
    const { container } = render(<RitualIcon icon={Zap} />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('width', String(RITUAL_ICON_SIZE_PX.md))
    expect(svg).toHaveAttribute('height', String(RITUAL_ICON_SIZE_PX.md))
    expect(svg).toHaveAttribute('stroke-width', '1.75')
  })

  it('ritual 时带 mt-icon-ritual', () => {
    const { container } = render(<RitualIcon icon={Zap} ritual />)
    expect(container.querySelector('svg')?.classList.contains('mt-icon-ritual')).toBe(true)
  })
})
