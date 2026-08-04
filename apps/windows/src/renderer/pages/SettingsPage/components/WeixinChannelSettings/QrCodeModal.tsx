import React from 'react'
import { Modal } from '../../../../components/ui/Modal/Modal'
import { Button } from '../../../../components/ui/Button/Button'

interface QrCodeModalProps {
  open: boolean
  qrcodeDataUrl: string | null
  onClose: () => void
}

export const QrCodeModal: React.FC<QrCodeModalProps> = ({ open, qrcodeDataUrl, onClose }) => {
  return (
    <Modal
      open={open}
      title="扫码登录微信"
      onClose={onClose}
      width={320}
      footer={
        <Button variant="ghost" onClick={onClose}>
          取消
        </Button>
      }
    >
      <div style={{ textAlign: 'center', padding: '8px 0' }}>
        {qrcodeDataUrl ? (
          <img
            src={qrcodeDataUrl}
            alt="微信登录二维码"
            style={{ width: 256, height: 256, display: 'block', margin: '0 auto' }}
          />
        ) : (
          <div style={{ width: 256, height: 256, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto', background: '#f5f5f5', borderRadius: 8 }}>
            <span style={{ color: '#999', fontSize: 14 }}>正在获取二维码...</span>
          </div>
        )}
        <p style={{ marginTop: 12, color: '#666', fontSize: 13 }}>
          请使用微信扫描二维码登录
        </p>
      </div>
    </Modal>
  )
}
