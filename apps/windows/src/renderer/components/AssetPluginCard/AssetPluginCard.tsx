import React from 'react'

import { PLUGIN_REGISTRY, type PluginId } from '../../data/asset-plugins'
import { usePluginsContext } from '../../contexts/PluginsContext/PluginsContext'
import { useSettingsHub } from '../SettingsHub/SettingsHubContext'
import { PluginCard } from './PluginCard'

/**
 * 运行时组件卡片（在功能页里按需安装）。
 *
 * 「运行时组件」不再是独立页签：录屏、浏览器、MCP、桌宠各自在用到它的地方
 * 挂一张卡片。状态与安装进度来自全局 `PluginsProvider`，切页面不会丢。
 */
export const AssetPluginCard: React.FC<{ id: PluginId; compact?: boolean }> = ({ id, compact }) => {
  const def = PLUGIN_REGISTRY.find((item) => item.id === id)
  const { statuses, install, uninstall, cancel } = usePluginsContext()
  const { setTab } = useSettingsHub()
  if (!def) return null

  const status = statuses[id]
  if (!status) return null

  return (
    <PluginCard
      def={def}
      status={status}
      onInstall={() => void install(id)}
      onUninstall={() => void uninstall(id)}
      onCancel={() => void cancel(id)}
      onNavigateTab={setTab}
      compact={compact}
    />
  )
}
