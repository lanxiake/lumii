import React, { ReactNode } from 'react';
import clsx from 'clsx';
import styles from './Tag.module.css';

export interface TagProps {
  color?: 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info' | string;
  closable?: boolean;
  onClose?: () => void;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}

const Tag: React.FC<TagProps> = ({
  color = 'default',
  closable = false,
  onClose,
  icon,
  children,
  className = '',
}) => {
  const isCustomColor = color && !['default', 'primary', 'success', 'warning', 'error', 'info'].includes(color);

  const style: React.CSSProperties = {};
  if (isCustomColor) {
    style.backgroundColor = `${color}20`;
    style.color = color;
    style.borderColor = `${color}40`;
  }

  return (
    <span
      className={clsx(styles.tag, !isCustomColor && styles[`tag-${color}`], closable && styles['tag-closable'], className)}
      style={style}
    >
      {icon && <span className={styles['tag-icon']}>{icon}</span>}
      <span className={styles['tag-content']}>{children}</span>
      {closable && (
        <button
          className={styles['tag-close-btn']}
          onClick={onClose}
          type="button"
          aria-label="Remove tag"
        >
          ×
        </button>
      )}
    </span>
  );
};

export { Tag };
export default Tag;
