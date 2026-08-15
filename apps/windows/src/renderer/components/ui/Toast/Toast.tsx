import React, { useEffect } from 'react';
import clsx from 'clsx';
import { ToastItem } from './ToastContext';
import styles from './Toast.module.css';

export interface ToastProps extends ToastItem {
  onClose?: (id: string) => void;
}

/**
 * 全局 Toast 条目：支持可选操作按钮
 */
const Toast: React.FC<ToastProps> = ({
  id,
  type = 'info',
  message,
  duration = 3000,
  actionLabel,
  onAction,
  onClose,
}) => {
  useEffect(() => {
    if (duration > 0) {
      const timer = setTimeout(() => {
        onClose?.(id);
      }, duration);

      return () => clearTimeout(timer);
    }
  }, [duration, id, onClose]);

  const getIcon = () => {
    switch (type) {
      case 'success':
        return '✓';
      case 'error':
        return '✕';
      case 'warning':
        return '!';
      case 'info':
      default:
        return 'i';
    }
  };

  return (
    <div className={clsx(styles.toast, styles[`toast-${type}`])} role="alert">
      <span className={styles['toast-icon']}>{getIcon()}</span>
      <span className={styles['toast-message']}>{message}</span>
      {actionLabel && onAction && (
        <button
          type="button"
          className={styles['toast-action']}
          onClick={() => {
            onAction();
            onClose?.(id);
          }}
        >
          {actionLabel}
        </button>
      )}
      <button
        className={styles['toast-close']}
        onClick={() => onClose?.(id)}
        aria-label="Close"
      >
        ×
      </button>
    </div>
  );
};

export { Toast };
export default Toast;
