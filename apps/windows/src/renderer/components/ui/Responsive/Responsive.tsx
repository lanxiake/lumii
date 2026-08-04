import React, { ReactNode, useEffect, useState } from 'react';
import clsx from 'clsx';
import { breakpoints, breakpointValues, BreakpointKey } from '../../../styles/tokens/breakpoints';
import styles from './Responsive.module.css';

// Helper to get breakpoint value
const getBreakpointValue = (bp: BreakpointKey): number => breakpointValues[bp];

interface ShowProps {
  /** 在指定断点及以上显示 */
  above?: BreakpointKey;
  /** 在指定断点及以下显示 */
  below?: BreakpointKey;
  /** 仅在指定断点显示 */
  at?: BreakpointKey;
  children: ReactNode;
  /** 是否使用CSS类而非JS逻辑（SSR友好但灵活性较低） */
  useCss?: boolean;
  className?: string;
}

/**
 * Show Component - 响应式显示组件
 * 
 * 在特定断点条件下显示子元素
 * 
 * @example
 * // 在md及以上显示
 * <Show above="md"><DesktopNav /></Show>
 * 
 * // 在md及以下显示
 * <Show below="md"><MobileNav /></Show>
 * 
 * // 仅在md显示
 * <Show at="md"><TabletContent /></Show>
 */
const Show: React.FC<ShowProps> = ({
  above,
  below,
  at,
  children,
  useCss = false,
  className = '',
}) => {
  const [shouldShow, setShouldShow] = useState(!useCss);

  useEffect(() => {
    if (useCss) return;

    const checkBreakpoint = () => {
      const width = window.innerWidth;

      if (at) {
        // 仅在指定断点显示（断点范围）
        const bpValue = getBreakpointValue(at);
        const nextBp = Object.keys(breakpointValues).find(
          (key) => breakpointValues[key as BreakpointKey] > bpValue
        ) as BreakpointKey | undefined;
        
        if (nextBp) {
          setShouldShow(width >= bpValue && width < getBreakpointValue(nextBp));
        } else {
          setShouldShow(width >= bpValue);
        }
      } else if (above) {
        // 在指定断点及以上显示
        setShouldShow(width >= getBreakpointValue(above));
      } else if (below) {
        // 在指定断点及以下显示
        setShouldShow(width < getBreakpointValue(below));
      }
    };

    checkBreakpoint();
    window.addEventListener('resize', checkBreakpoint);

    return () => window.removeEventListener('resize', checkBreakpoint);
  }, [above, below, at, useCss]);

  if (useCss) {
    return (
      <span
        className={clsx(
          styles['responsive-show'],
          above && styles[`show-above-${above}`],
          below && styles[`show-below-${below}`],
          at && styles[`show-at-${at}`],
          className
        )}
      >
        {children}
      </span>
    );
  }

  if (!shouldShow) return null;

  return <>{children}</>;
};

interface HideProps {
  /** 在指定断点及以上隐藏 */
  above?: BreakpointKey;
  /** 在指定断点及以下隐藏 */
  below?: BreakpointKey;
  /** 仅在指定断点隐藏 */
  at?: BreakpointKey;
  children: ReactNode;
  /** 是否使用CSS类而非JS逻辑 */
  useCss?: boolean;
  className?: string;
}

/**
 * Hide Component - 响应式隐藏组件
 * 
 * 在特定断点条件下隐藏子元素
 * 
 * @example
 * // 在md及以上隐藏
 * <Hide above="md"><MobileNav /></Hide>
 * 
 * // 在md及以下隐藏
 * <Hide below="md"><DesktopNav /></Hide>
 */
const Hide: React.FC<HideProps> = ({
  above,
  below,
  at,
  children,
  useCss = false,
  className = '',
}) => {
  const [shouldHide, setShouldHide] = useState(false);

  useEffect(() => {
    if (useCss) return;

    const checkBreakpoint = () => {
      const width = window.innerWidth;

      if (at) {
        const bpValue = getBreakpointValue(at);
        const nextBp = Object.keys(breakpointValues).find(
          (key) => breakpointValues[key as BreakpointKey] > bpValue
        ) as BreakpointKey | undefined;
        
        if (nextBp) {
          setShouldHide(width >= bpValue && width < getBreakpointValue(nextBp));
        } else {
          setShouldHide(width >= bpValue);
        }
      } else if (above) {
        setShouldHide(width >= getBreakpointValue(above));
      } else if (below) {
        setShouldHide(width < getBreakpointValue(below));
      }
    };

    checkBreakpoint();
    window.addEventListener('resize', checkBreakpoint);

    return () => window.removeEventListener('resize', checkBreakpoint);
  }, [above, below, at, useCss]);

  if (useCss) {
    return (
      <span
        className={clsx(
          styles['responsive-hide'],
          above && styles[`hide-above-${above}`],
          below && styles[`hide-below-${below}`],
          at && styles[`hide-at-${at}`],
          className
        )}
      >
        {children}
      </span>
    );
  }

  if (shouldHide) return null;

  return <>{children}</>;
};

export { Show, Hide };
export type { ShowProps, HideProps };
export default Show;
