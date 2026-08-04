import React from 'react';
import clsx from 'clsx';
import styles from './Loading.module.css';

export type LoadingSize = 'sm' | 'md' | 'lg';

export interface LoadingProps {
  size?: LoadingSize;
  text?: string;
  className?: string;
}

const Loading: React.FC<LoadingProps> = ({
  size = 'md',
  text,
  className = '',
}) => {
  return (
    <div className={clsx(styles.loading, styles[`loading-${size}`], className)}>
      <div className={styles['loading-spinner']} />
      {text && <span className={styles['loading-text']}>{text}</span>}
    </div>
  );
};

export { Loading };
export default Loading;
