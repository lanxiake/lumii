import React, { ReactNode } from 'react';
import clsx from 'clsx';
import styles from './Divider.module.css';

export interface DividerProps {
  type?: 'horizontal' | 'vertical';
  orientation?: 'left' | 'right' | 'center';
  dashed?: boolean;
  children?: ReactNode;
  className?: string;
}

const Divider: React.FC<DividerProps> = ({
  type = 'horizontal',
  orientation = 'center',
  dashed = false,
  children,
  className = '',
}) => {
  const classes = clsx(
    styles.divider,
    styles[`divider-${type}`],
    children && styles['divider-with-text'],
    children && styles[`divider-text-${orientation}`],
    dashed && styles['divider-dashed'],
    className
  );

  if (type === 'vertical' || !children) {
    return <div className={classes} />;
  }

  return (
    <div className={classes}>
      <span className={styles['divider-text']}>{children}</span>
    </div>
  );
};

export { Divider };
export default Divider;
