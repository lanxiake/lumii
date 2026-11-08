import { forwardRef, type ComponentType } from 'react'
import clsx from 'clsx'
import type { LucideProps } from 'lucide-react'

export type RitualIconSize = 'sm' | 'md' | 'lg'

const SIZE_PX: Record<RitualIconSize, number> = {
  sm: 14,
  md: 16,
  lg: 20,
}

export interface RitualIconProps extends Omit<LucideProps, 'size' | 'ref'> {
  /** lucide 图标组件 */
  icon: ComponentType<LucideProps>
  /** 尺寸档位；默认 md=16 */
  size?: RitualIconSize | number
  /** 是否叠加仪式描边光感 */
  ritual?: boolean
}

/**
 * 图标薄封装：统一默认 stroke 与尺寸档，可选仪式光感。
 * 不全仓库强制替换；新代码与关键路径优先使用。
 */
export const RitualIcon = forwardRef<SVGSVGElement, RitualIconProps>(
  function RitualIcon({ icon: Icon, size = 'md', ritual = false, className, strokeWidth, ...rest }, ref) {
    const px = typeof size === 'number' ? size : SIZE_PX[size]
    return (
      <Icon
        ref={ref}
        size={px}
        strokeWidth={strokeWidth ?? 1.75}
        className={clsx(ritual && 'mt-icon-ritual', className)}
        aria-hidden={rest['aria-label'] || rest['aria-labelledby'] ? undefined : true}
        {...rest}
      />
    )
  },
)

export { SIZE_PX as RITUAL_ICON_SIZE_PX }
