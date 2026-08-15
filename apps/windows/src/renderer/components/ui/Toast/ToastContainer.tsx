import React, { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { ToastContext, ToastContextType, ToastItem } from './ToastContext';
import { Toast } from './Toast';
import styles from './Toast.module.css';

export interface ToastProviderProps {
  children: React.ReactNode;
  maxCount?: number;
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'top-center' | 'bottom-center';
}

export const ToastProvider: React.FC<ToastProviderProps> = ({
  children,
  maxCount = 5,
  position = 'top-right',
}) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const showToast = useCallback(
    (toast: Omit<ToastItem, 'id'>): string => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const newToast: ToastItem = { ...toast, id };

      setToasts((prev) => {
        const newToasts = [...prev, newToast];
        if (newToasts.length > maxCount) {
          return newToasts.slice(newToasts.length - maxCount);
        }
        return newToasts;
      });

      return id;
    },
    [maxCount]
  );

  const hideToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const hideAllToasts = useCallback(() => {
    setToasts([]);
  }, []);

  const contextValue: ToastContextType = {
    toasts,
    showToast,
    hideToast,
    hideAllToasts,
  };

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      {createPortal(
        <div className={`${styles['toast-container']} ${styles[`toast-container-${position}`]}`}>
          {toasts.map((toast) => (
            <Toast
              key={toast.id}
              {...toast}
              onClose={() => hideToast(toast.id)}
            />
          ))}
        </div>,
        document.body
      )}
    </ToastContext.Provider>
  );
};

export default ToastProvider;
