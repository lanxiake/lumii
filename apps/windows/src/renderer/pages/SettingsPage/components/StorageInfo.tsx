/**
 * 本地 SQLite 存储信息：占用、路径、表行数；支持导出 JSONL、清理异常消息与备份恢复。
 */

import React, { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import { Button } from '../../../components/ui/Button/Button'
import { Input } from '../../../components/ui/Input/Input'
import styles from '../SettingsPage.module.css'

export interface LocalStorageStatsView {
  readonly dbPath: string
  readonly fileSizeBytes: number
  readonly tableRowCounts: Readonly<Record<string, number>>
  readonly conversationCount: number
  readonly messageCount: number
  readonly backupDir: string
  readonly backupCount: number
  readonly latestBackupAt: string | null
}

interface DatabaseBackupView {
  readonly fileName: string
  readonly filePath: string
  readonly sizeBytes: number
  readonly modifiedAt: string
}

/**
 * 将字节数格式化为可读字符串
 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 将 ISO 时间格式化为本地可读字符串
 */
function formatLocalTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

export interface StorageInfoProps {
  readonly toast: {
    success: (msg: string) => void
    error: (msg: string) => void
  }
}

/**
 * 设置页 — 本地 Agent Runtime 数据库存储摘要与维护操作
 */
export const StorageInfo: React.FC<StorageInfoProps> = ({ toast }) => {
  const [stats, setStats] = useState<LocalStorageStatsView | null>(null)
  const [backups, setBackups] = useState<DatabaseBackupView[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [backupsExpanded, setBackupsExpanded] = useState(false)
  const [busy, setBusy] = useState(false)

  /**
   * 加载存储统计与备份列表
   */
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const api = window.electronAPI?.agentRuntime
      if (!api?.getLocalStorageStats) {
        setStats(null)
        setBackups([])
        return
      }
      const s = await api.getLocalStorageStats()
      setStats(s)
      if (api.listDatabaseBackups) {
        const list = await api.listDatabaseBackups()
        setBackups(list)
      } else {
        setBackups([])
      }
    } catch (e) {
      console.warn('[StorageInfo] 读取存储信息失败', e)
      setStats(null)
      setBackups([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * 立即创建本地数据库备份
   */
  const handleCreateBackup = useCallback(async () => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.createDatabaseBackup) return

    setBusy(true)
    try {
      const result = await api.createDatabaseBackup()
      if (!result.ok) {
        toast.error(result.error ?? '备份失败')
        return
      }
      toast.success(
        `备份已创建：${result.fileName ?? '未知文件'}（${formatBytes(result.sizeBytes ?? 0)}）`,
      )
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '备份失败')
    } finally {
      setBusy(false)
    }
  }, [toast, load])

  /**
   * 从指定备份恢复聊天记录
   */
  const handleRestoreBackup = useCallback(async (backupFileName: string) => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.restoreDatabaseFromBackup) return

    const { response } = await window.electronAPI.dialog.showMessageBox({
      type: 'warning',
      title: '从备份恢复聊天记录',
      message:
        `将从备份「${backupFileName}」恢复本地聊天记录。\n\n` +
        '当前内存中的 Agent 实例会被销毁并重建，恢复后请刷新或重新打开会话列表。\n\n是否继续？',
      buttons: ['取消', '恢复'],
      defaultId: 1,
      cancelId: 0,
    })
    if (response !== 1) return

    setBusy(true)
    try {
      const result = await api.restoreDatabaseFromBackup(backupFileName)
      if (!result.ok) {
        toast.error(result.error ?? '恢复失败')
        return
      }
      toast.success(
        `已从备份恢复：${result.conversationCount ?? 0} 个会话，${result.messageCount ?? 0} 条消息`,
      )
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '恢复失败')
    } finally {
      setBusy(false)
    }
  }, [toast, load])

  /**
   * 从最新备份恢复聊天记录
   */
  const handleRestoreLatest = useCallback(async () => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.restoreDatabaseFromLatestBackup) return
    if (backups.length === 0) {
      toast.error('没有可用的备份文件')
      return
    }

    const latest = backups[0]!
    const { response } = await window.electronAPI.dialog.showMessageBox({
      type: 'warning',
      title: '从最新备份恢复',
      message:
        `将从最新备份「${latest.fileName}」（${formatLocalTime(latest.modifiedAt)}）恢复。\n\n` +
        '当前内存中的 Agent 实例会被销毁并重建。是否继续？',
      buttons: ['取消', '恢复最新备份'],
      defaultId: 1,
      cancelId: 0,
    })
    if (response !== 1) return

    setBusy(true)
    try {
      const result = await api.restoreDatabaseFromLatestBackup()
      if (!result.ok) {
        toast.error(result.error ?? '恢复失败')
        return
      }
      toast.success(
        `已从 ${result.backupFileName ?? '最新备份'} 恢复：` +
          `${result.conversationCount ?? 0} 个会话，${result.messageCount ?? 0} 条消息`,
      )
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '恢复失败')
    } finally {
      setBusy(false)
    }
  }, [backups, toast, load])

  /**
   * 删除指定备份文件
   */
  const handleDeleteBackup = useCallback(async (backupFileName: string) => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.deleteDatabaseBackup) return

    const { response } = await window.electronAPI.dialog.showMessageBox({
      type: 'warning',
      title: '删除备份',
      message: `确定要删除备份「${backupFileName}」吗？\n\n此操作不可撤销。`,
      buttons: ['取消', '删除'],
      defaultId: 0,
      cancelId: 0,
    })
    if (response !== 1) return

    setBusy(true)
    try {
      const result = await api.deleteDatabaseBackup(backupFileName)
      if (!result.ok) {
        toast.error(result.error ?? '删除失败')
        return
      }
      toast.success(`已删除备份：${backupFileName}`)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败')
    } finally {
      setBusy(false)
    }
  }, [toast, load])

  const handleExport = useCallback(async () => {
    setBusy(true)
    try {
      const api = window.electronAPI?.agentRuntime
      if (!api?.exportLocalDataJSONL) return
      const text = await api.exportLocalDataJSONL()
      const { filePath, canceled } = await window.electronAPI.dialog.showSaveDialog({
        title: '导出本地聊天记录',
        defaultPath: 'agent-runtime-messages.jsonl',
        filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }],
      })
      if (canceled || !filePath) {
        return
      }
      await window.electronAPI.file.write(filePath, text)
      toast.success('已导出到所选文件')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '导出失败')
    } finally {
      setBusy(false)
    }
  }, [toast])

  const handleClearMalformed = useCallback(async () => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.clearMalformedMessages) return

    const { response } = await window.electronAPI.dialog.showMessageBox({
      type: 'warning',
      title: '清理异常消息',
      message: '将删除本地库中 content_json 无法解析的消息行。是否继续？',
      buttons: ['取消', '清理'],
      defaultId: 1,
      cancelId: 0,
    })
    if (response !== 1) return

    setBusy(true)
    try {
      const removed = await api.clearMalformedMessages()
      toast.success(`已清理 ${removed} 条异常消息`)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '清理失败')
    } finally {
      setBusy(false)
    }
  }, [toast, load])

  if (loading) {
    return (
      <div className={styles['setting-group']}>
        <p className={styles['settings-note']}>正在读取本地存储信息…</p>
      </div>
    )
  }

  if (!stats) {
    return (
      <div className={styles['setting-group']}>
        <p className={styles['settings-note']}>
          本地 Agent Runtime 未就绪时无法显示存储信息。
        </p>
      </div>
    )
  }

  const showEmptyDbWarning =
    stats.conversationCount === 0 && stats.messageCount === 0 && stats.backupCount > 0

  return (
    <div className={styles['setting-group']}>
      <h4 className={styles['settings-subsection-title']}>本地聊天记录存储</h4>
      <p className={styles['settings-note']}>
        聊天记录存储在本地 SQLite，网关不保存对话内容，便于保护隐私。
        系统会在每日凌晨自动备份，最多保留最近 10 次；你也可以随时手动备份或从备份恢复。
      </p>

      {showEmptyDbWarning && (
        <div
          className={styles['setting-item']}
          style={{
            padding: '10px 12px',
            borderRadius: 8,
            background: 'rgba(250, 173, 20, 0.12)',
            border: '1px solid rgba(250, 173, 20, 0.35)',
            marginBottom: 12,
          }}
        >
          <strong>检测到当前数据库为空，但存在 {stats.backupCount} 个历史备份。</strong>
          <p style={{ margin: '6px 0 0', fontSize: 13 }}>
            可能是上次异常退出导致数据库损坏。建议点击下方「恢复最新备份」找回历史消息。
          </p>
        </div>
      )}

      <div className={styles['setting-item']}>
        <div className={styles['setting-row']} style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <span className={styles['setting-label']}>数据占用</span>
          <button
            type="button"
            className={clsx(styles['about-link'])}
            style={{ cursor: 'pointer', border: 'none', background: 'none', padding: 0, font: 'inherit' }}
            onClick={() => setExpanded((v) => !v)}
          >
            {formatBytes(stats.fileSizeBytes)}
            {expanded ? ' ▲' : ' ▼'}
          </button>
        </div>
        <span className={styles['setting-hint']} style={{ display: 'block', marginTop: 4 }}>
          数据库路径（可点击后在资源管理器中打开）
        </span>
        <div className={styles['setting-row']}>
          <Input readOnly value={stats.dbPath} style={{ flex: 1, fontSize: 12 }} />
          <Button
            variant="secondary"
            onClick={() => window.electronAPI.app.showItemInFolder(stats.dbPath)}
          >
            打开所在文件夹
          </Button>
        </div>
      </div>

      {expanded && (
        <div className={styles['setting-item']} style={{ fontSize: 13, color: 'var(--text-secondary, #8c8c8c)' }}>
          <div>会话数：{stats.conversationCount}</div>
          <div>消息数：{stats.messageCount}</div>
          <div>备份数：{stats.backupCount}</div>
          {stats.latestBackupAt && (
            <div>最新备份：{formatLocalTime(stats.latestBackupAt)}</div>
          )}
          <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {Object.entries(stats.tableRowCounts).map(([k, v]) => (
              <li key={k}>
                {k}: {v}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className={styles['setting-item']}>
        <h4 className={styles['settings-subsection-title']} style={{ marginTop: 8 }}>
          备份与恢复
        </h4>
        <span className={styles['setting-hint']} style={{ display: 'block', marginBottom: 8 }}>
          备份目录：{stats.backupDir}
        </span>
        <div className={styles['setting-actions']} style={{ marginBottom: 12 }}>
          <Button variant="primary" onClick={() => void handleCreateBackup()} loading={busy}>
            立即备份
          </Button>
          <Button
            variant="secondary"
            onClick={() => void handleRestoreLatest()}
            disabled={busy || backups.length === 0}
          >
            恢复最新备份
          </Button>
          <Button
            variant="secondary"
            onClick={() => window.electronAPI.app.showItemInFolder(stats.backupDir)}
            disabled={busy}
          >
            打开备份文件夹
          </Button>
        </div>
        {backups.length === 0 ? (
          <p className={styles['settings-note']}>暂无备份文件，可点击「立即备份」创建第一份备份。</p>
        ) : (
          <>
            <button
              type="button"
              className={styles['about-link']}
              style={{ cursor: 'pointer', border: 'none', background: 'none', padding: 0, font: 'inherit', marginBottom: 8 }}
              onClick={() => setBackupsExpanded((v) => !v)}
            >
              备份记录（{backups.length}）{backupsExpanded ? ' ▲' : ' ▼'}
            </button>
            {backupsExpanded && (
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', fontSize: 13 }}>
            {backups.map((b) => (
              <li
                key={b.fileName}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  padding: '8px 0',
                  borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.08))',
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ wordBreak: 'break-all' }}>{b.fileName}</div>
                  <div style={{ color: 'var(--text-secondary, #8c8c8c)', marginTop: 2 }}>
                    {formatLocalTime(b.modifiedAt)} · {formatBytes(b.sizeBytes)}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void handleRestoreBackup(b.fileName)}
                  >
                    恢复
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void handleDeleteBackup(b.fileName)}
                  >
                    删除
                  </Button>
                </div>
              </li>
            ))}
          </ul>
            )}
          </>
        )}
      </div>

      <div className={styles['setting-actions']}>
        <Button variant="secondary" onClick={() => void load()} disabled={busy}>
          刷新
        </Button>
        <Button variant="secondary" onClick={() => void handleExport()} loading={busy}>
          导出全部数据 (JSONL)
        </Button>
        <Button variant="secondary" onClick={() => void handleClearMalformed()} disabled={busy}>
          清理异常消息
        </Button>
      </div>
    </div>
  )
}
