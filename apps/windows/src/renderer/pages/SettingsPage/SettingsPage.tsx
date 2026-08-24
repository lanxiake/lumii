import React, { useState, useEffect, useCallback, ReactNode } from 'react'
import clsx from 'clsx'
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
} from '../../components/ui/Icon'
import { FileText } from 'lucide-react'
import { Card } from '../../components/ui/Card/Card'
import { Button } from '../../components/ui/Button/Button'
import { Input } from '../../components/ui/Input/Input'
import { Checkbox } from '../../components/ui/Checkbox/Checkbox'
import { Select } from '../../components/ui/Select/Select'
import { Badge } from '../../components/ui/Badge/Badge'
import { UpdaterView } from '../../components/business/UpdaterView'
import { useSettings, useCategorySettings } from '../../hooks/business/useSettings'
import { useToast } from '../../components/ui/Toast/useToast'
import { PageHeader } from '../../components/ui/PageHeader/PageHeader'
import { CodingDevAcpPanel } from './components/CodingDevAcpPanel'
import { ChannelsSection } from './components/ChannelsSection'
import { UsagePanel } from './components/UsagePanel'
import { LumiiLogo } from '../../components/brand/LumiiLogo'
import { PetSettingsSection } from './components/PetSettingsSection'
import { ModelConfigSection } from './components/ModelConfigSection'
import { VoiceSettingsSection } from './components/VoiceSettingsSection'
import { AccountSection } from './components/AccountSection'
import { WorkspaceSection } from './components/WorkspaceSection'
import { NotificationSection } from './components/NotificationSection'
import { PrivacySection } from './components/PrivacySection'
import type {
  MergedSettingsCategory,
} from '../../components/SettingsHub/types'
import styles from './SettingsPage.module.css'
import { StorageInfo } from './components/StorageInfo'
import { SecurityLogViewer } from './components/SecurityLogViewer/SecurityLogViewer'
import { PerformanceDiagnostics } from './components/PerformanceDiagnostics/PerformanceDiagnostics'

/**
 * 设置分类图标尺寸
 */
const SETTINGS_ICON_SIZE = 16

/**
 * 合并后的左侧分类（整页模式备用；Hub 自带导航时可不渲染）
 */
const CATEGORIES: Array<{ id: MergedSettingsCategory; label: string; icon: ReactNode }> = [
  { id: 'general', label: '通用', icon: <User size={SETTINGS_ICON_SIZE} /> },
  { id: 'workspace', label: '工作空间', icon: <FolderOpen size={SETTINGS_ICON_SIZE} /> },
  { id: 'modelConfig', label: '模型配置', icon: <Cpu size={SETTINGS_ICON_SIZE} /> },
  { id: 'voice', label: '语音设置', icon: <Mic size={SETTINGS_ICON_SIZE} /> },
  { id: 'channels', label: '渠道设置', icon: <Radio size={SETTINGS_ICON_SIZE} /> },
  { id: 'codingDev', label: 'ACP 设置', icon: <Wrench size={SETTINGS_ICON_SIZE} /> },
  { id: 'pet', label: '宠物模式', icon: <Smartphone size={SETTINGS_ICON_SIZE} /> },
  { id: 'usage', label: '用量与花费', icon: <Zap size={SETTINGS_ICON_SIZE} /> },
  { id: 'privacy', label: '隐私与数据', icon: <Shield size={SETTINGS_ICON_SIZE} /> },
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
  const {
    settings,
    hasChanges,
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
  const [appVersion, setAppVersion] = useState<string>('0.1.2')

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
      await window.electronAPI.workspace.ensureDir(targetDir)
      // 通知主进程工作空间目录已更改
      await window.electronAPI.workspace.notifyChanged(value.directory || '')
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

  /**
   * 获取应用版本
   */
  useEffect(() => {
    // TODO: 从 electronAPI 获取版本
    setAppVersion('0.1.2')
  }, [])

  /**
   * 获取工作空间路径：以主进程 getDir 为权威源并回填展示
   */
  useEffect(() => {
    window.electronAPI.workspace?.getDir().then((dir) => {
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
    window.electronAPI.app.getOpenAtLogin().then(setOpenAtLogin).catch(() => {
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
      const actual = await window.electronAPI.app.setOpenAtLogin(enable)
      setOpenAtLogin(actual)
      console.log('[SettingsPage] 开机启动设置完成:', actual)
      if (enable && !actual) {
        // 开发模式下 Electron 不支持 setLoginItemSettings；打包后失败可能是系统安全策略拦截
        const isDev = (await window.electronAPI.app.getVersion()).includes('dev')
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
          <h4 className={styles['panel-card-title']} data-app-ui-heading>录屏</h4>
          <div className={styles['panel-rows']}>
            <div className={styles['panel-row']}>
              <div className={styles['panel-row-text']}>
                <span className={styles['panel-row-label']}>启用录屏功能</span>
                <span className={styles['panel-row-hint']}>
                  关闭后 AI 录屏工具与顶栏入口均不可用
                </span>
              </div>
              <Checkbox
                checked={settings.screenRecord?.enabled !== false}
                onChange={(checked) =>
                  updateSettings({
                    screenRecord: {
                      ...(settings.screenRecord ?? {
                        enabled: true,
                        alwaysAllow: false,
                        includeMicDefault: true,
                        includeSystemAudioDefault: true,
                        exportMp4Default: false,
                        narrateOriginalAudioGain: 0.35,
                        confirmTimeoutSec: 120,
                      }),
                      enabled: checked,
                    },
                  })
                }
              />
            </div>
            <div className={styles['panel-row']}>
              <div className={styles['panel-row-text']}>
                <span className={styles['panel-row-label']}>始终允许录屏</span>
                <span className={`${styles['panel-row-hint']} ${styles['panel-row-hint-warn']}`}>
                  开启后 Agent 可不经确认录制除本软件外的任意屏幕与窗口，请谨慎
                </span>
              </div>
              <Checkbox
                checked={settings.screenRecord?.alwaysAllow === true}
                onChange={(checked) =>
                  updateSettings({
                    screenRecord: {
                      ...(settings.screenRecord ?? {
                        enabled: true,
                        alwaysAllow: false,
                        includeMicDefault: true,
                        includeSystemAudioDefault: true,
                        exportMp4Default: false,
                        narrateOriginalAudioGain: 0.35,
                        confirmTimeoutSec: 120,
                      }),
                      alwaysAllow: checked,
                    },
                  })
                }
              />
            </div>
            <div className={styles['panel-row']}>
              <div className={styles['panel-row-text']}>
                <span className={styles['panel-row-label']}>默认包含麦克风</span>
                <span className={styles['panel-row-hint']}>新录制时「包含麦克风」开关的默认值</span>
              </div>
              <Checkbox
                checked={settings.screenRecord?.includeMicDefault !== false}
                onChange={(checked) =>
                  updateSettings({
                    screenRecord: {
                      ...(settings.screenRecord ?? {
                        enabled: true,
                        alwaysAllow: false,
                        includeMicDefault: true,
                        includeSystemAudioDefault: true,
                        exportMp4Default: false,
                        narrateOriginalAudioGain: 0.35,
                        confirmTimeoutSec: 120,
                      }),
                      includeMicDefault: checked,
                    },
                  })
                }
              />
            </div>
            <div className={styles['panel-row']}>
              <div className={styles['panel-row-text']}>
                <span className={styles['panel-row-label']}>默认包含系统声音</span>
                <span className={styles['panel-row-hint']}>
                  整屏录制时较可靠；单窗口可能无系统声（会自动降级）
                </span>
              </div>
              <Checkbox
                checked={settings.screenRecord?.includeSystemAudioDefault !== false}
                onChange={(checked) =>
                  updateSettings({
                    screenRecord: {
                      ...(settings.screenRecord ?? {
                        enabled: true,
                        alwaysAllow: false,
                        includeMicDefault: true,
                        includeSystemAudioDefault: true,
                        exportMp4Default: false,
                        narrateOriginalAudioGain: 0.35,
                        confirmTimeoutSec: 120,
                      }),
                      includeSystemAudioDefault: checked,
                    },
                  })
                }
              />
            </div>
            <div className={styles['panel-row']}>
              <div className={styles['panel-row-text']}>
                <span className={styles['panel-row-label']}>停止时默认导出 MP4</span>
                <span className={styles['panel-row-hint']}>
                  转码成功后删除源 WebM；失败则保留 WebM
                </span>
              </div>
              <Checkbox
                checked={settings.screenRecord?.exportMp4Default === true}
                onChange={(checked) =>
                  updateSettings({
                    screenRecord: {
                      ...(settings.screenRecord ?? {
                        enabled: true,
                        alwaysAllow: false,
                        includeMicDefault: true,
                        includeSystemAudioDefault: true,
                        exportMp4Default: false,
                        narrateOriginalAudioGain: 0.35,
                        confirmTimeoutSec: 120,
                      }),
                      exportMp4Default: checked,
                    },
                  })
                }
              />
            </div>
            <div className={styles['panel-row']}>
              <div className={styles['panel-row-text']}>
                <span className={styles['panel-row-label']}>旁白原声增益</span>
                <span className={styles['panel-row-hint']}>配音混流时原片音量（0–1，默认 0.35）</span>
              </div>
              <div className={styles['setting-input-with-unit']}>
                <Input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={settings.screenRecord?.narrateOriginalAudioGain ?? 0.35}
                  onChange={(e) =>
                    updateSettings({
                      screenRecord: {
                        ...(settings.screenRecord ?? {
                          enabled: true,
                          alwaysAllow: false,
                          includeMicDefault: true,
                          includeSystemAudioDefault: true,
                          exportMp4Default: false,
                          narrateOriginalAudioGain: 0.35,
                          confirmTimeoutSec: 120,
                        }),
                        narrateOriginalAudioGain: Math.min(
                          1,
                          Math.max(0, Number(e.target.value)),
                        ),
                      },
                    })
                  }
                />
              </div>
            </div>
            <div className={styles['panel-row']}>
              <div className={styles['panel-row-text']}>
                <span className={styles['panel-row-label']}>AI 确认超时（秒）</span>
                <span className={styles['panel-row-hint']}>超时未操作将自动拒绝</span>
              </div>
              <div className={styles['setting-input-with-unit']}>
                <Input
                  type="number"
                  min={10}
                  max={600}
                  step={5}
                  value={settings.screenRecord?.confirmTimeoutSec ?? 120}
                  onChange={(e) =>
                    updateSettings({
                      screenRecord: {
                        ...(settings.screenRecord ?? {
                          enabled: true,
                          alwaysAllow: false,
                          includeMicDefault: true,
                          includeSystemAudioDefault: true,
                          exportMp4Default: false,
                          narrateOriginalAudioGain: 0.35,
                          confirmTimeoutSec: 120,
                        }),
                        confirmTimeoutSec: Number(e.target.value),
                      },
                    })
                  }
                />
                <span className={styles['setting-unit']}>秒</span>
              </div>
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
                  const res = await window.electronAPI.app.openLogFile()
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

        <section className={styles['panel-card']}>
          <h4 className={styles['panel-card-title']} data-app-ui-heading>性能诊断</h4>
          <p className={styles['panel-card-desc']}>
            监控应用性能指标、IPC 调用延迟、内存占用，便于诊断性能问题
          </p>
          <div className={styles['panel-storage']}>
            <PerformanceDiagnostics />
          </div>
        </section>

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
            onClick={() => window.electronAPI.app.openExternal('https://github.com/lanxiake/lumii')}
          >
            项目主页
          </Button>
          <Button
            variant="secondary"
            onClick={() => window.electronAPI.app.openExternal('https://github.com/lanxiake/lumii/issues')}
          >
            问题反馈
          </Button>
        </div>
      </section>

      <section className={styles['panel-card']}>
        <h4 className={styles['panel-card-title']} data-app-ui-heading>软件更新</h4>
        <p className={styles['panel-card-desc']}>检查并安装新版本</p>
        <UpdaterView standalone />
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
      case 'workspace':
        return (
          <WorkspaceSection
            settings={settings}
            defaultWorkspaceDir={defaultWorkspaceDir}
            updateWorkspace={updateWorkspace}
            save={workspaceSave}
          />
        )
      case 'modelConfig':
        return <ModelConfigSection />
      case 'voice':
        return <VoiceSettingsSection />
      case 'channels':
        return renderChannelsSettings()
      case 'codingDev':
        return renderCodingDevSettings()
      case 'privacy':
        return renderPrivacySettings()
      case 'pet':
        return <PetSettingsSection />
      case 'usage':
        return <UsagePanel />
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
          {CATEGORIES.map((category) => (
            <button
              key={category.id}
              className={clsx(styles['settings-nav-item'], activeCategory === category.id && styles['active'])}
              onClick={() => setActiveCategory(category.id)}
            >
              <span className={styles['nav-icon']}>{category.icon}</span>
              <span className={styles['nav-label']}>{category.label}</span>
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
export default SettingsPage
