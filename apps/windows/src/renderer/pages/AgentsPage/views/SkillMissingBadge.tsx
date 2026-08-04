import React, { useState, useRef, useEffect } from 'react'
import type { MissingSkill } from './types'
import styles from './SkillMissingBadge.module.css'

interface Props {
  agentId: string
  missing: MissingSkill[]
  popoverAlign?: 'left' | 'right'
  onInstallSkill: (agentId: string, skillId: string, skillName: string) => Promise<boolean>
  onNavigateToStore: (skillName: string) => void
}

export function SkillMissingBadge({
  agentId,
  missing,
  popoverAlign = 'left',
  onInstallSkill,
  onNavigateToStore,
}: Props) {
  const [open, setOpen] = useState(false)
  const [downloading, setDownloading] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Set<string>>(new Set())
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleDownload = async (skill: MissingSkill) => {
    setDownloading((prev) => new Set(prev).add(skill.id))
    setErrors((prev) => { const s = new Set(prev); s.delete(skill.id); return s })
    const ok = await onInstallSkill(agentId, skill.id, skill.name)
    setDownloading((prev) => { const s = new Set(prev); s.delete(skill.id); return s })
    if (!ok) setErrors((prev) => new Set(prev).add(skill.id))
  }

  const handleGotoStore = () => {
    setOpen(false)
    onNavigateToStore(missing[0]?.name ?? '')
  }

  if (missing.length === 0) return null

  return (
    <div ref={wrapperRef} className={styles.wrapper}>
      <button
        className={styles.badge}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
        type="button"
      >
        <span className={styles['badge-dot']} />
        缺 {missing.length} 个技能
      </button>

      {open && (
        <div
          className={`${styles.popover} ${styles[`popover--${popoverAlign}`]}`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className={styles['popover-header']}>
            <span className={styles['popover-header-icon']}>⚠️</span>
            <div className={styles['popover-header-text']}>
              <div className={styles['popover-title']}>本机缺失技能</div>
              <div className={styles['popover-subtitle']}>
                以下技能在当前设备未安装
              </div>
            </div>
            <button
              className={styles['popover-close']}
              onClick={() => setOpen(false)}
              type="button"
            >
              ✕
            </button>
          </div>

          <div className={styles['skill-list']}>
            {missing.map((skill) => (
              <div key={skill.id} className={styles['skill-row']}>
                <div className={styles['skill-icon']}>📦</div>
                <div className={styles['skill-info']}>
                  <div className={styles['skill-name']}>{skill.name}</div>
                </div>
                <div className={styles['skill-action']}>
                  {skill.inStore ? (
                    errors.has(skill.id) ? (
                      <span className={styles['status-error']}>✕ 失败</span>
                    ) : (
                      <button
                        className={styles['btn-download']}
                        disabled={downloading.has(skill.id)}
                        onClick={() => { void handleDownload(skill) }}
                        type="button"
                      >
                        {downloading.has(skill.id) ? '下载中…' : '⬇ 下载'}
                      </button>
                    )
                  ) : (
                    <button
                      className={styles['btn-search-store']}
                      onClick={handleGotoStore}
                      type="button"
                      title="前往技能商店搜索"
                    >
                      🔍 去查找
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className={styles['popover-footer']}>
            <button
              className={styles['btn-goto-store']}
              onClick={handleGotoStore}
              type="button"
            >
              🏪 打开技能商店
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
