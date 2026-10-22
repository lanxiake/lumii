import { useEffect, useState } from 'react'

import settingsStyles from '../../../renderer/pages/SettingsPage/SettingsPage.module.css'
import sectionStyles from '../../../renderer/pages/SettingsPage/components/ExperimentalSection/ExperimentalSection.module.css'
import { ChevronLeft } from '../../../renderer/components/ui/Icon'
import { Badge } from '../../../renderer/components/ui/Badge/Badge'
import { getAutonomousStatus } from './ui/autonomous-service'
import { AutonomousPage } from './ui/AutonomousPage'

/**
 * 自主进化的渲染层半边：实验功能列表里的摘要（带待审批红点）+ 仪表板。
 *
 * 仪表板本身照旧走 `AutonomousPage`（它直接调 `autonomous:*` 通道）——
 * 插件停用后这些通道随作用域摘掉，而列表入口与路由会先一步消失，
 * 所以不会出现「点进去全报错」。
 */

export function AutonomousSummary() {
  const [status, setStatus] = useState<{ enabled: boolean; pending: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const s = await getAutonomousStatus()
        if (cancelled) return
        setStatus({
          enabled: Boolean(s?.enabled),
          pending: typeof s?.pendingGoalsCount === 'number' ? s.pendingGoalsCount : 0,
        })
      } catch {
        if (!cancelled) setStatus({ enabled: false, pending: 0 })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <span>
      {status === null ? '加载中…' : status.enabled ? '状态：已启用' : '状态：已禁用'}
      {status && status.pending > 0 ? <Badge dot /> : null}
    </span>
  )
}

export function AutonomousDetail({ onBack }: { onBack: () => void }) {
  return (
    <div className={sectionStyles.detail}>
      <div className={sectionStyles.detailHeader}>
        <button
          type="button"
          className={sectionStyles.backBtn}
          onClick={onBack}
          aria-label="返回实验功能列表"
        >
          <ChevronLeft size={18} aria-hidden />
          <span>返回</span>
        </button>
        <h3 className={sectionStyles.detailTitle}>自主进化</h3>
      </div>
      <div className={`${settingsStyles['autonomous-embed']} ${sectionStyles.detailBody}`}>
        <AutonomousPage embedded />
      </div>
    </div>
  )
}

export const autonomousExperiment = {
  id: 'com.lumii.autonomous',
  title: '自主进化',
  Summary: AutonomousSummary,
  Detail: AutonomousDetail,
}
