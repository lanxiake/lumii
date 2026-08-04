import React, { ReactNode } from 'react';
import clsx from 'clsx';
import styles from './Empty.module.css';

export interface EmptyProps {
  icon?: ReactNode;
  title?: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

const defaultIcon = (
  <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <line x1="9" y1="9" x2="15" y2="15" />
    <line x1="15" y1="9" x2="9" y2="15" />
  </svg>
);

const Empty: React.FC<EmptyProps> = ({
  icon = defaultIcon,
  title = '暂无数据',
  description,
  action,
  className = '',
}) => {
  return (
    <div className={clsx(styles.empty, className)}>
      <div className={styles['empty-icon']}>{icon}</div>
      {title && <h4 className={styles['empty-title']}>{title}</h4>}
      {description && <p className={styles['empty-description']}>{description}</p>}
      {action && <div className={styles['empty-action']}>{action}</div>}
    </div>
  );
};

export { Empty };
export default Empty;
