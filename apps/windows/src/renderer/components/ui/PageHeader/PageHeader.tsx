import React, { ReactNode } from 'react';
import clsx from 'clsx';
import styles from './PageHeader.module.css';

export interface PageHeaderProps {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  subtitle,
  actions,
  className = '',
}) => {
  return (
    <div className={clsx(styles['page-header'], className)}>
      <div className={styles['page-header-content']}>
        <div className={styles['page-header-titles']}>
          <h1 className={styles['page-header-title']}>{title}</h1>
          {subtitle && <p className={styles['page-header-subtitle']}>{subtitle}</p>}
        </div>
        {actions && <div className={styles['page-header-actions']}>{actions}</div>}
      </div>
    </div>
  );
};

export default PageHeader;
