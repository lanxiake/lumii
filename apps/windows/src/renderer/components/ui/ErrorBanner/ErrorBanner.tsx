import React from 'react';
import clsx from 'clsx';
import { Button } from '../Button/Button';
import styles from './ErrorBanner.module.css';

export interface ErrorBannerProps {
  message: string;
  onRetry?: () => void;
  onDismiss?: () => void;
  className?: string;
}

export const ErrorBanner: React.FC<ErrorBannerProps> = ({
  message,
  onRetry,
  onDismiss,
  className = '',
}) => {
  return (
    <div className={clsx(styles['error-banner'], className)} role="alert">
      <span className={styles['error-icon']}>❌</span>
      <span className={styles['error-message']}>{message}</span>
      <div className={styles['error-actions']}>
        {onRetry && (
          <Button size="sm" variant="secondary" onClick={onRetry}>重试</Button>
        )}
        {onDismiss && (
          <button className={styles['error-dismiss']} onClick={onDismiss} aria-label="关闭">✕</button>
        )}
      </div>
    </div>
  );
};

export default ErrorBanner;
