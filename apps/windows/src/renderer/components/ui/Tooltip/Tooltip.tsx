import React, { ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import type { Ref } from 'react';
import clsx from 'clsx';
import styles from './Tooltip.module.css';

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';
export type TooltipTrigger = 'hover' | 'click' | 'focus';

export interface TooltipProps {
  content: React.ReactNode;
  placement?: TooltipPlacement;
  trigger?: TooltipTrigger;
  children: ReactElement;
  delay?: number;
  className?: string;
  disabled?: boolean;
}

const Tooltip: React.FC<TooltipProps> = ({
  content,
  placement = 'top',
  trigger = 'hover',
  children,
  delay = 200,
  className = '',
  disabled = false,
}) => {
  const [visible, setVisible] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const showTooltip = useCallback(() => {
    if (disabled) return;

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = setTimeout(() => {
      setVisible(true);
    }, delay);
  }, [delay, disabled]);

  const hideTooltip = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setVisible(false);
  }, []);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const getTriggerProps = () => {
    if (trigger === 'hover') {
      return {
        onMouseEnter: showTooltip,
        onMouseLeave: hideTooltip,
      };
    }

    if (trigger === 'click') {
      return {
        onClick: () => {
          setVisible(!visible);
        },
      };
    }

    if (trigger === 'focus') {
      return {
        onFocus: showTooltip,
        onBlur: hideTooltip,
      };
    }

    return {};
  };

  // children 自带的 ref（如外部传入的 moreButtonRef）必须和内部 triggerRef 合并转发，
  // 否则 cloneElement 直接覆盖会让外部 ref 永远拿不到 DOM 节点（анchor 检测失效、
  // 外部点击误判为"点在锚点外"，菜单会在同一次点击里先关再开）。
  const originalRef = (children as { ref?: Ref<HTMLElement> }).ref;
  const mergedRef = useCallback(
    (node: HTMLElement | null) => {
      triggerRef.current = node;
      if (typeof originalRef === 'function') {
        originalRef(node);
      } else if (originalRef && typeof originalRef === 'object') {
        (originalRef as { current: HTMLElement | null }).current = node;
      }
    },
    [originalRef],
  );

  return (
    <span className={styles['tooltip-wrapper']}>
      {React.cloneElement(children, {
        ref: mergedRef,
        ...getTriggerProps(),
      })}
      {visible && (
        <div
          className={clsx(styles.tooltip, styles[`tooltip-${placement}`], visible && styles['tooltip-visible'], className)}
          role="tooltip"
        >
          <div className={styles['tooltip-content']}>{content}</div>
          <div className={styles['tooltip-arrow']} />
        </div>
      )}
    </span>
  );
};

export { Tooltip };
export default Tooltip;
