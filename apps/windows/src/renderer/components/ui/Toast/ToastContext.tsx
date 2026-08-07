import React, { createContext, useCallback, useState } from 'react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

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
