/**
 * SettingsHubModal - 设置与功能模块浮层中心
 *
 * 顶部横栏切换模块；「设置」Tab 内左侧分类 + 右侧面板。
 */

import React, { useMemo } from 'react'
import clsx from 'clsx'
import { Modal } from '../ui/Modal/Modal'
import {
  User,
  FolderOpen,
  Radio,
  Shield,
  Smartphone,
  Cpu,
  Mic,
  Wrench,
  Info,
  Zap,
} from '../ui/Icon'
import { McpServersPanel } from '../McpServersPanel'
import { SettingsPage } from '../../pages/SettingsPage/SettingsPage'
import { AgentsPage } from '../../pages/AgentsPage/AgentsPage'
import { SkillsPage } from '../../pages/SkillsPage/SkillsPage'
import { CronPage } from '../../pages/CronPage/CronPage'
import { MemoriesPage } from '../../pages/MemoriesPage/MemoriesPage'
import { PluginCenterPage } from '../../pages/PluginCenterPage/PluginCenterPage'
import type { ViewType } from '../Router'
import { useSettingsHub } from './SettingsHubContext'
import { SettingsCategoryNav } from './SettingsCategoryNav'
import {
  SETTINGS_HUB_TABS,
  type SettingsCategoryItem,
  type SettingsHubTab,
} from './types'
import styles from './SettingsHubModal.module.css'

const ICON_SIZE = 16

/**
 * Hub 设置区左侧分类（合并后）
 */
const SETTINGS_CATEGORIES: SettingsCategoryItem[] = [
  { id: 'general', label: '通用', icon: <User size={ICON_SIZE} /> },
  { id: 'workspace', label: '工作空间', icon: <FolderOpen size={ICON_SIZE} /> },
  { id: 'modelConfig', label: '模型配置', icon: <Cpu size={ICON_SIZE} /> },
  { id: 'voice', label: '语音设置', icon: <Mic size={ICON_SIZE} /> },
  { id: 'channels', label: '渠道设置', icon: <Radio size={ICON_SIZE} /> },
  { id: 'codingDev', label: 'ACP 设置', icon: <Wrench size={ICON_SIZE} /> },
  { id: 'pet', label: '宠物模式', icon: <Smartphone size={ICON_SIZE} /> },
  { id: 'usage', label: '用量与花费', icon: <Zap size={ICON_SIZE} /> },
  { id: 'privacy', label: '隐私与数据', icon: <Shield size={ICON_SIZE} /> },
  { id: 'aboutAndUpdate', label: '关于与更新', icon: <Info size={ICON_SIZE} /> },
]

/**
 * 设置浮层 Hub 弹窗
 */
export const SettingsHubModal: React.FC<{
  onViewChange?: (view: ViewType) => void
}> = ({ onViewChange }) => {
  const { state, isOpen, closeHub, setTab, setCategory, clearMemoriesSubTab, openHub } = useSettingsHub()

  const header = useMemo(
    () => (
      <div className={styles.hubHeader}>
        <h2 className={styles.hubTitle}>设置中心</h2>
        <div className={styles.hubTabs} role="tablist" aria-label="功能模块">
          {SETTINGS_HUB_TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={state.tab === item.id}
              className={clsx(styles.hubTab, state.tab === item.id && styles.hubTabActive)}
              onClick={() => setTab(item.id)}
              data-app-ui="hub-tab"
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
    ),
    [state.tab, setTab],
  )

  /**
   * 功能页内跳转：Hub Tab 互切，或交给外层切主壳视图
   */
  const handleEmbeddedViewChange = (view: ViewType) => {
    if (view === 'chat' || view === 'dashboard') {
      onViewChange?.(view)
      return
    }
    openHub(view as SettingsHubTab)
  }

  const renderTabContent = () => {
    switch (state.tab) {
      case 'settings':
        return (
          <div className={styles.settingsPane}>
            <SettingsCategoryNav
              categories={SETTINGS_CATEGORIES}
              activeCategory={state.category}
              onChange={setCategory}
            />
            <div className={styles.settingsContent}>
              <SettingsPage
                embedded
                activeCategory={state.category}
              />
            </div>
          </div>
        )
      case 'agents':
        return (
          <div className={styles.embedPane}>
            <AgentsPage embedded onViewChange={handleEmbeddedViewChange} />
          </div>
        )
      case 'skills':
        return (
          <div className={styles.embedPane}>
            <SkillsPage embedded hideMcpTab />
          </div>
        )
      case 'mcp':
        // Server 配置与其工具合成一份可展开列表，不再拆成两块
        return (
          <div className={styles.mcpPane}>
            <McpServersPanel />
          </div>
        )
      case 'cron':
        return (
          <div className={styles.embedPane}>
            <CronPage embedded />
          </div>
        )
      case 'memories':
        return (
          <div className={styles.embedPane}>
            <MemoriesPage
              embedded
              initialTab={state.memoriesSubTab as 'wiki' | 'soul' | 'ai' | 'user-memory' | 'plugin' | undefined}
              onMemoriesSubTabConsumed={clearMemoriesSubTab}
              onViewChange={handleEmbeddedViewChange}
            />
          </div>
        )
      case 'plugins':
        return (
          <div className={styles.embedPane}>
            <PluginCenterPage embedded />
          </div>
        )
      default:
        return null
    }
  }

  return (
    <Modal
      open={isOpen}
      size="hub"
      header={header}
      onClose={closeHub}
      maskClosable
      bodyClassName={styles.hubBody}
    >
      {renderTabContent()}
    </Modal>
  )
}

export default SettingsHubModal
