import React from 'react';
import { Modal } from './Modal';
import styles from './Modal.module.css';

export interface ConfirmModalProps {
  open: boolean;
  title: string;
  content: string;
  confirmText?: string;
  cancelText?: string;
  confirmVariant?: 'primary' | 'danger';
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
    <Modal open={open} title={title} footer={footer} onClose={onCancel} maskClosable={false}>
      <div className={styles['modal-confirm-content']}>{content}</div>
    </Modal>
  );
};

export default ConfirmModal;
