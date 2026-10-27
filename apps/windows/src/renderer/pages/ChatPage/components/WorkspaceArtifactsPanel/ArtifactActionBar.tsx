/**
 * ArtifactActionBar — main 底部的结果动作条（选中产物时出现）
 *
 * 一级动作最多 5 个且按 kind 配（见 artifact-actions.ts）；不可用的动作**不渲染**。
 * 「移入回收站」是危险动作：这里做一次就地二次确认（再点一次才执行），不弹系统对话框——
 * 系统对话框在本机 dev 会话里根本不显示（PR-4 实测），不能把用户卡在一条点不动的路上。
 */

import React, { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { ChevronDown, Ellipsis } from 'lucide-react'
import type { Artifact } from './ledger'
import {
  ACTION_LABEL,
  EXPORT_MENU,
  EXPORT_MENU_LABEL,
  MORE_MENU,
  MORE_MENU_LABEL,
  primaryActionsFor,
  type ArtifactActionKey,
  type ExportMenuKey,
  type MoreMenuKey,
} from './artifact-actions'
import styles from './WorkspaceArtifactsPanel.module.css'

export interface ArtifactActionBarProps {
  artifact: Artifact
  onEdit: () => void
  onLocate: () => void
  onCompare: () => void
  onExport: (menu: ExportMenuKey) => void
  onMore: (menu: MoreMenuKey) => void
  /** 当前产物有可撤销的本地修改时才显示「撤销」菜单项 */
  canUndoEdit?: boolean
}

/** 危险动作的确认窗口：3s 内再点一次才执行 */
const CONFIRM_MS = 3000

export const ArtifactActionBar: React.FC<ArtifactActionBarProps> = ({
  artifact,
  onEdit,
  onLocate,
  onCompare,
  onExport,
  onMore,
  canUndoEdit = false,
}) => {
  const [openMenu, setOpenMenu] = useState<'export' | 'more' | null>(null)
  const [confirmTrash, setConfirmTrash] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // 点外面 / Esc 收起菜单；换产物时全部复位
  useEffect(() => {
    if (!openMenu && !confirmTrash) return
    const onDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpenMenu(null)
        setConfirmTrash(false)
      }
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpenMenu(null)
        setConfirmTrash(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [openMenu, confirmTrash])

  useEffect(() => {
    setOpenMenu(null)
    setConfirmTrash(false)
  }, [artifact.path])

  useEffect(() => {
    if (!confirmTrash) return
    const timer = window.setTimeout(() => setConfirmTrash(false), CONFIRM_MS)
    return () => window.clearTimeout(timer)
  }, [confirmTrash])

  const actions = primaryActionsFor(artifact.kind)

  const handleMore = (key: MoreMenuKey): void => {
    if (key === 'trash' && !confirmTrash) {
      setConfirmTrash(true)
      return
    }
    setOpenMenu(null)
    setConfirmTrash(false)
    onMore(key)
  }

  const renderPrimary = (action: ArtifactActionKey): React.ReactNode => {
    if (action === 'exportMenu') {
      return (
        <div key={action} className={styles.actionGroup}>
          <button
            type="button"
            className={styles.actionBtn}
            onClick={() => setOpenMenu(openMenu === 'export' ? null : 'export')}
            aria-expanded={openMenu === 'export'}
            aria-haspopup="menu"
          >
            导出
            <ChevronDown size={11} strokeWidth={2} />
          </button>
          {openMenu === 'export' && (
            <div className={styles.actionMenu} role="menu">
              {EXPORT_MENU.map((key) => (
                <button
                  key={key}
                  type="button"
                  role="menuitem"
                  className={styles.actionMenuItem}
                  onClick={() => {
                    setOpenMenu(null)
                    onExport(key)
                  }}
                >
                  {EXPORT_MENU_LABEL[key]}
                </button>
              ))}
            </div>
          )}
        </div>
      )
    }
    if (action === 'more') {
      return (
        <div key={action} className={styles.actionGroup}>
          <button
            type="button"
            className={clsx(styles.actionBtn, styles.actionIcon)}
            onClick={() => setOpenMenu(openMenu === 'more' ? null : 'more')}
            aria-expanded={openMenu === 'more'}
            aria-haspopup="menu"
            title="更多"
            aria-label="更多"
          >
            <Ellipsis size={13} strokeWidth={2} />
          </button>
          {openMenu === 'more' && (
            <div className={clsx(styles.actionMenu, styles.actionMenuRight)} role="menu">
              {MORE_MENU.filter((key) => key !== 'undoEdit' || canUndoEdit).map((key) => (
                <button
                  key={key}
                  type="button"
                  role="menuitem"
                  className={clsx(
                    styles.actionMenuItem,
                    key === 'trash' && styles.actionMenuItemDanger,
                    key === 'trash' && confirmTrash && styles.actionMenuItemConfirm,
                  )}
                  onClick={() => handleMore(key)}
                >
                  {key === 'trash' && confirmTrash ? '再点一次确认移入回收站' : MORE_MENU_LABEL[key]}
                </button>
              ))}
            </div>
          )}
        </div>
      )
    }

    const onClick =
      action === 'edit' ? onEdit : action === 'locate' ? onLocate : onCompare
    return (
      <button
        key={action}
        type="button"
        className={styles.actionBtn}
        onClick={onClick}
        title={
          action === 'edit' && artifact.kind === 'slides'
            ? 'PPT 单页编辑在 P2；现在会打开预览'
            : undefined
        }
      >
        {ACTION_LABEL[action]}
      </button>
    )
  }

  return (
    <div className={styles.actionBar} ref={rootRef} data-testid="artifact-action-bar">
      <span className={styles.actionBarName} title={artifact.path}>
        {artifact.path.split('/').pop() ?? artifact.path}
      </span>
      <div className={styles.actionBarActions}>
        {actions.map(renderPrimary)}
      </div>
    </div>
  )
}
