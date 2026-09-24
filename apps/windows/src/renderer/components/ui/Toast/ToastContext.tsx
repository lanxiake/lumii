import { createContext } from 'react';

type ToastType = 'success' | 'error' | 'warning' | 'info';

/**
 * 提示条默认展示时长（毫秒）。
 * 10 秒：短提示（3 秒）常常还没读完就消失，尤其是带操作按钮或较长文案的提示。
 */
export const TOAST_DEFAULT_DURATION_MS = 10_000;

export interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
  /** 可选操作按钮文案 */
  actionLabel?: string;
  /** 点击操作按钮回调（点击后会关闭 toast） */
  onAction?: () => void;
}

export interface ToastContextType {
  toasts: ToastItem[];
  showToast: (toast: Omit<ToastItem, 'id'>) => string;
  hideToast: (id: string) => void;
  hideAllToasts: () => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

export { ToastContext };
