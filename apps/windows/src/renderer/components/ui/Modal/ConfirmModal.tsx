import React from 'react';
import { Modal, type ModalProps } from './Modal';
import styles from './Modal.module.css';

export interface ConfirmModalProps {
  open: boolean;
  title: string;
  content: string;
  confirmText?: string;
  cancelText?: string;
  confirmVariant?: 'primary' | 'danger';
  /** 从设置中心等高 z-index 浮层内唤起时传 elevated */
  layer?: ModalProps['layer'];
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * ConfirmModal - 通用确认对话框
 * 
 * 替代原生 confirm() 的模态框组件
 */
export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  open,
  title,
  content,
  confirmText = '确认',
  cancelText = '取消',
  confirmVariant = 'primary',
  layer,
  onConfirm,
  onCancel,
}) => {
  const footer = (
    <>
      <button className={styles['modal-btn-secondary']} onClick={onCancel}>
        {cancelText}
      </button>
      <button
        className={
          confirmVariant === 'danger'
            ? styles['modal-btn-danger']
            : styles['modal-btn-primary']
        }
        onClick={onConfirm}
      >
        {confirmText}
      </button>
    </>
  );

  return (
    <Modal open={open} title={title} footer={footer} onClose={onCancel} maskClosable={false} layer={layer}>
      <div className={styles['modal-confirm-content']}>{content}</div>
    </Modal>
  );
};

export default ConfirmModal;
