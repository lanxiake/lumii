import React, { ReactNode } from 'react';
import clsx from 'clsx';
import styles from './Skeleton.module.css';

export interface SkeletonProps {
  loading?: boolean;
  active?: boolean;
  avatar?: boolean;
  title?: boolean;
  paragraph?: boolean | { rows?: number; width?: string | string[] };
  children?: ReactNode;
  className?: string;
}

const Skeleton: React.FC<SkeletonProps> = ({
  loading = true,
  active = true,
  avatar = false,
  title = true,
  paragraph = true,
  children,
  className = '',
}) => {
  if (!loading) return <>{children}</>;

  const paragraphConfig = typeof paragraph === 'object' ? paragraph : {};
  const rows = paragraphConfig.rows ?? 3;
  const widths = paragraphConfig.width ?? [];
  const widthArray = Array.isArray(widths) ? widths : [widths];

  return (
    <div className={clsx(styles.skeleton, active && styles['skeleton-active'], className)}>
      {avatar && (
        <div className={styles['skeleton-header']}>
          <div className={styles['skeleton-avatar']} />
          <div className={styles['skeleton-header-content']}>
            {title && <div className={styles['skeleton-title']} />}
          </div>
        </div>
      )}
      {!avatar && title && <div className={styles['skeleton-title']} />}
      {paragraph && (
        <div className={styles['skeleton-paragraph']}>
          {Array.from({ length: rows }).map((_, index) => {
            const width = widthArray[index] || (index === rows - 1 ? '60%' : '100%');
            return <div key={index} className={styles['skeleton-row']} style={{ width }} />;
          })}
        </div>
      )}
    </div>
  );
};

export { Skeleton };
export default Skeleton;
