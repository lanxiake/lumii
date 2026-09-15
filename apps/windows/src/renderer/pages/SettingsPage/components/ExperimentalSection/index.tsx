/**
 * ExperimentalSection - 实验功能设置
 *
 * 列表入口 + 设置内栈式详情：提示词风格、自主进化、跨渠道会话接续。
 * 工具进化已移至「工具」菜单。提示词风格切换写 localStorage 并经 IPC
 * 同步主进程缓存，下一轮对话生效；跨渠道接续写主进程 JSON，下次渠道消息即时生效。
 */

import React, { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from '../../../../components/ui/Icon'
import { Badge } from '../../../../components/ui/Badge/Badge'
import { Switch } from '../../../../components/ui/Switch/Switch'
import { AutonomousPage } from '../../../AutonomousPage/AutonomousPage'
import {
  useSettings,
  SETTINGS_STORAGE_KEY,
  SETTINGS_UPDATE_EVENT,
} from '../../../../hooks/business/useSettings'
import { updatePromptStyle } from '../../../../services/settings-service'
import { getAutonomousStatus } from '../../../../services/autonomous-service'
import { useChannelFeatures } from './useChannelFeatures'
import settingsStyles from '../../SettingsPage.module.css'
import styles from './ExperimentalSection.module.css'

type ExperimentalView = 'list' | 'promptStyle' | 'autonomous' | 'channelContinuity'

/** 提示词风格详情：详细/简要切换与说明（无段清单表） */
function PromptStyleDetail({ onBack }: { onBack: () => void }) {
  const { settings } = useSettings()
  const currentStyle = settings.promptStyle?.style === 'terse' ? 'terse' : 'detailed'

  const handleStyleChange = useCallback(
    (style: 'detailed' | 'terse') => {
      if (style === currentStyle) return
      const nextSettings = {
        ...settings,
        promptStyle: { ...settings.promptStyle, style },
      }
      try {
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(nextSettings))
        window.dispatchEvent(new CustomEvent(SETTINGS_UPDATE_EVENT, { detail: nextSettings }))
        void updatePromptStyle({ style })
      } catch {
        // 忽略本地存储写入失败
      }
    },
    [settings, currentStyle],
  )

  return (
    <div className={styles.detail}>
      <DetailHeader title="提示词风格（实验）" onBack={onBack} />
      <div className={`${settingsStyles['settings-section']} ${styles.detailBody}`}>
        <div className={settingsStyles['setting-row']}>
          <span className={settingsStyles['setting-label']}>全局风格</span>
          <div className={styles['style-switch']} role="radiogroup" aria-label="系统提示词风格">
            <button
              type="button"
              role="radio"
              aria-checked={currentStyle === 'detailed'}
              className={currentStyle === 'detailed' ? styles['style-switch-active'] : undefined}
              onClick={() => handleStyleChange('detailed')}
            >
              详细
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={currentStyle === 'terse'}
              className={currentStyle === 'terse' ? styles['style-switch-active'] : undefined}
              onClick={() => handleStyleChange('terse')}
            >
              简要
            </button>
          </div>
        </div>
        <p className={settingsStyles['setting-hint']}>
          简要档按索引式渲染系统提示词段落（段尾附展开引导，模型可按需获取完整规则），
          面向强模型减少冗余描述；切换后下一轮对话生效。
        </p>
      </div>
    </div>
  )
}

/**
 * 跨渠道会话接续详情：一个开关 + 行为说明。
 *
 * 开关值在主进程（`channel-features.json`），渠道 adapter 每条消息现读，
 * 所以切换后**下一轮渠道消息即生效，无需重启**。
 */
function ChannelContinuityDetail({
  onBack,
  enabled,
  saving,
  onToggle,
}: {
  onBack: () => void
  enabled: boolean
  saving: boolean
  onToggle: (value: boolean) => void
}) {
  return (
    <div className={styles.detail}>
      <DetailHeader title="跨渠道会话接续" onBack={onBack} />
      <div className={`${settingsStyles['settings-section']} ${styles.detailBody}`}>
        <div className={settingsStyles['setting-row']}>
          <span className={settingsStyles['setting-label']}>启用接续询问</span>
          <Switch
            id="channel-cross-continuity"
            checked={enabled}
            disabled={saving}
            onChange={onToggle}
          />
        </div>
        <p className={settingsStyles['setting-hint']}>
          在渠道（微信 / QQ / 飞书 / 企微）里发消息时，若你近期在客户端或其它渠道有进行中的对话，
          会提示你是否继续那条对话：回复「接续」继续（本条消息仍在当前会话回答），回复「不接续」忽略；
          不回则什么都不变。同一会话只提示一次，正等审批答复时不会提示。
          关闭后渠道消息一律留在本渠道自己的会话里。切换后下一轮渠道消息即生效，无需重启。
        </p>
      </div>
    </div>
  )
}

/** 详情子页顶栏：返回 + 标题 */
function DetailHeader({ title, onBack }: { title: string; onBack: () => void }) {  return (
    <div className={styles.detailHeader}>
      <button type="button" className={styles.backBtn} onClick={onBack} aria-label="返回实验功能列表">
        <ChevronLeft size={18} aria-hidden />
        <span>返回</span>
      </button>
      <h3 className={styles.detailTitle}>{title}</h3>
    </div>
  )
}

/** 实验功能列表行 */
function FeatureRow({
  title,
  summary,
  badge,
  onClick,
}: {
  title: string
  summary: string
  badge?: boolean
  onClick: () => void
}) {
  return (
    <button type="button" className={styles.featureRow} onClick={onClick}>
      <div className={styles.featureMain}>
        <span className={styles.featureTitle}>
          {title}
          {badge ? <Badge dot className={styles.featureBadge} /> : null}
        </span>
        <span className={styles.featureSummary}>{summary}</span>
      </div>
      <ChevronRight size={18} className={styles.featureChevron} aria-hidden />
    </button>
  )
}

/**
 * 实验功能设置：默认列表；点选进入提示词风格或自主进化详情子页。
 */
export function ExperimentalSection() {
  const { settings } = useSettings()
  const [view, setView] = useState<ExperimentalView>('list')
  const [autonomousEnabled, setAutonomousEnabled] = useState<boolean | null>(null)
  const [pendingGoals, setPendingGoals] = useState(0)
  const { features, loading: featuresLoading, saving: featuresSaving, setFeature } =
    useChannelFeatures()

  const currentStyle = settings.promptStyle?.style === 'terse' ? 'terse' : 'detailed'
  const styleSummary = currentStyle === 'terse' ? '当前：简要' : '当前：详细'
  const autonomousSummary =
    autonomousEnabled === null
      ? '加载中…'
      : autonomousEnabled
        ? '状态：已启用'
        : '状态：已禁用'
  const continuitySummary = featuresLoading
    ? '加载中…'
    : features.crossChannelContinuityEnabled
      ? '状态：已启用'
      : '状态：已关闭'

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const status = await getAutonomousStatus()
        if (cancelled) return
        setAutonomousEnabled(Boolean(status?.enabled))
        setPendingGoals(typeof status?.pendingGoalsCount === 'number' ? status.pendingGoalsCount : 0)
      } catch {
        if (!cancelled) {
          setAutonomousEnabled(false)
          setPendingGoals(0)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [view])

  const goList = useCallback(() => setView('list'), [])

  if (view === 'promptStyle') {
    return <PromptStyleDetail onBack={goList} />
  }

  if (view === 'channelContinuity') {
    return (
      <ChannelContinuityDetail
        onBack={goList}
        enabled={features.crossChannelContinuityEnabled}
        saving={featuresSaving}
        onToggle={(v) => void setFeature('crossChannelContinuityEnabled', v)}
      />
    )
  }

  if (view === 'autonomous') {
    return (
      <div className={styles.detail}>
        <DetailHeader title="自主进化" onBack={goList} />
        <div className={`${settingsStyles['autonomous-embed']} ${styles.detailBody}`}>
          <AutonomousPage embedded />
        </div>
      </div>
    )
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.listHeader}>
        <h3 className={styles.listTitle}>实验功能</h3>
        <p className={styles.listHint}>
          实验项可能随版本调整；部分配置在下一轮对话后生效。点选条目进入详情进行启用或修改。
        </p>
      </div>
      <div className={styles.featureList}>
        <FeatureRow
          title="提示词风格（实验）"
          summary={styleSummary}
          onClick={() => setView('promptStyle')}
        />
        <FeatureRow
          title="跨渠道会话接续"
          summary={continuitySummary}
          onClick={() => setView('channelContinuity')}
        />
        <FeatureRow
          title="自主进化"
          summary={autonomousSummary}
          badge={pendingGoals > 0}
          onClick={() => setView('autonomous')}
        />
      </div>
    </div>
  )
}
