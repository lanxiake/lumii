/**
 * ExperimentalSection - 实验功能设置
 *
 * 列表入口 + 设置内栈式详情：提示词风格、自主进化、跨渠道会话接续。
 *
 * **提示词风格已插件化**（`plugins/builtin/prompt-style`）：列表行与详情子页都由插件提供，
 * 插件被禁用时整条消失（`usePluginEnabled`）。另两个还留在本文件，迁完后的样子见
 * docs/plans/工程基建/2026-10-22-实验功能插件化与前后端一体化启停实施计划.md。
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from '../../../../components/ui/Icon'
import { Badge } from '../../../../components/ui/Badge/Badge'
import { Switch } from '../../../../components/ui/Switch/Switch'
import { AutonomousPage } from '../../../AutonomousPage/AutonomousPage'
import { getAutonomousStatus } from '../../../../services/autonomous-service'
import {
  PLUGIN_EXPERIMENT_ENTRIES,
  type ExperimentEntry,
} from '../../../../../plugins/renderer/experiments'
import { usePluginEnabled } from '../../../../../plugins/renderer/state'
import { useChannelFeatures } from './useChannelFeatures'
import settingsStyles from '../../SettingsPage.module.css'
import styles from './ExperimentalSection.module.css'

type ExperimentalView = 'list' | 'autonomous' | 'channelContinuity'

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
  /** 字符串或组件产出的文本（插件条目的摘要是活的） */
  summary: ReactNode
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
 * 插件提供的实验项：列表行。
 *
 * 单独一个组件是为了能在里面调 hook——在 map 里调 `usePluginEnabled` 会让 hook 数量
 * 随条数变化，React 直接报 "Rendered more hooks than during the previous render"。
 */
function PluginExperimentRow({ entry, onOpen }: { entry: ExperimentEntry; onOpen: () => void }) {
  const enabled = usePluginEnabled(entry.id)
  if (!enabled) return null
  return <FeatureRow title={entry.title} summary={<entry.Summary />} onClick={onOpen} />
}

/**
 * 实验功能设置：默认列表；点选进入详情子页。
 *
 * 插件条目与核心条目共用一个列表；插件被禁用时它的行与详情一起消失。
 */
export function ExperimentalSection() {
  const [view, setView] = useState<ExperimentalView>('list')
  const [openPluginId, setOpenPluginId] = useState<string | null>(null)
  const openPlugin = useMemo(
    () => PLUGIN_EXPERIMENT_ENTRIES.find((entry) => entry.id === openPluginId) ?? null,
    [openPluginId],
  )
  // 详情开着时插件被禁用 → 退回列表（否则留一个空面板）
  const openPluginEnabled = usePluginEnabled(openPluginId ?? '__none__')
  useEffect(() => {
    if (openPluginId && !openPluginEnabled) setOpenPluginId(null)
  }, [openPluginId, openPluginEnabled])
  const [autonomousEnabled, setAutonomousEnabled] = useState<boolean | null>(null)
  const [pendingGoals, setPendingGoals] = useState(0)
  const { features, loading: featuresLoading, saving: featuresSaving, setFeature } =
    useChannelFeatures()

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

  if (openPlugin && openPluginEnabled) {
    return <openPlugin.Detail onBack={() => setOpenPluginId(null)} />
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
        {PLUGIN_EXPERIMENT_ENTRIES.map((entry) => (
          <PluginExperimentRow
            key={entry.id}
            entry={entry}
            onOpen={() => setOpenPluginId(entry.id)}
          />
        ))}
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
