/**
 * FilePreviewWindowApp — 独立预览窗渲染壳（?mode=file-preview）
 *
 * 从主进程拉取载荷，复用 FilePreviewModal 的 window 变体填满窗口。
 */

import React, { useEffect, useState, useCallback } from 'react'
import {
  FilePreviewModal,
  type FilePreviewModalProps,
} from '../components/FilePreviewModal'
import { ThemeProvider } from '../contexts/ThemeContext/ThemeContext'
import type { FilePreviewWindowPayload } from '../../shared/file-preview-window'

type PreviewProps = Omit<FilePreviewModalProps, 'onClose' | 'variant'>

/**
 * 独立窗口根组件（含主题，与主窗 --mt-* 一致）
 */
export const FilePreviewWindowApp: React.FC = () => {
  return (
    <ThemeProvider>
      <FilePreviewWindowInner />
    </ThemeProvider>
  )
}

/** 载荷加载与预览渲染 */
const FilePreviewWindowInner: React.FC = () => {
  const [props, setProps] = useState<PreviewProps | null>(null)
  const [error, setError] = useState<string | null>(null)

  /** 将 IPC 载荷映射为预览组件 props */
  const applyPayload = useCallback((payload: FilePreviewWindowPayload | null) => {
    if (!payload) {
      setError('未收到预览文件信息')
      setProps(null)
      return
    }
    setError(null)
    setProps({
      fileName: payload.fileName,
      fileId: payload.fileId,
      filePath: payload.filePath,
      userId: payload.userId,
      startLine: payload.startLine,
      endLine: payload.endLine,
      mdBasePath: payload.mdBasePath,
      editablePath: payload.editablePath,
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.electronAPI.filePreview
      .getPayload()
      .then((p) => {
        if (!cancelled) applyPayload(p)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '加载预览失败')
        }
      })

    const off = window.electronAPI.filePreview.onPayloadUpdated((p) => {
      applyPayload(p)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [applyPayload])

  const handleClose = useCallback(() => {
    void window.electronAPI.filePreview.close()
  }, [])

  if (error) {
    return (
      <div
        style={{
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--mt-fg-2, #666)',
          fontSize: 14,
          background: 'var(--mt-surface-1, #f7f4ef)',
        }}
      >
        {error}
      </div>
    )
  }

  if (!props) {
    return (
      <div
        style={{
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--mt-fg-3, #999)',
          fontSize: 13,
          background: 'var(--mt-surface-1, #f7f4ef)',
        }}
      >
        加载中…
      </div>
    )
  }

  return (
    <FilePreviewModal
      key={props.filePath ?? props.fileId ?? props.fileName}
      {...props}
      variant="window"
      onClose={handleClose}
    />
  )
}
