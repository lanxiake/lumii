import React, { ReactNode } from 'react';
import clsx from 'clsx';
import styles from './Badge.module.css';

export interface BadgeProps {
  count?: number;
  max?: number;
  dot?: boolean;
  status?: 'success' | 'error' | 'warning' | 'info' | 'processing' | 'default';
  text?: string;
  offset?: [number, number];
  children?: ReactNode;
  className?: string;
}

const Badge: React.FC<BadgeProps> = ({
  count,
  max = 99,
  dot = false,
  status,
  text,
  offset,
  children,
  className = '',
}) => {
  const getDisplayCount = () => {
    if (count === undefined) return null;
    if (count <= 0) return null;
    if (count > max) return `${max}+`;
    return count;
  };

  const displayCount = getDisplayCount();

  const badgeClass = clsx(
    styles.badge,
    dot && styles['badge-dot'],
    status && styles[`badge-status-${status}`],
    !children && styles['badge-standalone'],
    className
  );

  const style: React.CSSProperties = {};
  if (offset && children) {
    style.right = offset[0];
    style.top = offset[1];
  }

  if (!children) {
    if (status) {
      return (
        <span className={badgeClass} style={style}>
          <span className={styles['badge-status-dot']} />
          {text && <span className={styles['badge-status-text']}>{text}</span>}
        </span>
      );
    }
    return (
      <span className={badgeClass} style={style}>
        {displayCount}
      </span>
    );
  }

  return (
    <span className={styles['badge-wrapper']}>
      {children}
      {(displayCount !== null || dot) && (
        <span className={badgeClass} style={style}>
          {!dot && displayCount}
        </span>
      )}
    </span>
  );
};

export { Badge };
export default Badge;
