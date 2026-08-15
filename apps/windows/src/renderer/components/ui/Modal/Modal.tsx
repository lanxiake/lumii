import React, { ReactNode, useEffect } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import styles from './Modal.module.css';

export interface ModalProps {
  open?: boolean;
  title?: string;
  /** 自定义顶栏，优先级高于 title */
  header?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose?: () => void;
  maskClosable?: boolean;
  width?: number | string;
  /** 预设尺寸：hub 为大尺寸设置中心 */
  size?: 'default' | 'hub';
  /** 面板额外 class */
  className?: string;
  /** 正文区额外 class */
  bodyClassName?: string;
  /** 是否显示右上角关闭按钮（有 onClose 时默认显示） */
  showClose?: boolean;
  /**
   * 叠层提升：
   * - elevated：普通嵌套弹窗
   * - hub：设置中心
   * - aboveHub：设置中心内再开的子弹窗（定时任务/流水线等）
   */
  layer?: 'default' | 'elevated' | 'hub' | 'aboveHub';
}

/**
 * Modal - 通用弹窗
 *
 * 通过 portal 挂到 document.body，避免被对话工作台等局部 stacking context 压住。
 */
const Modal: React.FC<ModalProps> = ({
  open = false,
  title,
  header,
  children,
  footer,
  onClose,
  maskClosable = true,
  width = 420,
  size = 'default',
  className,
  bodyClassName,
  showClose = true,
  layer,
}) => {
  useEffect(() => {
    if (!open || !onClose) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const handleMaskClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && maskClosable) onClose?.();
  };

  const isHub = size === 'hub';
  const resolvedLayer = layer ?? (isHub ? 'hub' : 'default');
  const style: React.CSSProperties = isHub
    ? {}
    : { maxWidth: typeof width === 'number' ? `${width}px` : width };

  const showHeaderRow = Boolean(header) || Boolean(title) || (showClose && onClose);

  const overlay = (
    <div
      className={clsx(
        styles['modal-overlay'],
        resolvedLayer === 'elevated' && styles['modal-overlay--elevated'],
        resolvedLayer === 'hub' && styles['modal-overlay--hub'],
        resolvedLayer === 'aboveHub' && styles['modal-overlay--aboveHub'],
      )}
      onClick={handleMaskClick}
    >
      <div
        className={clsx(styles.modal, isHub && styles['modal--hub'], className)}
        style={style}
        role="dialog"
        aria-modal="true"
      >
        {showHeaderRow && (
          <div className={clsx(styles['modal-header'], isHub && styles['modal-header--hub'])}>
            {header ?? (title ? <h3 className={styles['modal-title']}>{title}</h3> : <span />)}
            {showClose && onClose && (
              <button
                type="button"
                className={styles['modal-close']}
                onClick={onClose}
                aria-label="关闭"
              >
                ×
              </button>
            )}
          </div>
        )}
        <div className={clsx(styles['modal-body'], isHub && styles['modal-body--hub'], bodyClassName)}>
          {children}
        </div>
        {footer && <div className={styles['modal-footer']}>{footer}</div>}
      </div>
    </div>
  );

  if (typeof document === 'undefined') return overlay;
  return createPortal(overlay, document.body);
};

export { Modal };
export default Modal;
