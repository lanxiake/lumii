/**
 * FilePreviewWindowApp — 独立预览窗渲染壳（?mode=file-preview）
 *
 * 从主进程拉取载荷，复用 FilePreviewModal 的 window 变体填满窗口。
 */

import React, { useEffect, useState, useCallback } from 'react'
import {
  FilePreviewModal,
  type FilePreviewModalProps,
} from '../../../../renderer/components/FilePreviewModal'
import { ThemeProvider } from '../../../../renderer/contexts/ThemeContext/ThemeContext'
import {
  closeFilePreviewWindow,
  getFilePreviewPayload,
  navigateFilePreviewWindow,
  onFilePreviewPayloadUpdated,
} from '../../../../renderer/services/file-preview-service'
import type { FilePreviewWindowPayload } from '../../../../shared/file-preview-window'

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
  /** 可左右翻页时才显示 ‹ ›（清单由主窗随载荷带过来） */
  const [canNavigate, setCanNavigate] = useState(false)

  /** 将 IPC 载荷映射为预览组件 props */
  const applyPayload = useCallback((payload: FilePreviewWindowPayload | null) => {
    if (!payload) {
      setError('未收到预览文件信息')
      setProps(null)
      setCanNavigate(false)
      return
    }
    setError(null)
    setCanNavigate(
      (payload.navigateList?.length ?? 0) > 1 && (payload.navigateIndex ?? -1) >= 0,
    )
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
    void getFilePreviewPayload()
      .then((p) => {
        if (!cancelled) applyPayload(p)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '加载预览失败')
        }
      })

    const off = onFilePreviewPayloadUpdated((p) => {
      applyPayload(p)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [applyPayload])

  const handleClose = useCallback(() => {
    void closeFilePreviewWindow()
  }, [])

  /**
   * 左右翻页 → 主进程改载荷 → 推回来。
   *
   * 不在渲染层本地切：清单归主进程所有（它才知道当前索引），本地切会和主窗
   * 后来的改动（删文件、重新筛选）对不上。
   */
  const handleNavigate = useCallback(
    (direction: -1 | 1) => {
      void navigateFilePreviewWindow(direction)
    },
    [],
  )

  if (error) {
    return (
      <div
        style={{
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--mt-fg-2)',
          fontSize: 14,
          background: 'var(--mt-surface-1)',
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
          color: 'var(--mt-fg-3)',
          fontSize: 13,
          background: 'var(--mt-surface-1)',
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
      {...(canNavigate ? { onNavigate: handleNavigate } : {})}
      onClose={handleClose}
    />
  )
}
