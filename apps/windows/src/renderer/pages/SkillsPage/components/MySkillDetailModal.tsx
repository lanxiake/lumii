import React from 'react'
import { Wrench, Tag } from 'lucide-react'
import { Button } from '../../../components/ui/Button/Button'
import { Modal } from '../../../components/ui/Modal/Modal'
import type { MySkillDetailInfo } from '../SkillsPage.types'

export const MySkillDetailModal: React.FC<{
  skillInfo: MySkillDetailInfo | null
  isOpen: boolean
  isOperating: boolean
  onClose: () => void
  onToggle: () => void
  onUninstall: () => void
  onOpenDir?: () => void
}> = ({ skillInfo, isOpen, isOperating, onClose, onToggle, onUninstall, onOpenDir }) => {
  if (!skillInfo) return null
  const { skill, isEnabled, category } = skillInfo

  const footer = (
    <>
      <Button variant="ghost" onClick={onClose}>关闭</Button>
      {onOpenDir && (
        <Button variant="ghost" onClick={onOpenDir}>打开目录</Button>
      )}
      <Button
        variant={isEnabled ? 'secondary' : 'primary'}
        onClick={onToggle}
        loading={isOperating}
      >
        {isEnabled ? '禁用' : '启用'}
      </Button>
      <Button variant="danger" onClick={onUninstall} disabled={isOperating}>卸载</Button>
    </>
  )

  return (
    <Modal open={isOpen} onClose={onClose} width={460} footer={footer} layer="aboveHub">
      <div style={{ padding: '4px 0' }}>
        {/* 头部 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <span style={{
            width: 44, height: 44, borderRadius: 8, background: 'var(--color-bg-tertiary, var(--bg-tertiary))',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
          }}>
            <Wrench size={22} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{skill.name}</h3>
              <span style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 10, fontWeight: 500,
                background: isEnabled ? 'rgba(34,197,94,0.12)' : 'rgba(107,114,128,0.12)',
                color: isEnabled ? 'var(--color-success)' : 'var(--color-text-tertiary)',
              }}>
                {isEnabled ? '已启用' : '已禁用'}
              </span>
            </div>
            <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>v{skill.version}</span>
          </div>
        </div>

        {/* 统计栏 */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8,
          padding: 12, background: 'var(--color-bg-secondary)', borderRadius: 8, marginBottom: 14
        }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 2 }}>版本</div>
            <div style={{ fontSize: 13 }}>v{skill.version}</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 2 }}>分类</div>
            <div style={{ fontSize: 13 }}>{category || '未分类'}</div>
          </div>
        </div>

        {/* 描述 */}
        {skill.description && (
          <div style={{ marginBottom: 14 }}>
            <h4 style={{ fontSize: 12, fontWeight: 600, margin: '0 0 6px 0', color: 'var(--color-text-secondary)' }}>描述</h4>
            <p style={{ fontSize: 13, lineHeight: 1.6, margin: 0, color: 'var(--color-text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {skill.description}
            </p>
          </div>
        )}

        {/* 标签 */}
        {skill.tags && skill.tags.length > 0 && (
          <div>
            <h4 style={{ fontSize: 12, fontWeight: 600, margin: '0 0 6px 0', color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <Tag size={12} /> 标签
            </h4>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {skill.tags.map(tag => (
                <span key={tag} style={{
                  fontSize: 11, padding: '2px 8px', borderRadius: 10,
                  background: 'var(--color-bg-tertiary, var(--bg-tertiary))',
                  color: 'var(--color-text-secondary)',
                  border: '1px solid var(--color-border)'
                }}>
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
