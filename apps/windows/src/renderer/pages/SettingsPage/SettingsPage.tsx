import React, { useState, useEffect, useCallback, ReactNode } from 'react'
import clsx from 'clsx'
import {
  User,
  FolderOpen,
  Radio,
  Bell,
  Shield,
  Keyboard,
  RefreshCw,
  Info,
  Lock,
  Smartphone,
  Mic,
  Cpu,
  Users,
  Wrench,
  Clock,
  Brain,
  Boxes,
  Plug,
} from '../../components/ui/Icon'
import type { ViewType } from '../../components/Router'
import { Card } from '../../components/ui/Card/Card'
import { Button } from '../../components/ui/Button/Button'
import { Input } from '../../components/ui/Input/Input'
import { Loading } from '../../components/ui/Loading/Loading'
import { Checkbox } from '../../components/ui/Checkbox/Checkbox'
import { Select } from '../../components/ui/Select/Select'
import { Badge } from '../../components/ui/Badge/Badge'
import { Tag } from '../../components/ui/Tag/Tag'
import { UpdaterView } from '../../components/business/UpdaterView'
import { useSettings, useCategorySettings } from '../../hooks/business/useSettings'
import { useToast } from '../../components/ui/Toast/useToast'
import { PageHeader } from '../../components/ui/PageHeader/PageHeader'
import { WeixinChannelSettings } from './components/WeixinChannelSettings'
import { CodingDevAcpPanel } from './components/CodingDevAcpPanel'
import { WecomChannelSettings } from './components/WecomChannelSettings'
import { FeishuChannelSettings } from './components/FeishuChannelSettings'
import { StorageInfo } from './components/StorageInfo'
import { SecurityLogViewer } from './components/SecurityLogViewer/SecurityLogViewer'
import { LumiiLogo } from '../../components/brand/LumiiLogo'
import {
  getProviderConfig,
  saveProviderConfig,
  listProviderModels,
  testProviderConnection,
  PROVIDER_DEFAULT_BASE_URL,
  PROVIDER_TYPE_LABEL,
  CAPABILITY_SLOT_LABEL,
  CAPABILITY_SLOT_DESC,
  CAPABILITY_SLOTS,
  createDefaultSlotsConfig,
  type LocalProviderConfigView,
  type ProviderSlotsConfigView,
  type ProviderType,
  type CapabilitySlot,
  type ListedModel,
} from '../../services/model-config-service'
import { getAgents, type Agent } from '../../services/agent-service'
import type { PetModelConfigDTO } from '../../../shared/pet-mode'
import {
  type VirtualHumanSettingsDTO,
  DEFAULT_VH_SETTINGS,
} from '../../../shared/virtual-human'
import styles from './SettingsPage.module.css'

/**
 * 设置分类
 */
type SettingsCategory = 'account' | 'workspace' | 'channels' | 'notification' | 'privacy' | 'shortcuts' | 'update' | 'about' | 'voice' | 'modelConfig' | 'pet' | 'mcp'

/**
 * 设置分类图标尺寸
 */
const SETTINGS_ICON_SIZE = 16

/**
 * 分类配置
 */
/**
 * 从侧边栏移入设置的功能页。这些是独立页面，不是设置面板，
 * 点击直接跳转，不切 activeCategory。
 */
const MOVED_PAGES: Array<{ id: ViewType; label: string; icon: ReactNode }> = [
  { id: 'agents', label: 'AI 团队', icon: <Users size={SETTINGS_ICON_SIZE} /> },
  { id: 'skills', label: '技能中心', icon: <Wrench size={SETTINGS_ICON_SIZE} /> },
  { id: 'cron', label: '定时任务', icon: <Clock size={SETTINGS_ICON_SIZE} /> },
  { id: 'memories', label: '记忆管理', icon: <Brain size={SETTINGS_ICON_SIZE} /> },
  { id: 'files', label: '文件管理', icon: <FolderOpen size={SETTINGS_ICON_SIZE} /> },
  { id: 'plugins', label: '插件中心', icon: <Plug size={SETTINGS_ICON_SIZE} /> },
]

const CATEGORIES: Array<{ id: SettingsCategory; label: string; icon: ReactNode }> = [
  { id: 'account', label: '通用', icon: <User size={SETTINGS_ICON_SIZE} /> },
  { id: 'workspace', label: '工作空间', icon: <FolderOpen size={SETTINGS_ICON_SIZE} /> },
  { id: 'modelConfig', label: '模型配置', icon: <Cpu size={SETTINGS_ICON_SIZE} /> },
  { id: 'voice', label: '语音设置', icon: <Mic size={SETTINGS_ICON_SIZE} /> },
  { id: 'mcp', label: 'MCP 服务', icon: <Boxes size={SETTINGS_ICON_SIZE} /> },
  { id: 'pet', label: '宠物模式', icon: <Smartphone size={SETTINGS_ICON_SIZE} /> },
  { id: 'channels', label: '渠道设置', icon: <Radio size={SETTINGS_ICON_SIZE} /> },
  { id: 'notification', label: '通知设置', icon: <Bell size={SETTINGS_ICON_SIZE} /> },
  { id: 'privacy', label: '隐私安全', icon: <Shield size={SETTINGS_ICON_SIZE} /> },
  { id: 'shortcuts', label: '快捷键', icon: <Keyboard size={SETTINGS_ICON_SIZE} /> },
  { id: 'update', label: '软件更新', icon: <RefreshCw size={SETTINGS_ICON_SIZE} /> },
  { id: 'about', label: '关于', icon: <Info size={SETTINGS_ICON_SIZE} /> },
]

/**
 * SettingsPage - 设置页面
 * 
 * 基于 SettingsView.tsx 重构
 * Gateway 连接设置
 * 工作空间设置
 * 主题、语言设置
 */
interface SettingsPageProps {
  /** 跳转到独立功能页（AI 团队 / 技能 / 定时任务 / 记忆 / 文件 / 插件中心） */
  onViewChange?: (view: ViewType) => void
}

const SettingsPage: React.FC<SettingsPageProps> = ({ onViewChange }) => {
  const toast = useToast()
  const {
    settings,
    hasChanges,
    updateNotification,
    updatePrivacy,
    updateWorkspace,
    updateSettings,
    saveSettings,
    resetSettings,
    exportSettings,
    importSettings,
  } = useSettings()
  
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>('account')
  const [appVersion, setAppVersion] = useState<string>('0.1.0')

  // 本地 LLM Provider 配置（按能力槽）
  const [providerSlots, setProviderSlots] = useState<ProviderSlotsConfigView | null>(null)
  const [providerLoading, setProviderLoading] = useState(false)
  const [providerSaving, setProviderSaving] = useState(false)
  const [slotModels, setSlotModels] = useState<Partial<Record<CapabilitySlot, ListedModel[]>>>({})
  const [slotListing, setSlotListing] = useState<Partial<Record<CapabilitySlot, boolean>>>({})
  const [slotTesting, setSlotTesting] = useState<Partial<Record<CapabilitySlot, boolean>>>({})
  const [expandedSlots, setExpandedSlots] = useState<Partial<Record<CapabilitySlot, boolean>>>({
    chat: true,
  })

  // 宠物模式 Agent + 模型 + 设置
  const PET_AGENT_STORAGE_KEY = 'mtbot:pet-agent-id'
  const [petAgents, setPetAgents] = useState<Agent[]>([])
  const [petAgentId, setPetAgentId] = useState<string>(() => localStorage.getItem(PET_AGENT_STORAGE_KEY) ?? '')
  const [vhModels, setVhModels] = useState<PetModelConfigDTO[]>([])
  const [vhCurrentModelId, setVhCurrentModelId] = useState<string>('')
  const [vhSettings, setVhSettings] = useState<VirtualHumanSettingsDTO>(DEFAULT_VH_SETTINGS)
  const [isPetModeActive, setIsPetModeActive] = useState<boolean>(false)
  
  // 账户设置状态

  // 工作空间设置状态
  const [defaultWorkspaceDir, setDefaultWorkspaceDir] = useState<string>('')
  
  // 开机启动状态
  const [openAtLogin, setOpenAtLogin] = useState(false)
  const [openAtLoginLoading, setOpenAtLoginLoading] = useState(false)
  const [resetConfirmPending, setResetConfirmPending] = useState(false)

  // 语音设置状态
  const [voiceConfig, setVoiceConfig] = useState<{
    asr: { provider: string; language?: string; apiKey?: string }
    tts: { provider: string; speed: number; volume: number; speakerId?: number; voice?: string }
    vad: { threshold: number; minSpeechMs: number; minSilenceMs: number; energyGateMultiplier: number }
    autoMuteMicWhileSpeaking: boolean
  } | null>(null)
  const [voiceSaving, setVoiceSaving] = useState(false)
  const [voicePreviewing, setVoicePreviewing] = useState(false)
  const previewAudioCtxRef = React.useRef<AudioContext | null>(null)

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
    setAppVersion('0.1.0')
  }, [])

  /**
   * 获取默认工作空间路径
   */
  useEffect(() => {
    window.electronAPI.workspace?.getDir().then((dir) => {
      setDefaultWorkspaceDir(dir)
    }).catch(() => {
      console.warn('[SettingsPage] 获取默认工作空间路径失败')
    })
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
   * 切换到宠物模式时加载 Agent 列表、模型列表与设置
   */
  useEffect(() => {
    if (activeCategory !== 'pet') return
    getAgents().then((r) => setPetAgents(r.agents ?? [])).catch(() => {})
    const pet = window.electronAPI?.pet
    if (!pet) return
    pet.listModels?.().then((m) => setVhModels(m ?? [])).catch(() => {})
    pet.getCurrentModelId?.().then(setVhCurrentModelId).catch(() => {})
    pet.getVirtualHumanSettings?.().then(setVhSettings).catch(() => {})
    pet.getMode?.().then((mode) => setIsPetModeActive(mode === 'pet')).catch(() => {})
  }, [activeCategory])

  /**
   * 订阅主进程宠物模式变更事件，同步"进入/退出"按钮文案（托盘/快捷键/控制坞等路径均会触发）
   */
  useEffect(() => {
    const handleModeChanged = (mode: unknown) => {
      setIsPetModeActive(mode === 'pet')
    }
    window.electronAPI.on('pet-mode-changed', handleModeChanged)
    return () => {
      window.electronAPI.off('pet-mode-changed', handleModeChanged)
    }
  }, [])

  /**
   * 切换到语音设置时加载配置
   */
  useEffect(() => {
    if (activeCategory !== 'voice') return
    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.voice?.sendCommand) return
    electronAPI.voice.sendCommand({ type: 'voice:config:get' }).then((cfg: any) => {
      if (cfg?.asr && cfg?.tts) setVoiceConfig(cfg)
    }).catch(() => {
      console.warn('[SettingsPage] 获取语音配置失败')
    })
  }, [activeCategory])

  /**
   * 切换到模型配置时加载全部能力槽
   */
  useEffect(() => {
    if (activeCategory !== 'modelConfig') return
    setProviderLoading(true)
    getProviderConfig()
      .then((cfg) => {
        setProviderSlots(cfg)
        setExpandedSlots({
          chat: true,
          vision: cfg.vision.enabled,
          image: cfg.image.enabled,
        })
      })
      .catch((err) => {
        console.warn('[SettingsPage] 读取 Provider 配置失败', err)
        toast.error('读取 Provider 配置失败')
        setProviderSlots(createDefaultSlotsConfig())
      })
      .finally(() => setProviderLoading(false))
  }, [activeCategory, toast])

  /**
   * 监听 TTS 预览音频块，接收后用 Web Audio API 播放
   */
  useEffect(() => {
    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.voice?.onEvent) return
    let nextStartTime = 0
    const unsubscribe = electronAPI.voice.onEvent((event: any) => {
      if (event.type !== 'voice:tts:preview:chunk') return
      const ctx = previewAudioCtxRef.current
      if (!ctx) return
      if (event.isFinal && (!event.samples || event.samples.length === 0)) {
        // 最后一个空帧：标记预览结束
        setVoicePreviewing(false)
        return
      }
      if (!event.samples || event.samples.length === 0) return
      try {
        if (event.sampleRate === -1) {
          // Edge TTS 编码音频（MP3），需解码
          const buf = new Uint8Array(event.samples).buffer
          ctx.decodeAudioData(buf).then((decoded) => {
            const source = ctx.createBufferSource()
            source.buffer = decoded
            source.connect(ctx.destination)
            const now = ctx.currentTime
            const start = Math.max(now + 0.04, nextStartTime)
            source.start(start)
            nextStartTime = start + decoded.duration
            if (event.isFinal) source.addEventListener('ended', () => setVoicePreviewing(false))
          }).catch(() => setVoicePreviewing(false))
        } else {
          const samples = new Float32Array(event.samples)
          const buffer = ctx.createBuffer(1, samples.length, event.sampleRate)
          buffer.copyToChannel(samples, 0)
          const source = ctx.createBufferSource()
          source.buffer = buffer
          source.connect(ctx.destination)
          const now = ctx.currentTime
          const start = Math.max(now + 0.04, nextStartTime)
          source.start(start)
          nextStartTime = start + buffer.duration
        }
      } catch (e) {
        console.warn('[SettingsPage] 预览音频播放失败:', e)
        setVoicePreviewing(false)
      }
    })
    return () => {
      unsubscribe?.()
      previewAudioCtxRef.current?.close().catch(() => {})
      previewAudioCtxRef.current = null
    }
  }, [])

  /**
   * 选择工作空间目录
   */
  const handleSelectWorkspaceDir = useCallback(async () => {
    try {
      const selectedDir = await window.electronAPI.workspace.selectDir(
        settings.workspace.directory || defaultWorkspaceDir
      )
      if (selectedDir) {
        updateWorkspace({ directory: selectedDir })
      }
    } catch (err) {
      console.error('[SettingsPage] 选择工作空间目录失败:', err)
      toast.error(err instanceof Error ? err.message : '选择目录失败')
    }
  }, [settings.workspace.directory, defaultWorkspaceDir, updateWorkspace, toast])

  /**
   * 恢复默认工作空间目录
   */
  const handleResetWorkspaceDir = useCallback(async () => {
    console.log('[SettingsPage] 恢复默认工作空间目录')
    updateWorkspace({ directory: '' })
  }, [updateWorkspace])

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
        // 开发模式下 Electron 不支持 setLoginItemSettings，给出明确提示
        toast.error('开发模式下无法设置开机启动，打包后生效')
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
   * 清除本地数据（仅清除 localStorage 设置）
   */
  const handleClearData = useCallback(() => {
    localStorage.removeItem('mtbot-assistant-settings')
    localStorage.removeItem('mtbot_app_settings')
    window.location.reload()
  }, [])

  /**
   * 重置所有数据 - 清除配置文件、认证信息并重启应用
   * 第一次点击进入确认状态，第二次点击执行重置
   */
  const handleResetAll = useCallback(async () => {
    if (!resetConfirmPending) {
      setResetConfirmPending(true)
      return
    }

    setResetConfirmPending(false)
    try {
      // 清除渲染进程 localStorage
      localStorage.removeItem('mtbot-assistant-settings')
      localStorage.removeItem('mtbot_app_settings')
      localStorage.removeItem('mtbot_access_token')
      localStorage.removeItem('mtbot_refresh_token')
      localStorage.removeItem('mtbot_user')

      // 通知主进程清除配置文件并重启
      await window.electronAPI.app.resetAllData()
    } catch (err) {
      console.error('[SettingsPage] 重置失败:', err)
      toast.error(`重置失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [resetConfirmPending, toast])

  /**
   * 导出设置
   */
  const handleExport = useCallback(async () => {
    const json = exportSettings()
    try {
      await window.electronAPI.clipboard.writeText(json)
      toast.success('设置已复制到剪贴板')
    } catch (err) {
      console.error('[SettingsPage] 导出设置失败:', err)
      toast.error('导出失败')
    }
  }, [exportSettings, toast])

  /**
   * 导入设置
   */
  const handleImport = useCallback(async () => {
    try {
      const json = await window.electronAPI.clipboard.readText()
      if (importSettings(json)) {
        toast.success('设置已导入')
      } else {
        toast.error('导入失败：无效的设置数据')
      }
    } catch (err) {
      console.error('[SettingsPage] 导入设置失败:', err)
      toast.error('导入失败')
    }
  }, [importSettings, toast])

  /**
   * 渲染账户设置
   */
  const renderAccountSettings = () => (
    <div className={styles['settings-section']}>
      <h3>通用</h3>

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
      </div>
    </div>
  )

  /**
   * 渲染工作空间设置
   */
  const renderWorkspaceSettings = () => {
    return (
      <div className={styles['settings-section']}>
        <h3>
          工作空间
          {workspaceSave.hasChanges && <Badge dot />}
        </h3>

        <div className={styles['setting-group']}>
          <div className={styles['setting-item']}>
            <label className={styles['setting-label']}>工作空间目录</label>
            <div className={styles['setting-hint']}>
              技能、命令、文件等默认存放在工作空间目录中。
              {!settings.workspace.directory && ' 当前使用默认路径。'}
            </div>
            <div className={styles['setting-row']}>
              <Input
                value={settings.workspace.directory || defaultWorkspaceDir}
                readOnly
                placeholder="未设置（使用默认路径）"
              />
              <Button onClick={handleSelectWorkspaceDir}>
                选择目录
              </Button>
            </div>
          </div>

          {settings.workspace.directory && (
            <div className={styles['setting-item']}>
              <Button
                variant="secondary"
                onClick={handleResetWorkspaceDir}
              >
                恢复默认
              </Button>
            </div>
          )}
        </div>

        <p className={styles['settings-note']}>
          更改工作空间目录后点击保存即可生效，无需重启。Agent 与命令执行将使用新目录；
          已安装的技能不会自动迁移到新目录。工作空间内文件被用户或 Agent 修改后，
          下次读取或执行时会自动看到最新内容，无需额外操作。
        </p>

        <div className={styles['category-save-actions']}>
          <Button
            onClick={workspaceSave.save}
            loading={workspaceSave.isSaving}
            disabled={workspaceSave.isSaving || !workspaceSave.hasChanges}
          >
            {workspaceSave.saveStatus === 'saved'
              ? '✓ 已保存'
              : workspaceSave.saveStatus === 'error'
                ? '保存失败'
                : workspaceSave.hasChanges
                  ? '保存工作空间设置'
                  : '无更改'}
          </Button>
        </div>
      </div>
    )
  }

  const renderChannelsSettings = () => {
    return (
      <div className={styles['settings-section']}>
        <h3>渠道设置</h3>
        <p style={{ fontSize: 13, color: 'var(--mt-fg-3)', margin: '0 0 16px' }}>
          配置各个即时通信渠道的接入与登录状态。
        </p>
        {/* 个人微信 / 企业微信 / 飞书 置顶并排 */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: 12,
            marginBottom: 12,
          }}
        >
          <WeixinChannelSettings />
          <WecomChannelSettings />
          <FeishuChannelSettings />
        </div>
        <CodingDevAcpPanel />
      </div>
    )
  }

  /**
   * 渲染通知设置
   */
  const renderNotificationSettings = () => {
    return (
      <div className={styles['settings-section']}>
        <h3>
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
   * 渲染隐私设置
   */
  const renderPrivacySettings = () => {
    return (
      <div className={styles['settings-section']}>
        <h3>
          隐私与安全
          {privacySave.hasChanges && <Badge dot />}
        </h3>

        <h4 className={styles['settings-subsection-title']}>安全设置</h4>

        <div className={styles['setting-group']}>
            <div className={styles['security-card']}>
            <div className={styles['security-card-header']}>
              <span className={styles['security-icon']}><Lock size={18} /></span>
              <div className={styles['security-card-info']}>
                <span className={styles['security-card-title']}>两步验证</span>
                <span className={styles['security-card-desc']}>通过手机验证码或认证器 App 增加账户安全性</span>
              </div>
            </div>
            <Tag color="default">即将推出</Tag>
          </div>

          <div className={styles['security-card']}>
            <div className={styles['security-card-header']}>
              <span className={styles['security-icon']}><Smartphone size={18} /></span>
              <div className={styles['security-card-info']}>
                <span className={styles['security-card-title']}>登录设备管理</span>
                <span className={styles['security-card-desc']}>查看和管理已登录的设备，可远程注销可疑设备</span>
              </div>
            </div>
            <Tag color="default">即将推出</Tag>
          </div>
        </div>

        <h4 className={styles['settings-subsection-title']}>本地安全日志</h4>
        <p className={styles['setting-hint']} style={{ marginBottom: 8 }}>
          查看 AI 工具与权限相关操作摘要（最近 20 条，存于本机数据库）
        </p>
        <div className={styles['setting-group']}>
          <SecurityLogViewer />
        </div>

        <h4 className={styles['settings-subsection-title']}>隐私偏好</h4>

        <div className={styles['setting-group']}>
          <div className={styles['setting-item']}>
            <Checkbox
              checked={settings.privacy.saveChatHistory}
              onChange={(checked) => updatePrivacy({ saveChatHistory: checked })}
            >
              保存聊天历史
            </Checkbox>
            <span className={styles['setting-hint']}>关闭后将不会在本地保存聊天记录</span>
          </div>

          {settings.privacy.saveChatHistory && (
            <div className={styles['setting-item']}>
              <label className={styles['setting-label']}>历史记录保留天数</label>
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

          <div className={styles['setting-item']}>
            <Checkbox
              checked={settings.privacy.sendUsageStats}
              onChange={(checked) => updatePrivacy({ sendUsageStats: checked })}
            >
              发送匿名使用统计
            </Checkbox>
            <span className={styles['setting-hint']}>帮助我们改进产品体验</span>
          </div>
        </div>

        <h4 className={styles['settings-subsection-title']}>数据管理</h4>

        <div className={styles['setting-group']}>
          <div className={styles['setting-actions']}>
            <Button variant="secondary" onClick={handleExport}>
              导出设置
            </Button>
            <Button variant="secondary" onClick={handleImport}>
              导入设置
            </Button>
            <Button variant="danger" onClick={handleClearData}>
              清除数据
            </Button>
          </div>
        </div>

        <StorageInfo toast={toast} />

        <h4 className="settings-subsection-title">恢复出厂设置</h4>

        <div className="setting-group">
          <div className="setting-item">
            <div className="setting-info">
              <span className="setting-label">重置所有设置</span>
              <span className="setting-hint">
                {resetConfirmPending
                  ? '⚠️ 确认后将清除所有配置文件、登录状态和缓存，应用自动重启，不可恢复'
                  : '清除所有配置文件、登录状态和缓存，应用将自动重启'}
              </span>
            </div>
          </div>
          <div className="setting-actions">
            {resetConfirmPending ? (
              <>
                <Button variant="secondary" onClick={() => setResetConfirmPending(false)}>
                  取消
                </Button>
                <Button variant="danger" onClick={handleResetAll}>
                  确认重置
                </Button>
              </>
            ) : (
              <Button variant="danger" onClick={handleResetAll}>
                重置并重启
              </Button>
            )}
          </div>
        </div>

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
                  : '保存隐私设置'}
            </Button>
          </div>
        )}
      </div>
    )
  }

  /** 更新指定能力槽字段（切换类型时同步默认 baseUrl） */
  const patchSlot = useCallback((slot: CapabilitySlot, patch: Partial<LocalProviderConfigView>) => {
    setProviderSlots((prev) => {
      if (!prev) return prev
      const current = prev[slot]
      const nextSlot = { ...current, ...patch }
      if (patch.type && patch.type !== current.type) {
        nextSlot.baseUrl = PROVIDER_DEFAULT_BASE_URL[patch.type]
      }
      if (patch.enabled === true) {
        setExpandedSlots((e) => ({ ...e, [slot]: true }))
      }
      return { ...prev, [slot]: nextSlot }
    })
  }, [])

  /** 从文本对话槽复制 Provider 凭据到目标槽（保留目标 modelId） */
  const copyFromChat = useCallback((slot: CapabilitySlot) => {
    if (slot === 'chat') return
    setProviderSlots((prev) => {
      if (!prev) return prev
      const chat = prev.chat
      return {
        ...prev,
        [slot]: {
          ...prev[slot],
          type: chat.type,
          baseUrl: chat.baseUrl,
          apiKey: chat.apiKey,
          enabled: true,
        },
      }
    })
    setExpandedSlots((e) => ({ ...e, [slot]: true }))
    toast.success(`已从「文本对话」复制到「${CAPABILITY_SLOT_LABEL[slot]}」`)
  }, [toast])

  /** 拉取指定槽模型列表 */
  const handleListModels = useCallback(async (slot: CapabilitySlot) => {
    if (!providerSlots) return
    setSlotListing((s) => ({ ...s, [slot]: true }))
    try {
      // 先保存当前草稿到主进程，保证拉列表用最新凭据
      await saveProviderConfig(providerSlots)
      const models = await listProviderModels(slot)
      setSlotModels((m) => ({ ...m, [slot]: models }))
      if (models.length === 0) {
        toast.warning('未获取到模型，可手动填写模型 ID')
      } else {
        toast.success(`已获取 ${models.length} 个模型`)
      }
    } catch (err) {
      console.error('[SettingsPage] 获取模型列表失败', err)
      toast.error(err instanceof Error ? err.message : '获取模型列表失败')
    } finally {
      setSlotListing((s) => ({ ...s, [slot]: false }))
    }
  }, [providerSlots, toast])

  /** 测试指定槽连通性 */
  const handleTestSlot = useCallback(async (slot: CapabilitySlot) => {
    if (!providerSlots) return
    setSlotTesting((s) => ({ ...s, [slot]: true }))
    try {
      // 测试前自动启用该槽，避免「配好了但没开」
      const nextSlots = {
        ...providerSlots,
        [slot]: { ...providerSlots[slot], enabled: true },
      }
      setProviderSlots(nextSlots)
      setExpandedSlots((s) => ({ ...s, [slot]: true }))
      await saveProviderConfig(nextSlots)
      const result = await testProviderConnection(slot)
      if (result.ok) {
        toast.success(result.message)
        window.dispatchEvent(new CustomEvent('mtbot:provider-config-changed'))
        if (slot === 'chat' && nextSlots.chat.modelId) {
          window.dispatchEvent(
            new CustomEvent('mtbot:chat-model-changed', { detail: { modelId: nextSlots.chat.modelId } }),
          )
        }
      } else {
        toast.error(result.message)
      }
    } catch (err) {
      console.error('[SettingsPage] 测试连接失败', err)
      toast.error(err instanceof Error ? err.message : '测试连接失败')
    } finally {
      setSlotTesting((s) => ({ ...s, [slot]: false }))
    }
  }, [providerSlots, toast])

  /** 保存全部能力槽配置 */
  const handleSaveProvider = useCallback(async () => {
    if (!providerSlots) return
    setProviderSaving(true)
    try {
      const saved = await saveProviderConfig(providerSlots)
      setProviderSlots(saved)
      window.dispatchEvent(new CustomEvent('mtbot:provider-config-changed'))
      if (saved.chat.enabled && saved.chat.modelId) {
        window.dispatchEvent(
          new CustomEvent('mtbot:chat-model-changed', { detail: { modelId: saved.chat.modelId } }),
        )
      }
      toast.success('模型能力槽配置已保存')
    } catch (err) {
      console.error('[SettingsPage] 保存 Provider 配置失败', err)
      toast.error('保存 Provider 配置失败')
    } finally {
      setProviderSaving(false)
    }
  }, [providerSlots, toast])

  /**
   * 渲染单个能力槽卡片
   */
  const renderSlotCard = (slot: CapabilitySlot) => {
    if (!providerSlots) return null
    const cfg = providerSlots[slot]
    const isLocalProvider = cfg.type === 'ollama' || cfg.type === 'lmstudio'
    const expanded = expandedSlots[slot] === true
    const models = slotModels[slot] ?? []

    return (
      <Card key={slot}>
        <div className={styles['setting-item']}>
          <div className={styles['setting-label']}>
            <span>{CAPABILITY_SLOT_LABEL[slot]}</span>
            <span className={styles['setting-desc']}>{CAPABILITY_SLOT_DESC[slot]}</span>
          </div>
          <div className={styles['setting-control']} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {slot !== 'chat' && (
              <Button variant="secondary" size="sm" onClick={() => copyFromChat(slot)}>
                从文本对话复制
              </Button>
            )}
            <div className={styles['slot-enable-group']} role="group" aria-label={`${CAPABILITY_SLOT_LABEL[slot]}启停`}>
              <button
                type="button"
                className={`${styles['slot-enable-btn']} ${cfg.enabled ? styles['slot-enable-btn--on'] : ''}`}
                onClick={() => {
                  patchSlot(slot, { enabled: true })
                  setExpandedSlots((s) => ({ ...s, [slot]: true }))
                }}
              >
                已启用
              </button>
              <button
                type="button"
                className={`${styles['slot-enable-btn']} ${!cfg.enabled ? styles['slot-enable-btn--off'] : ''}`}
                onClick={() => patchSlot(slot, { enabled: false })}
              >
                未启用
              </button>
            </div>
            <button
              type="button"
              className={styles['about-link']}
              onClick={() => setExpandedSlots((s) => ({ ...s, [slot]: !expanded }))}
            >
              {expanded ? '收起配置' : '展开配置'}
            </button>
          </div>
        </div>

        {expanded && (
          <>
            <div className={styles['setting-item']}>
              <div className={styles['setting-label']}>
                <span>Provider 类型</span>
              </div>
              <div className={styles['setting-control']}>
                <Select
                  value={cfg.type}
                  options={(Object.keys(PROVIDER_TYPE_LABEL) as ProviderType[]).map((t) => ({
                    value: t,
                    label: PROVIDER_TYPE_LABEL[t],
                  }))}
                  onChange={(e) => patchSlot(slot, { type: e.target.value as ProviderType })}
                />
              </div>
            </div>

            <div className={styles['setting-item']}>
              <div className={styles['setting-label']}>
                <span>接口地址（Base URL）</span>
                <span className={styles['setting-desc']}>
                  无需手写 /v1，保存与调用时会自动补全（OpenAI 兼容 / Ollama / LM Studio）
                </span>
              </div>
              <div className={styles['setting-control']}>
                <Input
                  type="text"
                  value={cfg.baseUrl}
                  placeholder={PROVIDER_DEFAULT_BASE_URL[cfg.type]}
                  onChange={(e) => patchSlot(slot, { baseUrl: e.target.value })}
                />
              </div>
            </div>

            <div className={styles['setting-item']}>
              <div className={styles['setting-label']}>
                <span>API Key</span>
                {isLocalProvider && (
                  <span className={styles['setting-desc']}>本地 Provider 通常无需填写</span>
                )}
              </div>
              <div className={styles['setting-control']}>
                <Input
                  type="password"
                  value={cfg.apiKey}
                  placeholder={isLocalProvider ? '（可留空）' : 'sk-...'}
                  onChange={(e) => patchSlot(slot, { apiKey: e.target.value })}
                />
              </div>
            </div>

            <div className={styles['setting-item']}>
              <div className={styles['setting-label']}>
                <span>模型 ID</span>
                <span className={styles['setting-desc']}>
                  {slot === 'image'
                    ? '请填写或从列表选择，如 dall-e-3 / gpt-image-1'
                    : slot === 'vision'
                      ? '请填写或从列表选择，如 gpt-4o / claude-sonnet'
                      : '请填写或从列表选择，如 deepseek-chat / gpt-4o'}
                </span>
              </div>
              <div className={styles['setting-control']} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {models.length > 0 ? (
                  <Select
                    value={cfg.modelId}
                    options={[
                      { value: '', label: '（请选择模型）' },
                      ...models.map((m) => ({ value: m.id, label: m.name })),
                      ...(cfg.modelId && !models.some((m) => m.id === cfg.modelId)
                        ? [{ value: cfg.modelId, label: `${cfg.modelId}（当前）` }]
                        : []),
                    ]}
                    onChange={(e) => patchSlot(slot, { modelId: e.target.value })}
                  />
                ) : (
                  <Input
                    type="text"
                    value={cfg.modelId}
                    placeholder="请输入模型 ID"
                    onChange={(e) => patchSlot(slot, { modelId: e.target.value })}
                  />
                )}
              </div>
            </div>

            <div className={styles['category-save-actions']} style={{ gap: 8 }}>
              <Button
                variant="secondary"
                loading={!!slotListing[slot]}
                onClick={() => { void handleListModels(slot) }}
              >
                获取模型列表
              </Button>
              <Button
                variant="secondary"
                loading={!!slotTesting[slot]}
                onClick={() => { void handleTestSlot(slot) }}
              >
                测试连接
              </Button>
            </div>
          </>
        )}
      </Card>
    )
  }

  /**
   * 渲染模型配置页面（按能力槽独立 Provider）
   */
  const renderModelConfigSettings = () => {
    if (providerLoading || !providerSlots) {
      return (
        <div className={styles['settings-section']}>
          <Loading text="加载中..." />
        </div>
      )
    }
    return (
      <div className={styles['settings-section']}>
        <h3>模型能力槽</h3>
        <p className={styles['setting-desc']} style={{ marginBottom: 16 }}>
          每个能力可使用不同提供商（例如对话用 DeepSeek，生图用 OpenAI）。
          「已启用 / 未启用」控制该能力是否真正生效：未启用时即使填了 Key 也不会调用，便于临时关闭而不丢配置。
          测试连接成功时会自动设为已启用。语音 ASR/TTS 请在下方「语音设置」中配置。
        </p>
        {CAPABILITY_SLOTS.map((slot) => (
          <div key={slot} style={{ marginBottom: 12 }}>
            {renderSlotCard(slot)}
          </div>
        ))}
        <div className={styles['category-save-actions']}>
          <Button onClick={() => { void handleSaveProvider() }} loading={providerSaving}>
            保存全部
          </Button>
        </div>
      </div>
    )
  }

  /**
   * 渲染宠物模式设置
   */
  const renderPetSettings = () => {
    const currentModel = vhModels.find((m) => m.id === vhCurrentModelId) ?? vhModels[0]
    const patchVh = async (patch: Partial<VirtualHumanSettingsDTO>) => {
      setVhSettings((prev) => ({ ...prev, ...patch }))
      try {
        const next = await window.electronAPI?.pet?.setVirtualHumanSettings?.(patch)
        if (next) setVhSettings(next)
      } catch { /* 忽略 */ }
    }
    return (
    <div className={styles['settings-section']}>
      <h3>宠物模式</h3>
      <Card>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 13, lineHeight: 1.6, margin: 0 }}>
            进入宠物模式后，桌面会出现一个可交互的 Live2D 虚拟人。你可以语音或文字与它对话，
            它会用表情、口型和动作回应。主界面将隐藏到后台，随时可退出恢复。
          </p>
          <ul style={{ color: 'var(--color-text-secondary)', fontSize: 12, lineHeight: 1.8, margin: 0, paddingLeft: 18 }}>
            <li>三种进入方式：本页按钮 / 托盘菜单 / 快捷键 <strong>Ctrl+Shift+P</strong></li>
            <li>虚拟人身体默认点击穿透，悬停到控制坞时恢复点击；<strong>Ctrl+Shift+I</strong> 切换强制穿透</li>
            <li>对话跟随当前会话，退出后聊天记录连续</li>
          </ul>

          {/* 模型选择器 + 缩略图 */}
          <div className={styles['setting-item']}>
            <label className={styles['setting-label']}>虚拟人模型</label>
            <span className={styles['setting-hint']}>切换后立即生效（已在宠物模式时热重载）</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {currentModel?.thumbnailUrl && (
                <img
                  src={currentModel.thumbnailUrl}
                  alt={currentModel.name}
                  style={{ width: 48, height: 48, borderRadius: 8, objectFit: 'cover', background: 'rgba(0,0,0,0.1)' }}
                />
              )}
              <Select
                value={vhCurrentModelId || currentModel?.id || ''}
                options={vhModels.map((m) => ({ value: m.id, label: m.name }))}
                onChange={(e) => {
                  const id = e.target.value
                  setVhCurrentModelId(id)
                  void window.electronAPI?.pet?.setCurrentModelId?.(id)
                }}
                className={styles['setting-select']}
              />
            </div>
          </div>

          {/* 跟随模型默认 Agent */}
          <div className={styles['setting-item']}>
            <Checkbox
              checked={vhSettings.followModelAgent}
              onChange={(checked) => void patchVh({ followModelAgent: checked })}
            >
              跟随模型默认 Agent
            </Checkbox>
            <span className={styles['setting-hint']}>开启时使用模型绑定的 Agent，关闭后用下方全局 Agent</span>
          </div>

          {/* 对话 Agent（全局覆盖） */}
          <div className={styles['setting-item']}>
            <label className={styles['setting-label']}>对话 Agent</label>
            <span className={styles['setting-hint']}>
              {vhSettings.followModelAgent ? '已跟随模型默认 Agent，此项被忽略' : '全局覆盖：虚拟人对话使用的 Agent'}
            </span>
            <Select
              value={vhSettings.agentId}
              options={[
                { value: '', label: '跟随当前会话（默认）' },
                ...petAgents.map((a) => ({ value: a.id, label: a.identity?.emoji ? `${a.identity.emoji} ${a.name}` : a.name })),
              ]}
              onChange={(e) => {
                const id = e.target.value
                setPetAgentId(id)
                void patchVh({ agentId: id })
              }}
              className={styles['setting-select']}
            />
          </div>

          {/* 表情标签开关 */}
          <div className={styles['setting-item']}>
            <Checkbox
              checked={vhSettings.enableExpressionPrompt}
              onChange={(checked) => void patchVh({ enableExpressionPrompt: checked })}
            >
              启用表情标签
            </Checkbox>
            <span className={styles['setting-hint']}>注入表情说明，让虚拟人根据情绪切换面部表情（[joy] 等）</span>
          </div>

          {/* 动作描写开关 */}
          <div className={styles['setting-item']}>
            <Checkbox
              checked={vhSettings.enableThinkTagPrompt}
              onChange={(checked) => void patchVh({ enableThinkTagPrompt: checked })}
            >
              启用动作/神态描写
            </Checkbox>
            <span className={styles['setting-hint']}>允许虚拟人用 &lt;vh_action&gt; 描写动作神态（不会被朗读）</span>
          </div>

          {/* 声音开关：文字回复是否朗读 */}
          <div className={styles['setting-item']}>
            <Checkbox
              checked={vhSettings.enableVoiceReply}
              onChange={(checked) => void patchVh({ enableVoiceReply: checked })}
            >
              文字回复朗读
            </Checkbox>
            <span className={styles['setting-hint']}>开启后文字对话也合成语音并用真实音频驱动口型；关闭则静默，用模拟口型</span>
          </div>

          {/* 待机随机动作 */}
          <div className={styles['setting-item']}>
            <Checkbox
              checked={vhSettings.enableIdleMotion}
              onChange={(checked) => void patchVh({ enableIdleMotion: checked })}
            >
              待机随机动作
            </Checkbox>
            <span className={styles['setting-hint']}>关闭后仅循环基础 Idle；对话结束后 10 秒才恢复随机动作</span>
          </div>

          {/* 鼠标点击控制 */}
          <div className={styles['setting-item']}>
            <Checkbox
              checked={vhSettings.enableTapInteraction}
              onChange={(checked) => void patchVh({ enableTapInteraction: checked })}
            >
              鼠标点击控制
            </Checkbox>
            <span className={styles['setting-hint']}>开启后在宠物模式点击宠物身体区域，触发对应的互动动作</span>
          </div>

          {/* 强制穿透默认值 */}
          <div className={styles['setting-item']}>
            <Checkbox
              checked={vhSettings.forceIgnoreMouse}
              onChange={(checked) => void patchVh({ forceIgnoreMouse: checked })}
            >
              默认开启强制穿透
            </Checkbox>
            <span className={styles['setting-hint']}>开启后进入宠物模式时鼠标仅穿透宠物身体（控制坞仍可点击）；已在宠物模式时立即生效。也可用 Ctrl+Shift+I 临时切换</span>
          </div>

          {/* 主动联系 */}
          <div className={styles['setting-item']}>
            <Checkbox
              checked={vhSettings.proactiveCareEnabled}
              onChange={(checked) => void patchVh({ proactiveCareEnabled: checked })}
            >
              开启主动联系
            </Checkbox>
            <span className={styles['setting-hint']}>仅在宠物模式下生效；需保持客户端运行</span>
          </div>

          {vhSettings.proactiveCareEnabled && (
            <>
              <div className={styles['setting-item']}>
                <label className={styles['setting-label']}>联系频率</label>
                <Select
                  value={vhSettings.proactiveCareMode}
                  options={[
                    { value: 'gentle', label: '温和' },
                    { value: 'active', label: '热情' },
                  ]}
                  onChange={(e) => {
                    const mode = e.target.value === 'active' ? 'active' : 'gentle'
                    void patchVh({ proactiveCareMode: mode })
                  }}
                  className={styles['setting-select']}
                />
              </div>

              <div className={styles['setting-item']}>
                <label className={styles['setting-label']}>怎么称呼你</label>
                <span className={styles['setting-hint']}>虚拟人在主动联系消息里会用这个称呼（可不填）</span>
                <Input
                  value={vhSettings.proactiveCareNickname}
                  onChange={(e) => void patchVh({ proactiveCareNickname: e.target.value })}
                  placeholder="比如：小明、老王"
                  maxLength={30}
                />
              </div>
            </>
          )}

          <div>
            <Button
              variant="primary"
              onClick={async () => {
                const target = isPetModeActive ? 'desktop' : 'pet'
                const r = await window.electronAPI?.pet?.switchMode(target)
                if (r && !r.success) {
                  toast.error(`${isPetModeActive ? '退出' : '进入'}宠物模式失败：${r.error ?? '未知错误'}`)
                }
              }}
            >
              {isPetModeActive ? '退出宠物模式' : '进入宠物模式'}
            </Button>
          </div>
        </div>
      </Card>
    </div>
    )
  }

  /**
   * 渲染关于页面
   */
  const renderAboutSettings = () => (
    <div className={styles['settings-section']}>
      <h3>关于灵栖 Lumii</h3>

      <div className={styles['about-content']}>
        <div className={styles['about-logo']}>
          <LumiiLogo size={64} />
        </div>
        <h2 className={styles['about-name']}>灵栖 Lumii</h2>
        <p className={styles['about-version']}>版本 {appVersion}</p>

        <div className={styles['about-links']}>
          <button
            className={styles['about-link']}
            onClick={() => window.electronAPI.app.openExternal('https://github.com/open-source/lumii')}
          >
            GitHub
          </button>
          <button
            className={styles['about-link']}
            onClick={() => window.electronAPI.app.openExternal('https://github.com/open-source/lumii/issues')}
          >
            问题反馈
          </button>
        </div>

        <p className={styles['about-description']}>
          灵栖 Lumii 是本地优先的 AI 桌面伙伴，在你的设备上运行智能助理，
          管理文件、执行任务、连接常用渠道。
        </p>

        <div className={styles['about-footer']}>
          <p>© 2026 Lumii</p>
          <p>开源独立版</p>
        </div>
      </div>
    </div>
  )

  /**
   * 渲染 MCP 服务设置
   *
   * 客户端目前没有 MCP 模块，这里如实说明现状并给出替代路径，
   * 不做一个点得动但什么都不发生的假开关。
   */
  const renderMcpSettings = () => (
    <div className={styles['settings-section']}>
      <h3>MCP 服务</h3>

      <div className={styles['setting-group']}>
        <div className={styles['setting-item']}>
          <div className={styles['setting-label']}>
            <span>当前状态</span>
            <span className={styles['setting-hint']}>
              尚未接入 Model Context Protocol。灵栖现在通过「技能」扩展能力：
              技能是磁盘上的 SKILL.md 加脚本，由本机执行器运行，能力边界和 MCP 类似但不依赖常驻服务进程。
            </span>
          </div>
          <Tag>未实现</Tag>
        </div>

        <div className={styles['setting-item']}>
          <div className={styles['setting-label']}>
            <span>替代路径</span>
            <span className={styles['setting-hint']}>
              需要扩展工具能力时，先到技能中心安装或编写技能。
            </span>
          </div>
          <Button variant="secondary" onClick={() => onViewChange?.('skills')}>
            前往技能中心
          </Button>
        </div>
      </div>
    </div>
  )

  /**
   * 渲染快捷键设置
   */
  const renderShortcutsSettings = () => (
    <div className={styles['settings-section']}>
      <h3>快捷键</h3>

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
   * 渲染更新设置
   */
  const renderUpdateSettings = () => (
    <div className={styles['settings-section']}>
      <h3>软件更新</h3>
      <UpdaterView standalone />
      
        <div className={styles['setting-group']} style={{ marginTop: '20px' }}>
        <div className={styles['setting-item']}>
          <Checkbox
            checked={settings.checkUpdateOnStartup}
            onChange={async (checked) => {
              updateSettings({ checkUpdateOnStartup: checked })
              // 立即保存
              await saveSettings()
            }}
          >
            启动时检查更新
          </Checkbox>
        </div>
      </div>
    </div>
  )

  /**
   * 渲染语音设置
   */
  const renderVoiceSettings = () => {
    const saveVoiceConfig = async (partial: {
      asr?: { provider?: string; language?: string; apiKey?: string }
      tts?: { provider?: string; speed?: number; volume?: number; speakerId?: number; voice?: string }
      vad?: { threshold?: number; minSpeechMs?: number; minSilenceMs?: number; energyGateMultiplier?: number }
      autoMuteMicWhileSpeaking?: boolean
    }) => {
      const electronAPI = (window as any).electronAPI
      if (!electronAPI?.voice?.sendCommand || !voiceConfig) return
      const next = {
        ...voiceConfig,
        asr: { ...voiceConfig.asr, ...partial.asr },
        tts: { ...voiceConfig.tts, ...partial.tts },
        vad: { ...voiceConfig.vad, ...partial.vad },
        autoMuteMicWhileSpeaking:
          partial.autoMuteMicWhileSpeaking ?? voiceConfig.autoMuteMicWhileSpeaking,
      }
      setVoiceConfig(next)
      setVoiceSaving(true)
      try {
        await electronAPI.voice.sendCommand({ type: 'voice:config:set', config: partial })
      } finally {
        setVoiceSaving(false)
      }
    }

    const handlePreview = async () => {
      const electronAPI = (window as any).electronAPI
      if (!electronAPI?.voice?.sendCommand) return
      // 创建（或复用）AudioContext
      if (!previewAudioCtxRef.current || previewAudioCtxRef.current.state === 'closed') {
        previewAudioCtxRef.current = new AudioContext()
      }
      if (previewAudioCtxRef.current.state === 'suspended') {
        await previewAudioCtxRef.current.resume()
      }
      setVoicePreviewing(true)
      await electronAPI.voice.sendCommand({ type: 'voice:tts:preview' }).catch(() => setVoicePreviewing(false))
    }

    return (
      <div className={styles['settings-section']}>
        <h3>语音设置</h3>

        {!voiceConfig ? (
          <p className={styles['settings-note']}>加载语音配置中...</p>
        ) : (
          <>
            {/* ASR 识别 */}
            <div className={styles['setting-group']}>
              <h4 className={styles['setting-group-title']}>语音识别（ASR）</h4>
              <div className={styles['setting-item']}>
                <label className={styles['setting-label']}>识别引擎</label>
                <Select
                  value={voiceConfig.asr.provider}
                  options={[
                    { label: '本地 Paraformer（离线）', value: 'local-paraformer' },
                    { label: 'OpenAI Whisper（云端）', value: 'openai-whisper' },
                  ]}
                  onChange={(e) => saveVoiceConfig({ asr: { provider: e.target.value } })}
                />
              </div>
              {voiceConfig.asr.provider === 'openai-whisper' && (
                <div className={styles['setting-item']}>
                  <label className={styles['setting-label']}>OpenAI API Key</label>
                  <Input
                    type="password"
                    placeholder="sk-..."
                    value={voiceConfig.asr.apiKey ?? ''}
                    onChange={(e) => saveVoiceConfig({ asr: { apiKey: e.target.value } })}
                    style={{ width: '280px' }}
                  />
                  <p className={styles['settings-note']} style={{ marginTop: 4 }}>
                    用于 Whisper 语音识别（不影响其他 AI 功能）
                  </p>
                </div>
              )}
            </div>

            {/* TTS 合成 */}
            <div className={styles['setting-group']}>
              <h4 className={styles['setting-group-title']}>语音合成（TTS）</h4>
              <div className={styles['setting-item']}>
                <label className={styles['setting-label']}>合成引擎</label>
                <Select
                  value={voiceConfig.tts.provider}
                  options={[
                    { label: '本地 VITS（离线）', value: 'local-vits' },
                    { label: 'Edge TTS（联网）', value: 'edge' },
                  ]}
                  onChange={(e) => saveVoiceConfig({ tts: { provider: e.target.value } })}
                />
              </div>
              <div className={styles['setting-item']}>
                <label className={styles['setting-label']}>
                  语速：{voiceConfig.tts.speed.toFixed(1)}x
                </label>
                <input
                  type="range"
                  min={0.8}
                  max={1.5}
                  step={0.1}
                  value={voiceConfig.tts.speed}
                  onChange={(e) =>
                    saveVoiceConfig({ tts: { speed: parseFloat(e.target.value) } })
                  }
                  style={{ width: '200px' }}
                />
              </div>
              <div className={styles['setting-item']}>
                <label className={styles['setting-label']}>
                  音量：{Math.round((voiceConfig.tts.volume ?? 0.8) * 100)}%
                </label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={voiceConfig.tts.volume ?? 0.8}
                  onChange={(e) =>
                    saveVoiceConfig({ tts: { volume: parseFloat(e.target.value) } })
                  }
                  style={{ width: '200px' }}
                />
              </div>
              {voiceConfig.tts.provider === 'local-vits' && (
                <div className={styles['setting-item']}>
                  <label className={styles['setting-label']}>
                    说话人 ID
                    <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginLeft: 6, fontWeight: 400 }}>
                      (0 ~ 173，共 174 个音色)
                    </span>
                  </label>
                  <Input
                    type="number"
                    min={0}
                    max={173}
                    value={String(voiceConfig.tts.speakerId ?? 0)}
                    onChange={(e) =>
                      saveVoiceConfig({
                        tts: { speakerId: Math.max(0, Math.min(173, parseInt(e.target.value, 10) || 0)) },
                      })
                    }
                    style={{ width: '80px' }}
                  />
                </div>
              )}
              {voiceConfig.tts.provider === 'edge' && (
                <div className={styles['setting-item']}>
                  <label className={styles['setting-label']}>音色</label>
                  <Select
                    value={voiceConfig.tts.voice ?? 'zh-CN-XiaoxiaoNeural'}
                    options={[
                      { label: '晓晓 - 女声·温暖亲切', value: 'zh-CN-XiaoxiaoNeural' },
                      { label: '晓伊 - 女声·活泼可爱', value: 'zh-CN-XiaoyiNeural' },
                      { label: '云健 - 男声·沉稳大气', value: 'zh-CN-YunjianNeural' },
                      { label: '云希 - 男声·阳光少年', value: 'zh-CN-YunxiNeural' },
                      { label: '云夏 - 男声·少年音', value: 'zh-CN-YunxiaNeural' },
                      { label: '云扬 - 男声·新闻播报', value: 'zh-CN-YunyangNeural' },
                      { label: '晓北 - 女声·东北方言', value: 'zh-CN-liaoning-XiaobeiNeural' },
                      { label: '晓妮 - 女声·陕西方言', value: 'zh-CN-shaanxi-XiaoniNeural' },
                    ]}
                    onChange={(e) => saveVoiceConfig({ tts: { voice: e.target.value } })}
                  />
                </div>
              )}
            </div>

            {/* 麦克风与识别阈值（VAD） */}
            <div className={styles['setting-group']}>
              <h4 className={styles['setting-group-title']}>麦克风与识别</h4>
              <div className={styles['setting-item']}>
                <Checkbox
                  checked={voiceConfig.autoMuteMicWhileSpeaking ?? true}
                  onChange={(checked) => saveVoiceConfig({ autoMuteMicWhileSpeaking: checked })}
                >
                  AI 朗读时自动闭麦
                </Checkbox>
                <span className={styles['setting-hint']}>开启后 AI 说话期间暂停麦克风采集，朗读结束自动恢复，避免自说自话/回声打断</span>
              </div>
              <div className={styles['setting-item']}>
                <label className={styles['setting-label']}>
                  语音识别阈值：{(voiceConfig.vad?.threshold ?? 0.5).toFixed(2)}
                </label>
                <span className={styles['setting-hint']}>VAD 语音概率阈值，越高越不容易把噪声当成语音（0.1~0.9）</span>
                <input
                  type="range"
                  min={0.1}
                  max={0.9}
                  step={0.05}
                  value={voiceConfig.vad?.threshold ?? 0.5}
                  onChange={(e) => saveVoiceConfig({ vad: { threshold: parseFloat(e.target.value) } })}
                  style={{ width: '200px' }}
                />
              </div>
              <div className={styles['setting-item']}>
                <label className={styles['setting-label']}>
                  负面语音阈值：{(voiceConfig.vad?.energyGateMultiplier ?? 1.5).toFixed(1)}x
                </label>
                <span className={styles['setting-hint']}>多大声才算真的在说话：相对底噪的能量倍数，越高越能过滤背景噪声与回声（1.0~4.0）</span>
                <input
                  type="range"
                  min={1.0}
                  max={4.0}
                  step={0.1}
                  value={voiceConfig.vad?.energyGateMultiplier ?? 1.5}
                  onChange={(e) => saveVoiceConfig({ vad: { energyGateMultiplier: parseFloat(e.target.value) } })}
                  style={{ width: '200px' }}
                />
              </div>
            </div>

            {/* 预览声音按钮 */}
            <div className={styles['setting-item']} style={{ marginTop: 8 }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={handlePreview}
                disabled={voicePreviewing}
              >
                {voicePreviewing ? '播放中...' : '▶ 预览声音'}
              </Button>
              {voicePreviewing && (
                <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)', marginLeft: 8 }}>
                  正在播放示例语音
                </span>
              )}
            </div>

            {voiceSaving && (
              <p className={styles['settings-note']}>保存中...</p>
            )}
          </>
        )}
      </div>
    )
  }

  /**
   * 渲染当前分类内容
   */
  const renderCategoryContent = () => {
    switch (activeCategory) {
      case 'account':
        return renderAccountSettings()
      case 'workspace':
        return renderWorkspaceSettings()
      case 'channels':
        return renderChannelsSettings()
      case 'notification':
        return renderNotificationSettings()
      case 'privacy':
        return renderPrivacySettings()
      case 'mcp':
        return renderMcpSettings()
      case 'shortcuts':
        return renderShortcutsSettings()
      case 'update':
        return renderUpdateSettings()
      case 'about':
        return renderAboutSettings()
      case 'voice':
        return renderVoiceSettings()
      case 'pet':
        return renderPetSettings()
      case 'modelConfig':
        return renderModelConfigSettings()
      default:
        return null
    }
  }

  return (
    <div className={styles['settings-page']}>
      <PageHeader title="设置" />

      <div className={styles['settings-body']}>
        {/* 分类导航 */}
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

          {/* 从侧边栏移入的功能页：点击跳转，不是设置分类 */}
          {onViewChange && (
            <>
              <div className={styles['settings-nav-divider']}>功能</div>
              {MOVED_PAGES.map((page) => (
                <button
                  key={page.id}
                  className={styles['settings-nav-item']}
                  onClick={() => onViewChange(page.id)}
                >
                  <span className={styles['nav-icon']}>{page.icon}</span>
                  <span className={styles['nav-label']}>{page.label}</span>
                </button>
              ))}
            </>
          )}
        </nav>

        {/* 设置内容 */}
        <div className={styles['settings-content']}>
          {renderCategoryContent()}
        </div>
      </div>
    </div>
  )
}

export { SettingsPage };
export default SettingsPage
