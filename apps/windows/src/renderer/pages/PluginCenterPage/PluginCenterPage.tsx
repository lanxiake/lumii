import React from 'react'
import { PLUGIN_REGISTRY } from './plugins-registry'
import { PluginCard } from './PluginCard'
import { usePluginsContext } from '../../contexts/PluginsContext/PluginsContext'
import styles from './PluginCenterPage.module.css'

export const PluginCenterPage: React.FC = () => {
  const { statuses, install, uninstall, cancel } = usePluginsContext()

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>插件中心</h1>
        <p className={styles.subtitle}>管理可选功能插件，按需安装或卸载</p>
      </div>

      <div className={styles.grid}>
        {PLUGIN_REGISTRY.map((def) => (
          <PluginCard
            key={def.id}
            def={def}
            status={statuses[def.id]}
            onInstall={() => install(def.id)}
            onUninstall={() => uninstall(def.id)}
            onCancel={def.id === 'cloak-browser' ? () => cancel(def.id) : undefined}
          />
        ))}
      </div>
    </div>
  )
}
