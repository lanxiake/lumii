import React, { useState, useEffect, useCallback, useSyncExternalStore, ReactNode } from 'react'
import clsx from 'clsx'
import {
  User,
  FolderOpen,
  HardDrive,
  Radio,
  Shield,
  Smartphone,
  Cpu,
  Mic,
  Wrench,
  Info,
  Zap,
  FlaskConical,
  Monitor,
  Cloud,
  Palette,
} from '../../components/ui/Icon'
import { FileText } from 'lucide-react'
import { Button } from '../../components/ui/Button/Button'
import { Input } from '../../components/ui/Input/Input'
import { Checkbox } from '../../components/ui/Checkbox/Checkbox'
import { Badge } from '../../components/ui/Badge/Badge'
import { useSettings, useCategorySettings, DEFAULT_SETTINGS, readStoredSettings } from '../../hooks/business/useSettings'
import { useToast } from '../../components/ui/Toast/useToast'
import { PageHeader } from '../../components/ui/PageHeader/PageHeader'
import { CodingDevAcpPanel } from './components/CodingDevAcpPanel'
import { ChannelsSection } from './components/ChannelsSection'
import { SlotHost } from '../../components/slots/SlotHost'
import { getPluginStateSnapshot, subscribePluginState } from '../../../plugins/renderer/state'
import { filterPluginCategories } from '../../../plugins/renderer/settings-categories'
import { LumiiLogo } from '../../components/brand/LumiiLogo'
import { openExternalUrl } from '../../utils/markdown-external-link'
import { VIRTUAL_HUMAN_PRODUCT_NAME } from '../../../shared/virtual-human'
import { getWorkspaceDir, ensureWorkspaceDir, notifyWorkspaceChanged } from '../../services/workspace-service'
import { getAppVersion, getOpenAtLogin, setOpenAtLogin as applyOpenAtLogin, openLogFile } from '../../services/app-service'
import { ModelConfigSection } from './components/ModelConfigSection'
import { WorkspaceSection } from './components/WorkspaceSection'
import { OfficialExtensionGate } from '../../components/OfficialExtensionGate/OfficialExtensionGate'
import { ExperimentalSection } from './components/ExperimentalSection'
import { AppearanceSection } from './components/AppearanceSection'
import type {
  MergedSettingsCategory,
} from '../../components/SettingsHub/types'
import type { ScreenRecordConfig } from '../../hooks/business/useSettings'
import styles from './SettingsPage.module.css'
import { StorageInfo } from './components/StorageInfo'
import { StorageSection } from './components/StorageSection'
import { SecurityLogViewer } from './components/SecurityLogViewer/SecurityLogViewer'

/**
 * 设置分类图标尺寸
 */
const SETTINGS_ICON_SIZE = 16

/**
 * 合并后的左侧分类（整页模式备用；Hub 自带导航时可不渲染）
 */
const CATEGORIES: Array<{ id: MergedSettingsCategory; label: string; icon: ReactNode }> = [
  { id: 'general', label: '通用', icon: <User size={SETTINGS_ICON_SIZE} /> },
  { id: 'appearance', label: '外观', icon: <Palette size={SETTINGS_ICON_SIZE} /> },
  { id: 'workspace', label: '工作空间', icon: <FolderOpen size={SETTINGS_ICON_SIZE} /> },
  { id: 'storage', label: '存储', icon: <HardDrive size={SETTINGS_ICON_SIZE} /> },
  { id: 'modelConfig', label: '模型配置', icon: <Cpu size={SETTINGS_ICON_SIZE} /> },
  { id: 'voice', label: '语音设置', icon: <Mic size={SETTINGS_ICON_SIZE} /> },
  { id: 'channels', label: '渠道设置', icon: <Radio size={SETTINGS_ICON_SIZE} /> },
  { id: 'codingDev', label: 'ACP 设置', icon: <Wrench size={SETTINGS_ICON_SIZE} /> },
  { id: 'pet', label: VIRTUAL_HUMAN_PRODUCT_NAME, icon: <Smartphone size={SETTINGS_ICON_SIZE} /> },
  { id: 'usage', label: '用量与花费', icon: <Zap size={SETTINGS_ICON_SIZE} /> },
  { id: 'privacy', label: '隐私与数据', icon: <Shield size={SETTINGS_ICON_SIZE} /> },
  { id: 'cloudSync', label: '云同步', icon: <Cloud size={SETTINGS_ICON_SIZE} /> },
  { id: 'screenRecord', label: '录屏', icon: <Monitor size={SETTINGS_ICON_SIZE} /> },
  { id: 'experimental', label: '实验功能', icon: <FlaskConical size={SETTINGS_ICON_SIZE} /> },
  { id: 'aboutAndUpdate', label: '关于与更新', icon: <Info size={SETTINGS_ICON_SIZE} /> },
]

/**
 * SettingsPage - 设置面板
 *
 * Hub 嵌入时只渲染右侧分类内容；整页模式保留左导航壳。
 */
interface SettingsPageProps {
  /** 是否作为 Hub 右侧面板嵌入 */
  embedded?: boolean
  /** 受控分类（Hub 左侧导航驱动） */
  activeCategory?: MergedSettingsCategory
}

const SettingsPage: React.FC<SettingsPageProps> = ({
  embedded = false,
  activeCategory: controlledCategory,
}) => {
  const toast = useToast()
  // 归插件的设置分区：插件停用后入口不显示（内容槽位也会是空的）
  const pluginState = useSyncExternalStore(subscribePluginState, getPluginStateSnapshot)
  const visibleCategories = filterPluginCategories(CATEGORIES, (id) => pluginState.get(id) === true)
  const {
    settings,
    updateNotification,
    updatePrivacy,
    updateWorkspace,
    updateSystem,
    updateSettings,
    saveSettings,
  } = useSettings()
  
  const [internalCategory, setInternalCategory] = useState<MergedSettingsCategory>('general')
  const activeCategory = controlledCategory ?? internalCategory
  const setActiveCategory = setInternalCategory
  const [appVersion, setAppVersion] = useState<string>('')

  /** 待审批目标数：整页模式「实验功能」导航红点（挂载时拉取，30s 刷新） */
  const [pendingAutonomousGoals, setPendingAutonomousGoals] = useState(0)
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const status = await window.electronAPI.autonomous.getStatus()
        if (!cancelled && typeof status?.pendingGoalsCount === 'number') {
          setPendingAutonomousGoals(status.pendingGoalsCount)
        }
      } catch {
        /* 控制面不可用时静默（红点非关键路径） */
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 30_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  // 账户设置状态

  // 工作空间设置状态
  const [defaultWorkspaceDir, setDefaultWorkspaceDir] = useState<string>('')
  
  // 开机启动状态
  const [openAtLogin, setOpenAtLogin] = useState(false)
  const [openAtLoginLoading, setOpenAtLoginLoading] = useState(false)

  // Category-level save hooks (must be at top level, not in render functions)
  const workspaceSave = useCategorySettings({
    category: 'workspace',
    getCurrentValue: () => settings.workspace,
    getSavedValue: () => {
      const stored = localStorage.getItem('mtbot-assistant-settings')
      if (stored) {
        const parsed = JSON.parse(stored)
        return parsed.workspace || {}
      }
      return {}
    },
    onSave: async (value) => {
      await saveSettings()
      // 确保新工作空间目录及其子目录结构存在
      const targetDir = value.directory || defaultWorkspaceDir
      await ensureWorkspaceDir(targetDir)
      // 通知主进程工作空间目录已更改
      await notifyWorkspaceChanged(value.directory || '')
    }
  })

  const notificationSave = useCategorySettings({
    category: 'notification',
    getCurrentValue: () => settings.notification,
    getSavedValue: () => {
      const stored = localStorage.getItem('mtbot-assistant-settings')
      if (stored) {
        const parsed = JSON.parse(stored)
        return parsed.notification || {}
      }
      return {}
    },
    onSave: async () => {
      await saveSettings()
    }
  })

  const privacySave = useCategorySettings({
    category: 'privacy',
    getCurrentValue: () => settings.privacy,
    getSavedValue: () => {
      const stored = localStorage.getItem('mtbot-assistant-settings')
      if (stored) {
        const parsed = JSON.parse(stored)
        return parsed.privacy || {}
      }
      return {}
    },
    onSave: async () => {
      await saveSettings()
    }
  })

  const screenRecordSave = useCategorySettings({
    category: 'screenRecord',
    getCurrentValue: () => settings.screenRecord,
    getSavedValue: () => readStoredSettings()?.screenRecord ?? DEFAULT_SETTINGS.screenRecord,
    onSave: async () => {
      await saveSettings()
    }
  })

  /** 更新录屏配置：缺失字段以默认值补齐，避免逐项展开默认对象 */
  const updateScreenRecord = useCallback((partial: Partial<ScreenRecordConfig>) => {
    updateSettings({
      screenRecord: { ...(settings.screenRecord ?? DEFAULT_SETTINGS.screenRecord), ...partial },
    })
  }, [settings.screenRecord, updateSettings])

  /**
   * 获取应用版本
   */
  useEffect(() => {
    getAppVersion().then(setAppVersion).catch(() => {
      console.warn('[SettingsPage] 获取版本失败')
    })
  }, [])

  /**
   * 获取工作空间路径：以主进程 getDir 为权威源并回填展示
   */
  useEffect(() => {
    getWorkspaceDir().then((dir) => {
      if (!dir) return
      setDefaultWorkspaceDir(dir)
      // 主进程权威路径回填到设置草稿，避免 Wizard/setDir 与 localStorage 不同步时仍显示默认目录
      updateWorkspace({ directory: dir })
    }).catch(() => {
      console.warn('[SettingsPage] 获取工作空间路径失败')
    })
  // 仅挂载时同步一次
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 初始化开机启动状态
   */
  useEffect(() => {
    getOpenAtLogin().then(setOpenAtLogin).catch(() => {
      console.warn('[SettingsPage] 获取开机启动状态失败')
    })
  }, [])

  /**
   * 切换开机启动
   */
  const handleToggleOpenAtLogin = useCallback(async (enable: boolean) => {
    console.log('[SettingsPage] 切换开机启动:', enable)
    setOpenAtLoginLoading(true)
    try {
      const actual = await applyOpenAtLogin(enable)
      setOpenAtLogin(actual)
      console.log('[SettingsPage] 开机启动设置完成:', actual)
      if (enable && !actual) {
        // 开发模式下 Electron 不支持 setLoginItemSettings；打包后失败可能是系统安全策略拦截
        const isDev = (await getAppVersion()).includes('dev')
        if (isDev) {
          toast.error('开发模式下无法设置开机启动，打包后生效')
        } else {
          toast.warning('开机启动设置可能被系统安全策略拦截，请检查系统设置')
        }
      } else {
        toast.success(enable ? '已开启开机自动启动' : '已关闭开机自动启动')
      }
    } catch (err) {
      console.error('[SettingsPage] 设置开机启动失败:', err)
      toast.error('设置开机启动失败')
    } finally {
      setOpenAtLoginLoading(false)
    }
  }, [])

  /**
   * 切换启动开机动画（立即写入 localStorage，供下次启动 early-splash 读取）
   */
  const handleToggleSplash = useCallback(async (enable: boolean) => {
    updateSystem({ showSplashOnStartup: enable })
    try {
      const nextSystem = { ...settings.system, showSplashOnStartup: enable }
      const nextSettings = { ...settings, system: nextSystem }
      localStorage.setItem('mtbot-assistant-settings', JSON.stringify(nextSettings))
      toast.success(enable ? '已开启启动开机动画' : '已关闭启动开机动画')
    } catch (err) {
      console.error('[SettingsPage] 保存开机动画设置失败:', err)
      toast.error('保存失败')
    }
  }, [settings, toast, updateSystem])

  /**
   * 渲染账户设置
   */
  const renderAccountSettings = () => (
    <div className={styles['settings-section']}>
      <h3 data-app-ui-section-title>通用</h3>

      <h4 className={styles['settings-subsection-title']}>系统偏好</h4>

      <div className={styles['setting-group']}>
        <div className={styles['setting-item']}>
          <Checkbox
            checked={openAtLogin}
            onChange={(checked) => handleToggleOpenAtLogin(checked)}
            disabled={openAtLoginLoading}
          >
            开机时自动启动
          </Checkbox>
          <span className={styles['setting-hint']}>登录系统后自动启动灵栖 / Lumii</span>
        </div>
        <div className={styles['setting-item']}>
          <Checkbox
            checked={settings.system?.showSplashOnStartup !== false}
            onChange={(checked) => { void handleToggleSplash(checked) }}
          >
            启动时播放开机动画
          </Checkbox>
          <span className={styles['setting-hint']}>
            关闭后主窗口直接进入界面；文件预览等独立窗口本就不播放
          </span>
        </div>
      </div>
    </div>
  )

  const renderChannelsSettings = () => {
    return (
      <div className={`${styles['settings-section']} ${styles['settings-section--channels']}`}>
        <ChannelsSection />
      </div>
    )
  }

  /**
   * 渲染云同步：GitCode 私有仓库多设备同步（独立一级菜单）
   */
  const renderCloudSyncSettings = () => {
    return (
      // 安装包只带 catalog：全新安装时先让用户在这里把它装上
      <OfficialExtensionGate
        id="com.lumii.cloud-sync"
        name="云同步"
        description="把用户文件与记忆同步到自建 Git 仓库"
      >
        <div className={styles['settings-section']}>
          {/* 整块由云同步插件注册；停用/卸载后槽位为空，给一句可操作的提示 */}
          <SlotHost
            name="settings.category.cloudSync"
            fallback={
              <p className={styles['panel-desc']}>
                云同步已禁用。到「设置 › 插件」里启用后即可使用。
              </p>
            }
          />
        </div>
      </OfficialExtensionGate>
    )
  }

  /**
   * 渲染本机 ACP / 开发工具设置
   */
  const renderCodingDevSettings = () => (
    <div className={styles['settings-section']}>
      <h3 data-app-ui-section-title>ACP 设置</h3>
      <p style={{ fontSize: 13, color: 'var(--mt-fg-3)', margin: '0 0 16px' }}>
        管理本机开发类 AI 工具（ACP）的安装状态与工作目录。
      </p>
      <CodingDevAcpPanel />
    </div>
  )

  /**
   * 渲染通知设置
   */
  const renderNotificationSettings = () => {
    return (
      <div className={styles['settings-section']}>
        <h3 data-app-ui-section-title>
          通知设置
          {notificationSave.hasChanges && <Badge dot />}
        </h3>

        <div className={styles['setting-group']}>
          <div className={styles['setting-item']}>
            <Checkbox
              checked={settings.notification.enabled}
              onChange={(checked) => updateNotification({ enabled: checked })}
            >
              启用通知
            </Checkbox>
          </div>

          <div className={styles['setting-item']}>
            <Checkbox
              checked={settings.notification.soundEnabled}
              onChange={(checked) => updateNotification({ soundEnabled: checked })}
              disabled={!settings.notification.enabled}
            >
              启用通知声音
            </Checkbox>
          </div>

          <div className={styles['setting-item']}>
            <Checkbox
              checked={settings.notification.showPreview}
              onChange={(checked) => updateNotification({ showPreview: checked })}
              disabled={!settings.notification.enabled}
            >
              显示消息预览
            </Checkbox>
          </div>

          <div className={styles['setting-item']}>
            <Checkbox
              checked={settings.notification.desktopNotification}
              onChange={(checked) => updateNotification({ desktopNotification: checked })}
              disabled={!settings.notification.enabled}
            >
              桌面通知
            </Checkbox>
          </div>
        </div>

        {notificationSave.hasChanges && (
          <div className={styles['category-save-actions']}>
            <Button 
              onClick={notificationSave.save} 
              loading={notificationSave.isSaving}
              disabled={notificationSave.isSaving}
            >
              {notificationSave.saveStatus === 'saved' 
                ? '✓ 已保存' 
                : notificationSave.saveStatus === 'error'
                  ? '保存失败'
                  : '保存通知设置'}
            </Button>
          </div>
        )}
      </div>
    )
  }

  /**
   * 渲染隐私与数据：统一卡片分区，本地优先说明在前
   */
  const renderPrivacySettings = () => {
    return (
      <div className={styles['settings-panel']}>
        <header className={styles['panel-header']}>
          <h3 data-app-ui-section-title className={styles['panel-title']}>
            隐私与数据
            {privacySave.hasChanges && <Badge dot />}
          </h3>
          <p className={styles['panel-desc']}>
            对话与记忆默认只保存在本机。可按需调整本地留存与数据导出。
          </p>
        </header>

        <section className={styles['panel-card']}>
          <h4 className={styles['panel-card-title']} data-app-ui-heading>Agent 界面控制</h4>
          <div className={styles['panel-rows']}>
            <div className={styles['panel-row']}>
              <div className={styles['panel-row-text']}>
                <span className={styles['panel-row-label']}>允许 Agent 操作本软件界面</span>
                <span className={styles['panel-row-hint']}>
                  关闭后 Agent 无法截图、导航或点击本客户端界面
                </span>
              </div>
              <Checkbox
                checked={settings.privacy.allowAgentAppUiControl !== false}
                onChange={(checked) => updatePrivacy({ allowAgentAppUiControl: checked })}
              />
            </div>
          </div>
        </section>

        <section className={styles['panel-card']}>
          <h4 className={styles['panel-card-title']} data-app-ui-heading>本地留存</h4>
          <div className={styles['panel-rows']}>
            <div className={styles['panel-row']}>
              <div className={styles['panel-row-text']}>
                <span className={styles['panel-row-label']}>保存聊天历史</span>
                <span className={styles['panel-row-hint']}>关闭后不再把新对话写入本机</span>
              </div>
              <Checkbox
                checked={settings.privacy.saveChatHistory}
                onChange={(checked) => updatePrivacy({ saveChatHistory: checked })}
              />
            </div>

            {settings.privacy.saveChatHistory && (
              <div className={styles['panel-row']}>
                <div className={styles['panel-row-text']}>
                  <span className={styles['panel-row-label']}>历史保留天数</span>
                  <span className={styles['panel-row-hint']}>超过天数的记录将被清理</span>
                </div>
                <div className={styles['setting-input-with-unit']}>
                  <Input
                    type="number"
                    value={settings.privacy.historyRetentionDays}
                    onChange={(e) => updatePrivacy({ historyRetentionDays: Number(e.target.value) })}
                    min={1}
                    max={365}
                  />
                  <span className={styles['setting-unit']}>天</span>
                </div>
              </div>
            )}

            <div className={styles['panel-row']}>
              <div className={styles['panel-row-text']}>
                <span className={styles['panel-row-label']}>匿名使用统计</span>
                <span className={styles['panel-row-hint']}>仅用于改进产品，不含对话内容</span>
              </div>
              <Checkbox
                checked={settings.privacy.sendUsageStats}
                onChange={(checked) => updatePrivacy({ sendUsageStats: checked })}
              />
            </div>
          </div>
        </section>

        <section className={styles['panel-card']}>
          <h4 className={styles['panel-card-title']} data-app-ui-heading>安全日志</h4>
          <p className={styles['panel-card-desc']}>
            查看本机 AI 工具与权限相关操作摘要（最近 20 条）
          </p>
          <SecurityLogViewer />
        </section>

        <section className={styles['panel-card']}>
          <h4 className={styles['panel-card-title']} data-app-ui-heading>系统日志</h4>
          <p className={styles['panel-card-desc']}>
            打开应用运行日志文件，便于排查连接、对话与启动问题
          </p>
          <div className={styles['panel-actions']}>
            <Button
              variant="secondary"
              onClick={async () => {
                try {
                  const res = await openLogFile()
                  if (!res.success) {
                    toast.error(res.error || '打开日志失败')
                  }
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : '打开日志失败')
                }
              }}
            >
              <FileText size={16} style={{ marginRight: 6 }} />
              打开系统日志
            </Button>
          </div>
        </section>

        {/* 性能诊断整块由 perf 插件注册；插件停用后卡片一起消失 */}
        {pluginState.get('com.lumii.perf') === true && (
          <section className={styles['panel-card']}>
            <h4 className={styles['panel-card-title']} data-app-ui-heading>性能诊断</h4>
            <p className={styles['panel-card-desc']}>
              监控应用性能指标、IPC 调用延迟、内存占用，便于诊断性能问题
            </p>
            <div className={styles['panel-storage']}>
              <SlotHost name="settings.section.perf" />
            </div>
          </section>
        )}

        <section className={styles['panel-card']}>
          <h4 className={styles['panel-card-title']} data-app-ui-heading>备份与恢复</h4>
          <p className={styles['panel-card-desc']}>查看本地存储占用，管理数据库备份并按需恢复</p>
          <div className={styles['panel-storage']}>
            <StorageInfo toast={toast} />
          </div>
        </section>

        {privacySave.hasChanges && (
          <div className={styles['category-save-actions']}>
            <Button
              onClick={privacySave.save}
              loading={privacySave.isSaving}
              disabled={privacySave.isSaving}
            >
              {privacySave.saveStatus === 'saved'
                ? '✓ 已保存'
                : privacySave.saveStatus === 'error'
                  ? '保存失败'
                  : '保存更改'}
            </Button>
          </div>
        )}
      </div>
    )
  }

  /**
   * 渲染录屏：整块由录屏插件注册；停用/未安装时给出可操作的提示。
   */
  const renderScreenRecordSettings = () => {
    const screenRecord = { ...DEFAULT_SETTINGS.screenRecord, ...settings.screenRecord }
    return (
      <OfficialExtensionGate
        id="com.lumii.screen-record"
        name="录屏"
        description="窗口/屏幕录制、旁白配音与字幕烧录"
      >
        <SlotHost
          name="settings.category.screenRecord"
          context={{ screenRecord, update: updateScreenRecord, save: screenRecordSave }}
          fallback={
            <p className={styles['panel-desc']}>
              录屏扩展已禁用。到「设置 › 插件」里启用后即可使用。
            </p>
          }
        />
      </OfficialExtensionGate>
    )
  }

  /**
   * 渲染关于与更新：版本信息 + 检查更新合并为一页
   */
  const renderAboutAndUpdateSettings = () => (
    <div className={styles['settings-panel']}>
      <header className={styles['panel-header']}>
        <h3 data-app-ui-section-title className={styles['panel-title']}>关于与更新</h3>
        <p className={styles['panel-desc']}>查看版本信息，并管理软件更新偏好</p>
      </header>

      <section className={clsx(styles['panel-card'], styles['panel-card--about'])}>
        <div className={styles['about-brand']}>
          <LumiiLogo size={48} />
          <div>
            <h2 className={styles['about-name']}>灵栖 Lumii</h2>
            <p className={styles['about-version']}>版本 {appVersion} · 开源独立版</p>
          </div>
        </div>
        <p className={styles['about-description']}>
          本地优先的 Windows 桌面 AI 伙伴：对话、技能、定时任务与渠道接入都在本机完成，无需自建后端。
        </p>
        <div className={styles['panel-actions']}>
          <Button
            variant="secondary"
            onClick={() => openExternalUrl('https://github.com/lanxiake/lumii')}
          >
            项目主页
          </Button>
          <Button
            variant="secondary"
            onClick={() => openExternalUrl('https://github.com/lanxiake/lumii/issues')}
          >
            问题反馈
          </Button>
        </div>
      </section>

      <section className={styles['panel-card']}>
        <h4 className={styles['panel-card-title']} data-app-ui-heading>软件更新</h4>
        <p className={styles['panel-card-desc']}>检查并安装新版本</p>
        <SlotHost name="settings.section.updater" context={{ standalone: true }} />
        <div className={styles['panel-rows']} style={{ marginTop: 12 }}>
          <div className={styles['panel-row']}>
            <div className={styles['panel-row-text']}>
              <span className={styles['panel-row-label']}>启动时检查更新</span>
              <span className={styles['panel-row-hint']}>打开应用时自动查询是否有新版本</span>
            </div>
            <Checkbox
              checked={settings.checkUpdateOnStartup}
              onChange={async (checked) => {
                updateSettings({ checkUpdateOnStartup: checked })
                await saveSettings()
              }}
            />
          </div>
        </div>
      </section>

      <p className={styles['panel-footer-note']}>© 2026 Lumii</p>
    </div>
  )

  /**
   * 渲染快捷键设置
   */
  const renderShortcutsSettings = () => (
    <div className={styles['settings-section']}>
      <h3 data-app-ui-section-title>快捷键</h3>

      <div className={styles['setting-group']}>
        <div className={styles['shortcut-item']}>
          <span className={styles['shortcut-label']}>发送消息</span>
          <kbd className={styles['shortcut-key']}>{settings.shortcuts.sendMessage}</kbd>
        </div>

        <div className={styles['shortcut-item']}>
          <span className={styles['shortcut-label']}>新建对话</span>
          <kbd className={styles['shortcut-key']}>{settings.shortcuts.newChat}</kbd>
        </div>

        <div className={styles['shortcut-item']}>
          <span className={styles['shortcut-label']}>切换侧边栏</span>
          <kbd className={styles['shortcut-key']}>{settings.shortcuts.toggleSidebar}</kbd>
        </div>

        <div className={styles['shortcut-item']}>
          <span className={styles['shortcut-label']}>打开设置</span>
          <kbd className={styles['shortcut-key']}>{settings.shortcuts.openSettings}</kbd>
        </div>
      </div>

      <p className={styles['settings-note']}>
        快捷键自定义功能将在后续版本中提供
      </p>
    </div>
  )

  /**
   * 渲染当前分类内容（合并分类在此拼接子面板）
   */
  const renderCategoryContent = () => {
    switch (activeCategory) {
      case 'general':
        return (
          <>
            {renderAccountSettings()}
            <div className={styles['settings-merged-block']}>
              {renderNotificationSettings()}
            </div>
            <div className={styles['settings-merged-block']}>
              {renderShortcutsSettings()}
            </div>
          </>
        )
      case 'storage':
        return <StorageSection />
      case 'workspace':
        return (
          <WorkspaceSection
            settings={settings}
            defaultWorkspaceDir={defaultWorkspaceDir}
            updateWorkspace={updateWorkspace}
            save={workspaceSave}
          />
        )
      case 'appearance':
        return <AppearanceSection />
      case 'modelConfig':
        return <ModelConfigSection />
      case 'voice':
        // 整块由语音插件注册；停用后槽位为空、左侧入口消失
        return <SlotHost name="settings.category.voice" />
      case 'channels':
        return renderChannelsSettings()
      case 'codingDev':
        return renderCodingDevSettings()
      case 'privacy':
        return renderPrivacySettings()
      case 'cloudSync':
        return renderCloudSyncSettings()
      case 'screenRecord':
        return renderScreenRecordSettings()
      case 'experimental':
        return <ExperimentalSection />
      case 'pet':
        // 整块由桌宠插件注册；停用后槽位为空、左侧入口消失
        return <SlotHost name="settings.category.pet" />
      case 'usage':
        // 整块由插件注册；插件停用后槽位为空（左侧入口也会一起消失）
        return <SlotHost name="settings.category.usage" />
      case 'aboutAndUpdate':
        return renderAboutAndUpdateSettings()
      default:
        return null
    }
  }

  if (embedded) {
    return <>{renderCategoryContent()}</>
  }

  return (
    <div className={styles['settings-page']}>
      <PageHeader title="设置" />

      <div className={styles['settings-body']}>
        <nav className={styles['settings-nav']}>
          {visibleCategories.map((category) => (
            <button
              key={category.id}
              className={clsx(styles['settings-nav-item'], activeCategory === category.id && styles['active'])}
              onClick={() => setActiveCategory(category.id)}
            >
              <span className={styles['nav-icon']}>{category.icon}</span>
              <span className={styles['nav-label']}>{category.label}</span>
              {category.id === 'experimental' && pendingAutonomousGoals > 0 && <Badge dot />}
            </button>
          ))}
        </nav>

        <div className={styles['settings-content']}>
          {renderCategoryContent()}
        </div>
      </div>
    </div>
  )
}

export { SettingsPage };
