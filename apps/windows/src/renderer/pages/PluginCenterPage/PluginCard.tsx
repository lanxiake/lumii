import React, { useState } from 'react'
import type { PluginDef } from './plugins-registry'
import { CATEGORY_LABELS } from './plugins-registry'
import type { PluginStatus } from '../../hooks/business/usePlugins/usePlugins'
import { ConfirmModal } from '../../components/ui/Modal/ConfirmModal'
import styles from './PluginCard.module.css'

type Props = {
  def: PluginDef
  status: PluginStatus
  onInstall: () => void
  onUninstall: () => void
  onCancel?: () => void
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export const PluginCard: React.FC<Props> = ({ def, status, onInstall, onUninstall, onCancel }) => {
  const [showConfirm, setShowConfirm] = useState(false)

  const { installed, installing, uninstalling, progress, error, version } = status
  const busy = installing || uninstalling

  const statusLabel = () => {
    if (uninstalling) return { text: '卸载中...', cls: styles.tagBusy }
    if (installing) {
      const phase = progress?.phase
      if (phase === 'checking') return { text: '检查中...', cls: styles.tagBusy }
      if (phase === 'downloading') return { text: '下载中', cls: styles.tagBusy }
      if (phase === 'extracting') return { text: '解压中...', cls: styles.tagBusy }
      return { text: '安装中...', cls: styles.tagBusy }
    }
    if (installed) return { text: '已安装', cls: styles.tagInstalled }
    return { text: '未安装', cls: styles.tagNotInstalled }
  }

  const { text: stText, cls: stCls } = statusLabel()

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.icon}>{def.icon}</span>
        <div className={styles.meta}>
          <div className={styles.titleRow}>
            <span className={styles.name}>{def.name}</span>
            <span className={`${styles.tag} ${stCls}`}>{stText}</span>
          </div>
          <div className={styles.tags}>
            <span className={styles.tagCategory}>{CATEGORY_LABELS[def.category]}</span>
            {def.installSize && <span className={styles.tagSize}>{def.installSize}</span>}
            {installed && version && <span className={styles.tagVersion}>{version}</span>}
          </div>
        </div>
      </div>

      <p className={styles.desc}>{def.description}</p>

      {def.features && (
        <ul className={styles.features}>
          {def.features.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}

      {/* 下载进度条 */}
      {installing && progress?.phase === 'downloading' && (
        <div className={styles.progressWrap}>
          <div className={styles.progressBar}>
            <div
              className={styles.progressFill}
              style={{ width: `${progress.percent ?? 0}%` }}
            />
          </div>
          <div className={styles.progressInfo}>
            <span>{progress.mirror ?? ''}</span>
            <span>
              {progress.percent != null ? `${progress.percent}%` : ''}
              {progress.downloadedBytes != null && progress.totalBytes
                ? `  ${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes)}`
                : ''}
            </span>
          </div>
        </div>
      )}

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.actions}>
        {!installed ? (
          installing ? (
            <button
              className={styles.btnCancel}
              onClick={onCancel}
              disabled={!onCancel}
            >
              取消
            </button>
          ) : (
            <button
              className={styles.btnInstall}
              onClick={onInstall}
              disabled={busy}
            >
              安装
            </button>
          )
        ) : (
          <button
            className={styles.btnUninstall}
            onClick={() => setShowConfirm(true)}
            disabled={busy}
          >
            {uninstalling ? '卸载中...' : '卸载'}
          </button>
        )}
      </div>

      {showConfirm && (
        <ConfirmModal
          open={showConfirm}
          title={`卸载 ${def.name}`}
          content={`确认卸载 ${def.name}？相关数据将被删除。`}
          confirmText="确认卸载"
          confirmVariant="danger"
          onConfirm={() => { setShowConfirm(false); onUninstall() }}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </div>
  )
}
