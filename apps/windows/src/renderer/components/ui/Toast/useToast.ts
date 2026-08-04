import { useContext, useMemo } from 'react';
import { ToastContext, ToastContextType, type ToastItem } from './ToastContext';

export interface UseToastReturn {
  showToast: (toast: Omit<ToastItem, 'id'>) => string;
  hideToast: (id: string) => void;
  hideAllToasts: () => void;
  success: (message: string, duration?: number) => string;
  error: (message: string, duration?: number) => string;
  warning: (message: string, duration?: number) => string;
  info: (message: string, duration?: number) => string;
}

export function useToast(): UseToastReturn {
  const context = useContext(ToastContext);

  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }

  const { showToast, hideToast, hideAllToasts } = context;

  // 稳定返回值引用：Provider 的 showToast/hideToast/hideAllToasts 已是 useCallback 稳定，
  // 据此 memoize 整个返回对象，避免每次渲染产生新引用导致依赖 toast 的 useEffect 反复触发。
  return useMemo<UseToastReturn>(
    () => ({
      showToast,
      hideToast,
      hideAllToasts,
      success: (message: string, duration?: number) =>
        showToast({ type: 'success', message, duration }),
      error: (message: string, duration?: number) =>
        showToast({ type: 'error', message, duration }),
      warning: (message: string, duration?: number) =>
        showToast({ type: 'warning', message, duration }),
      info: (message: string, duration?: number) =>
        showToast({ type: 'info', message, duration }),
    }),
    [showToast, hideToast, hideAllToasts],
  );
}

export default useToast;
