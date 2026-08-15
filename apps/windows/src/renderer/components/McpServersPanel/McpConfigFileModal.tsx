/**
 * mcp-servers.json 客户端内编辑弹窗
 *
 * 直接改磁盘原文；保存后主进程校验并全量重连。
 */

import React, { useEffect, useState } from 'react'
import { Button } from '../ui'
import { Modal } from '../ui/Modal/Modal'
import styles from './McpServersPanel.module.css'

export interface McpConfigFileModalProps {
  open: boolean
  onClose: () => void
  /** 读取原文 */
  onRead: () => Promise<{ path: string; content: string }>
  /** 写入原文；返回是否成功 */
  onWrite: (content: string) => Promise<{ success: boolean; error?: string }>
  /** 写入成功后的回调（刷新工具列表等） */
  onSaved?: () => void
}

/** 打开并编辑 ~/.lumii/config/mcp-servers.json */
export const McpConfigFileModal: React.FC<McpConfigFileModalProps> = ({
  open,
  onClose,
  onRead,
  onWrite,
  onSaved,
}) => {
  const [path, setPath] = useState('')
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    setLoading(true)
    void onRead()
      .then((file) => {
        setPath(file.path)
        setContent(file.content)
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => setLoading(false))
  }, [open, onRead])

  /** 校验 JSON 后写回并关闭 */
  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      JSON.parse(content)
    } catch (e) {
      setError(`JSON 语法错误：${(e as Error).message}`)
      setSaving(false)
      return
    }

    const result = await onWrite(content)
    setSaving(false)
    if (!result.success) {
      setError(result.error ?? '保存失败')
      return
    }
    onSaved?.()
    onClose()
  }

  /** 在资源管理器中定位该文件 */
  const revealInFolder = () => {
    if (path) void window.electronAPI.app.showItemInFolder(path)
  }

  return (
    <Modal
      open={open}
      title="编辑 mcp-servers.json"
      onClose={onClose}
      width={640}
      layer="aboveHub"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={revealInFolder} disabled={!path}>
            在资源管理器中显示
          </Button>
          <div style={{ flex: 1 }} />
          <Button variant="ghost" onClick={onClose} disabled={saving}>取消</Button>
          <Button onClick={() => void handleSave()} disabled={loading || saving}>
            {saving ? '保存中…' : '保存并重连'}
          </Button>
        </>
      }
    >
      <div className={styles['edit-body']}>
        <p className={styles['field-hint']}>
          {path ? (
            <>
              文件路径：<code>{path}</code>
            </>
          ) : (
            '读取配置文件…'
          )}
          {' '}保存后立即按新配置重连全部 MCP Server。
        </p>
        {error && <div className={styles['edit-error']}>{error}</div>}
        <textarea
          className={styles['textarea-json']}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          spellCheck={false}
          disabled={loading}
          rows={18}
          aria-label="mcp-servers.json 内容"
        />
      </div>
    </Modal>
  )
}
