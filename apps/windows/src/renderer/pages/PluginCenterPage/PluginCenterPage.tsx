import React from 'react'
import { PLUGIN_REGISTRY } from '../../data/asset-plugins'
import { useSettingsHub } from '../../components/SettingsHub/SettingsHubContext'
import { PluginCard } from './PluginCard'
import { usePluginsContext } from '../../contexts/PluginsContext/PluginsContext'
import styles from './PluginCenterPage.module.css'

/**
 * 运行时组件：按需下载的二进制 / 模型 / 外部服务。
 *
 * 与「代码扩展」是两个页签、两套生命周期——这里只有安装/卸载，
 * 不涉及热更新与启停。卡片上的「用于」负责把两边的关系说清楚。
 */
export const PluginCenterPage: React.FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const { statuses, install, uninstall, cancel } = usePluginsContext()
  const { setTab } = useSettingsHub()

  return (
    <div className={`${styles.page}${embedded ? ` ${styles.pageEmbedded}` : ''}`}>
      {!embedded && (
      <div className={styles.header}>
        <h1 className={styles.title}>运行时组件</h1>
        <p className={styles.subtitle}>按需下载的二进制、模型与外部服务；装完按提示生效或重启</p>
      </div>
      )}

      <div className={styles.grid}>
        {PLUGIN_REGISTRY.map((def) => (
          <PluginCard
            key={def.id}
            def={def}
            status={statuses[def.id]}
            onInstall={() => install(def.id)}
            onUninstall={() => uninstall(def.id)}
            onCancel={() => cancel(def.id)}
            onNavigateTab={setTab}
          />
        ))}
      </div>
    </div>
  )
}
