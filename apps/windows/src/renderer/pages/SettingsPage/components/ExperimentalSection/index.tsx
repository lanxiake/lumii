/**
 * ExperimentalSection - 实验功能设置
 *
 * **列表本身不写死任何条目**：提示词风格、跨渠道会话接续、自主进化都是插件提供的
 * （`plugins/renderer/experiments.ts`），插件被禁用时整条消失（`usePluginEnabled`）。
 *
 * 页面只负责：标题 + 行的样式 + 「打开哪一条详情」的状态。详情子页由插件渲染，
 * 复用这里的 CSS（`ExperimentalSection.module.css`）。
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronRight } from '../../../../components/ui/Icon'
import { Badge } from '../../../../components/ui/Badge/Badge'
import {
  PLUGIN_EXPERIMENT_ENTRIES,
  type ExperimentEntry,
} from '../../../../../plugins/renderer/experiments'
import { usePluginEnabled } from '../../../../../plugins/renderer/state'
import styles from './ExperimentalSection.module.css'

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
 * 实验功能设置：默认列表；点选进入该条目的详情子页。
 */
export function ExperimentalSection() {
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

  if (openPlugin && openPluginEnabled) {
    return <openPlugin.Detail onBack={() => setOpenPluginId(null)} />
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
      </div>
    </div>
  )
}
