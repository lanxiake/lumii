/**
 * ImageLightbox — 轻量图片灯箱
 *
 * 用于外部 http(s)/data URL 图片的点击放大预览（本地 workspace 文件走 FilePreviewModal）。
 * 通过 portal 挂到 document.body，避免被消息区层叠上下文裁剪。
 * 支持 Esc 关闭、点击遮罩关闭。
 */

import React, { useEffect } from 'react'
import { createPortal } from 'react-dom'
import styles from './ImageLightbox.module.css'

export interface ImageLightboxProps {
  src: string
  alt?: string
  onClose: () => void
}

export const ImageLightbox: React.FC<ImageLightboxProps> = ({ src, alt, onClose }) => {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  if (typeof document === 'undefined') return null

  return createPortal(
    <div className={styles.overlay} onClick={onClose}>
      <button className={styles.closeBtn} onClick={onClose} aria-label="关闭">
        ×
      </button>
      <img
        src={src}
        alt={alt || ''}
        className={styles.image}
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body,
  )
}

export default ImageLightbox
