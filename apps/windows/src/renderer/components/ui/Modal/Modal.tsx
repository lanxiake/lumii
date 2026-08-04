import React, { ReactNode } from 'react';
import styles from './Modal.module.css';

export interface ModalProps {
  open?: boolean;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose?: () => void;
  maskClosable?: boolean;
  width?: number | string;
}

const Modal: React.FC<ModalProps> = ({
  open = false,
  title,
  children,
  footer,
  onClose,
  maskClosable = true,
  width = 420,
}) => {
  if (!open) return null;

  const handleMaskClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && maskClosable) onClose?.();
  };

  const style: React.CSSProperties = {
    maxWidth: typeof width === 'number' ? `${width}px` : width,
  };

  return (
    <div className={styles['modal-overlay']} onClick={handleMaskClick}>
      <div className={styles.modal} style={style}>
        {title && (
          <div className={styles['modal-header']}>
            <h3 className={styles['modal-title']}>{title}</h3>
            {onClose && (
              <button className={styles['modal-close']} onClick={onClose}>×</button>
            )}
          </div>
        )}
        <div className={styles['modal-body']}>{children}</div>
        {footer && <div className={styles['modal-footer']}>{footer}</div>}
      </div>
    </div>
  );
};

export { Modal };
export default Modal;
