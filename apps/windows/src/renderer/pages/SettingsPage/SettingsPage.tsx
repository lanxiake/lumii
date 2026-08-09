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
import { Eye, EyeOff, FileText } from 'lucide-react'
import { Card } from '../../components/ui/Card/Card'
import { Button } from '../../components/ui/Button/Button'
import { Input } from '../../components/ui/Input/Input'
import { Loading } from '../../components/ui/Loading/Loading'
import { Checkbox } from '../../components/ui/Checkbox/Checkbox'
import { Select } from '../../components/ui/Select/Select'
import { Badge } from '../../components/ui/Badge/Badge'
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
import { UsagePanel } from './components/UsagePanel'
import { LumiiLogo } from '../../components/brand/LumiiLogo'
import { VoiceModelsPanel } from './components/VoiceModelsPanel'
import { VoiceProfilesPanel } from './components/VoiceProfilesPanel'
import { AsrLiveTestPanel } from './components/AsrLiveTestPanel'
import {
  getProviderConfig,
  saveProviderConfig,
  listProviderModels,
  testProviderConnection,
  PROVIDER_DEFAULT_BASE_URL,
  PROVIDER_TYPE_LABEL,
  listProviderTypesForSlot,
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
import type {
  MergedSettingsCategory,
} from '../../components/SettingsHub/types'
import styles from './SettingsPage.module.css'

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
  const [appVersion, setAppVersion] = useState<string>('0.1.0')

  // 本地 LLM Provider 配置（按能力槽）
  const [providerSlots, setProviderSlots] = useState<ProviderSlotsConfigView | null>(null)
  const [providerLoading, setProviderLoading] = useState(false)
  const [providerSaving, setProviderSaving] = useState(false)
  const [slotModels, setSlotModels] = useState<Partial<Record<CapabilitySlot, ListedModel[]>>>({})
  /** 模型 ID 输入框本地缓冲文本（未提交前不解析进 allowedModelIds） */
  const [slotModelIdsText, setSlotModelIdsText] = useState<Partial<Record<CapabilitySlot, string>>>({})
  const [slotListing, setSlotListing] = useState<Partial<Record<CapabilitySlot, boolean>>>({})
  const [slotTesting, setSlotTesting] = useState<Partial<Record<CapabilitySlot, boolean>>>({})
  const [expandedSlots, setExpandedSlots] = useState<Partial<Record<CapabilitySlot, boolean>>>({
    chat: true,
  })
  /** API Key 明文可见性（按槽） */
  const [showApiKeyBySlot, setShowApiKeyBySlot] = useState<Partial<Record<CapabilitySlot, boolean>>>({})
  /** 语音 ASR API Key 可见性 */
  const [showVoiceApiKey, setShowVoiceApiKey] = useState(false)

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

  // 语音设置状态
  const [voiceConfig, setVoiceConfig] = useState<{
    asr: { provider: string; language?: string; apiKey?: string }
    tts: {
      provider: string
      speed: number
      volume: number
      speakerId?: number
      voice?: string
      qwen3Variant?: string
      qwen3Speaker?: string
      qwen3Instruct?: string
      qwen3CloneEnabled?: boolean
      qwen3CloneVariant?: '0.6b-base' | '1.7b-base'
      qwen3ProfileId?: string
      qwen3Device?: 'auto' | 'cpu' | 'cuda'
      language?: string
    }
    vad: { threshold: number; minSpeechMs: number; minSilenceMs: number; energyGateMultiplier: number }
    autoMuteMicWhileSpeaking: boolean
  } | null>(null)
  const [voiceSaving, setVoiceSaving] = useState(false)
  const [voicePreviewing, setVoicePreviewing] = useState(false)
  /** 语音合成测试文案（默认与预览默认句一致，最多 100 字） */
  const [voicePreviewText, setVoicePreviewText] = useState('你好，我叫 Lumii。I’m your best partner，是你的最佳伙伴呀。')
  /** TTS 运行时阶段文案（安装依赖 / 加载模型等） */
  const [voiceRuntimeStatus, setVoiceRuntimeStatus] = useState<{
    phase: string
    message: string
    detail?: string
  } | null>(null)
  /** 本地 VITS 模型是否已下载 */
  const [vitsModelReady, setVitsModelReady] = useState(false)
  /** Qwen3 CustomVoice（内置音色）是否可用 */
  const [qwen3CustomReady, setQwen3CustomReady] = useState(false)
  const [qwen3Custom06Ready, setQwen3Custom06Ready] = useState(false)
  const [qwen3Custom17Ready, setQwen3Custom17Ready] = useState(false)
  /** Qwen3 Base（声音克隆）是否可用 */
  const [qwen3CloneReady, setQwen3CloneReady] = useState(false)
  const [qwen3Clone06Ready, setQwen3Clone06Ready] = useState(false)
  const [qwen3Clone17Ready, setQwen3Clone17Ready] = useState(false)
  const previewAudioCtxRef = React.useRef<AudioContext | null>(null)
  const previewGainRef = React.useRef<GainNode | null>(null)
  const previewVolumeRef = React.useRef(1.0)
  // 当前试听会话标识：只播放本次试听的 chunk，隔离消息朗读等其它来源
  const previewIdRef = React.useRef<string | null>(null)

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
   * 切换到语音设置时加载配置与本地 TTS 模型就绪状态
   */
  useEffect(() => {
    if (activeCategory !== 'voice') return
    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.voice?.sendCommand) return
    electronAPI.voice.sendCommand({ type: 'voice:config:get' }).then((cfg: any) => {
      if (cfg?.asr && cfg?.tts) {
        setVoiceConfig(cfg)
        const vol = typeof cfg.tts?.volume === 'number' ? cfg.tts.volume : 1.0
        previewVolumeRef.current = Math.max(0, Math.min(2, vol))
      }
    }).catch(() => {
      console.warn('[SettingsPage] 获取语音配置失败')
    })
    const applyModelReady = (list: any[]) => {
      setVitsModelReady(Boolean(list.find((m: any) => m.id === 'tts-melo-zh-en')?.downloaded))
      const tok = Boolean(list.find((m: any) => m.id === 'tts-qwen3-tokenizer-12hz')?.downloaded)
      const c06 = Boolean(list.find((m: any) => m.id === 'tts-qwen3-0.6b-custom')?.downloaded)
      const c17 = Boolean(list.find((m: any) => m.id === 'tts-qwen3-1.7b-custom')?.downloaded)
      const b06 = Boolean(list.find((m: any) => m.id === 'tts-qwen3-0.6b-base')?.downloaded)
      const b17 = Boolean(list.find((m: any) => m.id === 'tts-qwen3-1.7b-base')?.downloaded)
      setQwen3Custom06Ready(tok && c06)
      setQwen3Custom17Ready(tok && c17)
      setQwen3CustomReady(tok && (c06 || c17))
      setQwen3Clone06Ready(tok && b06)
      setQwen3Clone17Ready(tok && b17)
      setQwen3CloneReady(tok && (b06 || b17))
    }
    electronAPI.voice.sendCommand({ type: 'voice:models:get' }).then((list: any) => {
      if (!Array.isArray(list)) return
      applyModelReady(list)
    }).catch(() => undefined)

    const unsub = electronAPI.voice.onEvent?.((event: any) => {
      if (event.type === 'voice:models:status' && Array.isArray(event.models)) {
        applyModelReady(event.models)
      }
    })
    return () => {
      if (typeof unsub === 'function') unsub()
    }
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
   * 监听 TTS 预览音频块与运行时状态，接收后用 Web Audio API 播放 / 展示进度
   */
  useEffect(() => {
    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.voice?.onEvent) return
    let nextStartTime = 0
    const unsubscribe = electronAPI.voice.onEvent((event: any) => {
      if (event.type === 'voice:runtime:status') {
        setVoiceRuntimeStatus({
          phase: String(event.phase || ''),
          message: String(event.message || ''),
          detail: event.detail ? String(event.detail) : undefined,
        })
        return
      }
      if (event.type === 'voice:tts:preview:ended') {
        // 只响应本次试听；他处（如消息朗读）的结束事件忽略
        if (previewIdRef.current && event.previewId !== previewIdRef.current) return
        setVoicePreviewing(false)
        if (!event.ok && event.message) {
          setVoiceRuntimeStatus({
            phase: 'error',
            message: `预览失败：${event.message}`,
          })
        }
        return
      }
      if (event.type !== 'voice:tts:preview:chunk') return
      // 只播放本次试听的 chunk，丢弃消息朗读等其它来源，避免串流
      if (previewIdRef.current && event.previewId !== previewIdRef.current) return
      const ctx = previewAudioCtxRef.current
      if (!ctx) return
      if (event.isFinal && (!event.samples || event.samples.length === 0)) {
        // 最后一个空帧：标记预览结束
        setVoicePreviewing(false)
        return
      }
      if (!event.samples || event.samples.length === 0) return
      try {
        // 预览也走 GainNode，否则设置里的音量滑条对试听无效
        if (!previewGainRef.current || previewGainRef.current.context !== ctx) {
          const gain = ctx.createGain()
          gain.gain.value = Math.max(0, Math.min(2, previewVolumeRef.current))
          gain.connect(ctx.destination)
          previewGainRef.current = gain
        } else {
          previewGainRef.current.gain.value = Math.max(0, Math.min(2, previewVolumeRef.current))
        }
        const dest = previewGainRef.current
        if (event.sampleRate === -1) {
          // Edge TTS 编码音频（MP3），需解码
          const buf = new Uint8Array(event.samples).buffer
          ctx.decodeAudioData(buf).then((decoded) => {
            const source = ctx.createBufferSource()
            source.buffer = decoded
            source.connect(dest)
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
          source.connect(dest)
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
      previewGainRef.current = null
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
      <div className={`${styles['settings-section']} ${styles['settings-section--channels']}`}>
        <h3>渠道设置</h3>
        <p style={{ fontSize: 13, color: 'var(--mt-fg-3)', margin: '0 0 16px' }}>
          配置各个即时通信渠道的接入与登录状态。
        </p>
        <div className={styles['channels-grid']}>
          <WeixinChannelSettings />
          <WecomChannelSettings />
          <FeishuChannelSettings />
        </div>
      </div>
    )
  }

  /**
   * 渲染本机 ACP / 开发工具设置
   */
  const renderCodingDevSettings = () => (
    <div className={styles['settings-section']}>
      <h3>ACP 设置</h3>
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
   * 渲染隐私与数据：统一卡片分区，本地优先说明在前
   */
  const renderPrivacySettings = () => {
    return (
      <div className={styles['settings-panel']}>
        <header className={styles['panel-header']}>
          <h3 className={styles['panel-title']}>
            隐私与数据
            {privacySave.hasChanges && <Badge dot />}
          </h3>
          <p className={styles['panel-desc']}>
            对话与记忆默认只保存在本机。可按需调整本地留存与数据导出。
          </p>
        </header>

        <section className={styles['panel-card']}>
          <h4 className={styles['panel-card-title']}>本地留存</h4>
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
          <h4 className={styles['panel-card-title']}>安全日志</h4>
          <p className={styles['panel-card-desc']}>
            查看本机 AI 工具与权限相关操作摘要（最近 20 条）
          </p>
          <SecurityLogViewer />
        </section>

        <section className={styles['panel-card']}>
          <h4 className={styles['panel-card-title']}>系统日志</h4>
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
          <h4 className={styles['panel-card-title']}>备份与恢复</h4>
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

  /** 更新指定能力槽字段（切换类型时同步默认 baseUrl 并清空已选模型，避免残留旧 Provider 的模型） */
  const patchSlot = useCallback((slot: CapabilitySlot, patch: Partial<LocalProviderConfigView>) => {
    setProviderSlots((prev) => {
      if (!prev) return prev
      const current = prev[slot]
      const nextSlot = { ...current, ...patch }
      if (patch.type && patch.type !== current.type) {
        nextSlot.baseUrl = PROVIDER_DEFAULT_BASE_URL[patch.type]
        nextSlot.modelId = ''
        nextSlot.allowedModelIds = []
        setSlotModels((m) => ({ ...m, [slot]: [] }))
        setSlotModelIdsText((t) => ({ ...t, [slot]: undefined }))
      }
      if (patch.enabled === true) {
        setExpandedSlots((e) => ({ ...e, [slot]: true }))
      }
      return { ...prev, [slot]: nextSlot }
    })
  }, [])

  /** 提交模型 ID 输入框的手动编辑文本：按逗号切分、去重后写入 allowedModelIds */
  const commitSlotModelIdsText = useCallback((slot: CapabilitySlot) => {
    setSlotModelIdsText((textState) => {
      const text = textState[slot]
      if (text === undefined) return textState
      const ids = [...new Set(text.split(',').map((s) => s.trim()).filter(Boolean))]
      setProviderSlots((prev) => {
        if (!prev) return prev
        const current = prev[slot]
        const nextModelId = ids.includes(current.modelId) ? current.modelId : (ids[0] ?? '')
        return { ...prev, [slot]: { ...current, allowedModelIds: ids, modelId: nextModelId } }
      })
      return { ...textState, [slot]: undefined }
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
          modelId: chat.modelId,
          allowedModelIds: slot === 'vision' ? [...(chat.allowedModelIds ?? (chat.modelId ? [chat.modelId] : []))] : prev[slot].allowedModelIds,
          enabled: true,
        },
      }
    })
    setExpandedSlots((e) => ({ ...e, [slot]: true }))
    toast.success(`已从「文本对话」复制到「${CAPABILITY_SLOT_LABEL[slot]}」`)
  }, [toast])

  /** 拉取指定槽模型列表（只用当前草稿探测，不落盘、不影响运行中的 Agent） */
  const handleListModels = useCallback(async (slot: CapabilitySlot) => {
    if (!providerSlots) return
    setSlotListing((s) => ({ ...s, [slot]: true }))
    try {
      const models = await listProviderModels(slot, providerSlots[slot])
      setSlotModels((m) => ({ ...m, [slot]: models }))
      // 清理不在新列表中的旧选择，避免切换 Provider 后残留幽灵模型 ID
      if (models.length > 0) {
        const validIds = new Set(models.map((m) => m.id))
        const currentAllowed = providerSlots[slot].allowedModelIds ?? []
        const nextAllowed = currentAllowed.filter((id) => validIds.has(id))
        if (nextAllowed.length !== currentAllowed.length) {
          const nextModelId = nextAllowed.includes(providerSlots[slot].modelId)
            ? providerSlots[slot].modelId
            : (nextAllowed[0] ?? '')
          patchSlot(slot, { allowedModelIds: nextAllowed, modelId: nextModelId })
        }
      }
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
  }, [providerSlots, toast, patchSlot])

  /** 测试指定槽连通性（只用当前草稿探测，不落盘、不广播事件） */
  const handleTestSlot = useCallback(async (slot: CapabilitySlot) => {
    if (!providerSlots) return
    setSlotTesting((s) => ({ ...s, [slot]: true }))
    try {
      const result = await testProviderConnection(slot, { ...providerSlots[slot], enabled: true })
      if (result.ok) {
        toast.success(result.message)
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
                  options={listProviderTypesForSlot(slot).map((t) => ({
                    value: t,
                    label: PROVIDER_TYPE_LABEL[t],
                  }))}
                  onChange={(e) => {
                    const nextType = e.target.value as ProviderType
                    // 地址仍是某个 provider 的默认值（用户没自定义过）时才跟随切换，
                    // 避免覆盖用户手填的中转站地址
                    const isUntouched =
                      !cfg.baseUrl?.trim() ||
                      Object.values(PROVIDER_DEFAULT_BASE_URL).includes(cfg.baseUrl.trim())
                    patchSlot(slot, {
                      type: nextType,
                      ...(isUntouched ? { baseUrl: PROVIDER_DEFAULT_BASE_URL[nextType] } : {}),
                    })
                  }}
                />
              </div>
            </div>

            <div className={styles['setting-item']}>
              <div className={styles['setting-label']}>
                <span>接口地址（Base URL）</span>
                <span className={styles['setting-desc']}>
                  {cfg.type === 'rightapi'
                    ? '填到绘图根地址（含 /draw/v1）；任务查询地址会自动推导为站点级 /v1/tasks'
                    : '无需手写 /v1，保存与调用时会自动补全（OpenAI 兼容 / Ollama / LM Studio）'}
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
                  type={showApiKeyBySlot[slot] ? 'text' : 'password'}
                  value={cfg.apiKey}
                  placeholder={isLocalProvider ? '（可留空）' : 'sk-...'}
                  onChange={(e) => patchSlot(slot, { apiKey: e.target.value })}
                  suffix={
                    <button
                      type="button"
                      className={styles['about-link']}
                      aria-label={showApiKeyBySlot[slot] ? '隐藏 API Key' : '显示 API Key'}
                      onClick={() =>
                        setShowApiKeyBySlot((s) => ({ ...s, [slot]: !s[slot] }))
                      }
                      style={{ display: 'inline-flex', alignItems: 'center', padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }}
                    >
                      {showApiKeyBySlot[slot] ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  }
                />
              </div>
            </div>

            <div className={styles['setting-item']}>
              <div className={styles['setting-label']}>
                <span>模型 ID</span>
                <span className={styles['setting-desc']}>
                  {slot === 'image'
                    ? cfg.type === 'rightapi'
                      ? '异步生图模型，如 nano-banana-fast / nano-banana-pro / gpt-image-2；支持参考图（图生图）'
                      : '请填写或从列表选择，如 dall-e-3 / gpt-image-1'
                    : slot === 'vision'
                      ? '可勾选多个模型；对话/识别时再选用其一'
                      : '可勾选多个模型；对话框中切换使用'}
                </span>
              </div>
              <div className={styles['setting-control']} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {slot === 'image' ? (
                  models.length > 0 ? (
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
                  )
                ) : (
                  <>
                    {models.length > 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflow: 'auto' }}>
                        {models.map((m) => {
                          const allowed = cfg.allowedModelIds?.length
                            ? cfg.allowedModelIds
                            : (cfg.modelId ? [cfg.modelId] : [])
                          const checked = allowed.includes(m.id)
                          return (
                            <Checkbox
                              key={m.id}
                              checked={checked}
                              onChange={(next) => {
                                const prev = cfg.allowedModelIds?.length
                                  ? [...cfg.allowedModelIds]
                                  : (cfg.modelId ? [cfg.modelId] : [])
                                const nextIds = next
                                  ? [...new Set([...prev, m.id])]
                                  : prev.filter((id) => id !== m.id)
                                const nextModelId =
                                  nextIds.includes(cfg.modelId) ? cfg.modelId : (nextIds[0] ?? '')
                                patchSlot(slot, { allowedModelIds: nextIds, modelId: nextModelId })
                                // 勾选是结构化操作，优先覆盖输入框里未提交的手动编辑
                                setSlotModelIdsText((t) => ({ ...t, [slot]: undefined }))
                              }}
                            >
                              {m.name || m.id}
                            </Checkbox>
                          )
                        })}
                      </div>
                    ) : null}
                    <Input
                      type="text"
                      value={
                        slotModelIdsText[slot] ?? (cfg.allowedModelIds ?? []).join(', ')
                      }
                      placeholder="模型 ID，多个用逗号分隔；可手动输入，勾选后自动填充"
                      onChange={(e) => {
                        setSlotModelIdsText((t) => ({ ...t, [slot]: e.target.value }))
                      }}
                      onBlur={() => commitSlotModelIdsText(slot)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          commitSlotModelIdsText(slot)
                        }
                      }}
                    />
                    {(cfg.allowedModelIds?.length ?? 0) > 0 && (
                      <span className={styles['setting-desc']}>
                        已选 {cfg.allowedModelIds!.length} 个；默认使用：{cfg.modelId || '（未设）'}
                      </span>
                    )}
                  </>
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
   * 渲染关于与更新：版本信息 + 检查更新合并为一页
   */
  const renderAboutAndUpdateSettings = () => (
    <div className={styles['settings-panel']}>
      <header className={styles['panel-header']}>
        <h3 className={styles['panel-title']}>关于与更新</h3>
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
        <h4 className={styles['panel-card-title']}>软件更新</h4>
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
   * 渲染语音设置：三大独立区块（识别 / 合成 / 克隆）
   */
  const renderVoiceSettings = () => {
    const saveVoiceConfig = async (partial: {
      asr?: { provider?: string; language?: string; apiKey?: string }
      tts?: {
        provider?: string
        speed?: number
        volume?: number
        speakerId?: number
        voice?: string
        qwen3Variant?: string
        qwen3Speaker?: string
        qwen3Instruct?: string
        qwen3CloneEnabled?: boolean
        qwen3CloneVariant?: '0.6b-base' | '1.7b-base'
        qwen3ProfileId?: string
        qwen3Device?: 'auto' | 'cpu' | 'cuda'
        language?: string
      }
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

    /** 用当前测试文案触发 TTS 预览（最多 100 字） */
    const handlePreview = async () => {
      const electronAPI = (window as any).electronAPI
      if (!electronAPI?.voice?.sendCommand) return
      if (!previewAudioCtxRef.current || previewAudioCtxRef.current.state === 'closed') {
        previewAudioCtxRef.current = new AudioContext()
      }
      if (previewAudioCtxRef.current.state === 'suspended') {
        await previewAudioCtxRef.current.resume()
      }
      setVoicePreviewing(true)
      const previewId = `settings-${Date.now()}`
      previewIdRef.current = previewId
      const text = voicePreviewText.trim().slice(0, 100) || '你好，我叫 Lumii。I’m your best partner，是你的最佳伙伴呀。'
      await electronAPI.voice
        .sendCommand({ type: 'voice:tts:preview', text, maxChars: 100, previewId })
        .catch(() => setVoicePreviewing(false))
    }

    /**
     * 试听指定克隆音色（走 override，不改全局配置，不受当前生效音色影响）
     */
    const handlePreviewProfile = async (profileId: string) => {
      const electronAPI = (window as any).electronAPI
      if (!electronAPI?.voice?.sendCommand) return
      if (!previewAudioCtxRef.current || previewAudioCtxRef.current.state === 'closed') {
        previewAudioCtxRef.current = new AudioContext()
      }
      if (previewAudioCtxRef.current.state === 'suspended') {
        await previewAudioCtxRef.current.resume()
      }
      setVoicePreviewing(true)
      const previewId = `settings-clone-${profileId}-${Date.now()}`
      previewIdRef.current = previewId
      const text = voicePreviewText.trim().slice(0, 100) || '你好，我叫 Lumii。I’m your best partner，是你的最佳伙伴呀。'
      await electronAPI.voice
        .sendCommand({
          type: 'voice:tts:preview',
          text,
          maxChars: 100,
          previewId,
          override: {
            provider: 'qwen3',
            cloneEnabled: true,
            qwen3ProfileId: profileId,
          },
        })
        .catch(() => setVoicePreviewing(false))
    }

    /**
     * 选中某条克隆音色作为当前生效音色（互斥：开启克隆出声）；传 undefined 则关闭克隆
     */
    const selectCloneProfile = (id: string | undefined) => {
      if (id) {
        const prefer = qwen3Clone06Ready ? '0.6b-base' : '1.7b-base'
        void saveVoiceConfig({
          tts: {
            provider: 'qwen3',
            qwen3CloneEnabled: true,
            qwen3ProfileId: id,
            qwen3CloneVariant: voiceConfig?.tts.qwen3CloneVariant ?? prefer,
          },
        })
      } else {
        void saveVoiceConfig({ tts: { qwen3CloneEnabled: false, qwen3ProfileId: undefined } })
      }
    }

    /**
     * 选中内置音色作为当前生效音色（互斥：关闭克隆出声）
     */
    const selectBuiltinSpeaker = (speaker: string) => {
      void saveVoiceConfig({ tts: { qwen3Speaker: speaker, qwen3CloneEnabled: false } })
    }

    const vitsDownloaded = vitsModelReady
    const qwenVariant = voiceConfig?.tts.qwen3Variant ?? '0.6b-custom'
    const cloneEnabled = voiceConfig?.tts.qwen3CloneEnabled === true
    const cloneVariant = voiceConfig?.tts.qwen3CloneVariant ?? '0.6b-base'
    const previewDisabled =
      !voiceConfig ||
      voicePreviewing ||
      (voiceConfig.tts.provider === 'local-vits' && !vitsDownloaded) ||
      (voiceConfig.tts.provider === 'qwen3' &&
        (cloneEnabled
          ? !qwen3CloneReady || !voiceConfig.tts.qwen3ProfileId
          : !qwen3CustomReady))

    /**
     * 运行时阶段中文短标签
     */
    const runtimePhaseLabel = (phase: string): string => {
      switch (phase) {
        case 'checking_python':
          return '检查环境'
        case 'installing_deps':
          return '安装依赖'
        case 'starting_engine':
          return '启动引擎'
        case 'loading_model':
          return '加载模型'
        case 'synthesizing':
          return '合成中'
        case 'playing':
          return '播放中'
        case 'ready':
          return '就绪'
        case 'error':
          return '出错'
        case 'idle':
          return '空闲'
        default:
          return phase || '状态'
      }
    }

    const runtimeBusy =
      !!voiceRuntimeStatus &&
      !['idle', 'ready', 'error'].includes(voiceRuntimeStatus.phase)

    /**
     * 渲染语音运行时状态条
     */
    const renderRuntimeStatus = () => {
      if (!voiceRuntimeStatus?.message) return null
      const phase = voiceRuntimeStatus.phase
      const cls = [
        styles['voice-runtime-status'],
        phase === 'error'
          ? styles['voice-runtime-status-error']
          : phase === 'ready' || phase === 'idle'
            ? styles['voice-runtime-status-ready']
            : styles['voice-runtime-status-busy'],
      ].join(' ')
      return (
        <div className={cls} role="status" aria-live="polite">
          <span className={styles['voice-runtime-phase']}>{runtimePhaseLabel(phase)}</span>
          {voiceRuntimeStatus.message}
          {voiceRuntimeStatus.detail ? (
            <div className={styles['voice-runtime-detail']}>{voiceRuntimeStatus.detail}</div>
          ) : null}
        </div>
      )
    }

    const previewButtonLabel = (() => {
      if (!voicePreviewing && !runtimeBusy) return '▶ 预览合成声音'
      const phase = voiceRuntimeStatus?.phase
      if (phase === 'installing_deps') return '安装依赖中…'
      if (phase === 'loading_model') return '加载模型中…'
      if (phase === 'checking_python' || phase === 'starting_engine') return '启动引擎中…'
      if (phase === 'synthesizing') return '合成中…'
      if (phase === 'playing') return '播放中…'
      return voicePreviewing ? '处理中…' : '▶ 预览合成声音'
    })()

    return (
      <div className={styles['settings-section']}>
        <h3>语音设置</h3>
        <p className={styles['settings-note']}>
          分为三块独立能力：语音识别、语音合成、声音克隆。各自下载与测试，互不强制。
        </p>

        {!voiceConfig ? (
          <p className={styles['settings-note']}>加载语音配置中...</p>
        ) : (
          <>
            {/* ═══ 1. 语音识别 ═══ */}
            <div className={styles['voice-block']}>
              <h4 className={styles['voice-block-title']}>一、语音识别</h4>
              <p className={styles['voice-block-desc']}>
                把你的说话转成文字。通话听懂你需要下载 VAD + ASR；与是否克隆声音无关。
              </p>

              <VoiceModelsPanel
                groups={['asr-core']}
                title="下载"
                hint="建议两项都下载。仅用文字输入可不下。"
              />

              <div className={styles['setting-group']}>
                <h5 className={styles['voice-block-subtitle']}>设置</h5>
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
                      type={showVoiceApiKey ? 'text' : 'password'}
                      placeholder="sk-..."
                      value={voiceConfig.asr.apiKey ?? ''}
                      onChange={(e) => saveVoiceConfig({ asr: { apiKey: e.target.value } })}
                      style={{ width: '280px' }}
                      suffix={
                        <button
                          type="button"
                          aria-label={showVoiceApiKey ? '隐藏 API Key' : '显示 API Key'}
                          onClick={() => setShowVoiceApiKey((v) => !v)}
                          style={{ display: 'inline-flex', alignItems: 'center', padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }}
                        >
                          {showVoiceApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      }
                    />
                  </div>
                )}
                <div className={styles['setting-item']}>
                  <Checkbox
                    checked={voiceConfig.autoMuteMicWhileSpeaking ?? true}
                    onChange={(checked) => saveVoiceConfig({ autoMuteMicWhileSpeaking: checked })}
                  >
                    AI 朗读时自动闭麦
                  </Checkbox>
                </div>
                <div className={styles['setting-item']}>
                  <label className={styles['setting-label']}>
                    语音识别阈值：{(voiceConfig.vad?.threshold ?? 0.5).toFixed(2)}
                  </label>
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
                  <input
                    type="range"
                    min={1.0}
                    max={4.0}
                    step={0.1}
                    value={voiceConfig.vad?.energyGateMultiplier ?? 1.5}
                    onChange={(e) =>
                      saveVoiceConfig({ vad: { energyGateMultiplier: parseFloat(e.target.value) } })
                    }
                    style={{ width: '200px' }}
                  />
                </div>
              </div>

              <div className={styles['setting-group']}>
                <h5 className={styles['voice-block-subtitle']}>测试</h5>
                <AsrLiveTestPanel />
              </div>
            </div>

            {/* ═══ 2. AI 声音（合成引擎 + 音色，含克隆） ═══ */}
            <div className={styles['voice-block']}>
              <h4 className={styles['voice-block-title']}>二、AI 声音</h4>
              <p className={styles['voice-block-desc']}>
                让 AI 出声。先选合成引擎，再在下方选一个音色即生效。
                Qwen3 下「内置音色」与「我的音色（克隆）」在同一列表里，选谁用谁。
              </p>

              <VoiceModelsPanel
                groups={['tts-synth', 'tts-clone']}
                title="下载"
                hint="内置音色：先下 Tokenizer 12Hz，再下 0.6B CustomVoice（9 种音色）。声音克隆额外需要 0.6B Base（或 1.7B）。权重下完后台预装依赖，进度见下方「测试」状态条。"
              />

              <div className={styles['setting-group']}>
                <h5 className={styles['voice-block-subtitle']}>设置</h5>
                <div className={styles['setting-item']}>
                  <label className={styles['setting-label']}>合成引擎</label>
                  <Select
                    value={voiceConfig.tts.provider}
                    options={[
                      { label: 'Edge TTS（联网，免下载）', value: 'edge' },
                      {
                        label: vitsDownloaded
                          ? '本地 MeloTTS 中英混读（离线）'
                          : '本地 MeloTTS 中英混读（需先下载）',
                        value: 'local-vits',
                        disabled: !vitsDownloaded,
                      },
                      {
                        label: qwen3CustomReady
                          ? 'Qwen3（本地多音色 + 声音克隆）'
                          : 'Qwen3（需先下载 Tokenizer+CustomVoice）',
                        value: 'qwen3',
                        disabled: !qwen3CustomReady,
                      },
                    ]}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v === 'local-vits' && !vitsDownloaded) return
                      if (v === 'qwen3' && !qwen3CustomReady) return
                      if (v === 'qwen3') {
                        const prefer = qwen3Custom06Ready ? '0.6b-custom' : '1.7b-custom'
                        saveVoiceConfig({
                          tts: { provider: 'qwen3', qwen3Variant: prefer, qwen3CloneEnabled: false },
                        })
                        return
                      }
                      saveVoiceConfig({ tts: { provider: v, qwen3CloneEnabled: false } })
                    }}
                  />
                </div>
                {voiceConfig.tts.provider === 'qwen3' && (
                  <div className={styles['setting-item']}>
                    <label className={styles['setting-label']}>推理设备</label>
                    <Select
                      value={voiceConfig.tts.qwen3Device ?? 'auto'}
                      options={[
                        {
                          label: '自动（有 NVIDIA 显卡则用 GPU）',
                          value: 'auto',
                        },
                        {
                          label: 'GPU（CUDA，需 NVIDIA 驱动）',
                          value: 'cuda',
                        },
                        {
                          label: 'CPU（兼容性最好，较慢）',
                          value: 'cpu',
                        },
                      ]}
                      onChange={(e) => {
                        const v = e.target.value as 'auto' | 'cpu' | 'cuda'
                        void saveVoiceConfig({ tts: { qwen3Device: v } })
                      }}
                    />
                    <span className={styles['setting-hint']}>
                      GPU 需先在下方模型列表下载「PyTorch CUDA 运行时」（可暂停/续传/取消，约
                      2.3GB）；下载完成后自动安装。
                    </span>
                  </div>
                )}
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
                    onChange={(e) => saveVoiceConfig({ tts: { speed: parseFloat(e.target.value) } })}
                    style={{ width: '200px' }}
                  />
                </div>
                <div className={styles['setting-item']}>
                  <label className={styles['setting-label']}>
                    音量：{Math.round((voiceConfig.tts.volume ?? 1.0) * 100)}%
                    {(voiceConfig.tts.volume ?? 1.0) > 1 ? '（增强）' : ''}
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.05}
                    value={voiceConfig.tts.volume ?? 1.0}
                    onChange={(e) => {
                      const vol = parseFloat(e.target.value)
                      previewVolumeRef.current = vol
                      if (previewGainRef.current) {
                        previewGainRef.current.gain.value = Math.max(0, Math.min(2, vol))
                      }
                      saveVoiceConfig({ tts: { volume: vol } })
                    }}
                    style={{ width: '200px' }}
                  />
                </div>
                {voiceConfig.tts.provider === 'edge' && (
                  <div className={styles['setting-item']}>
                    <label className={styles['setting-label']}>Edge 音色</label>
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
                {voiceConfig.tts.provider === 'qwen3' && (
                  <>
                    <div className={styles['setting-item']}>
                      <label className={styles['setting-label']}>合成语言</label>
                      <Select
                        value={voiceConfig.tts.language ?? 'Auto'}
                        options={[
                          { label: '自动检测', value: 'Auto' },
                          { label: '中文', value: 'Chinese' },
                          { label: 'English', value: 'English' },
                          { label: '日本語', value: 'Japanese' },
                          { label: '한국어', value: 'Korean' },
                          { label: 'Deutsch', value: 'German' },
                          { label: 'Français', value: 'French' },
                          { label: 'Русский', value: 'Russian' },
                          { label: 'Português', value: 'Portuguese' },
                          { label: 'Español', value: 'Spanish' },
                          { label: 'Italiano', value: 'Italian' },
                        ]}
                        onChange={(e) => saveVoiceConfig({ tts: { language: e.target.value } })}
                      />
                    </div>

                    {/* 统一音色列表：内置音色 + 我的音色（克隆） */}
                    <div className={styles['setting-item']} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                      <label className={styles['setting-label']}>音色（选中即生效）</label>
                      <div className={styles['voice-speaker-list']}>
                        {[
                          { id: 'Vivian', desc: '女 · 明亮 · 中文' },
                          { id: 'Serena', desc: '女 · 温暖 · 中文' },
                          { id: 'Uncle_Fu', desc: '男 · 沉稳 · 中文', name: 'Uncle Fu' },
                          { id: 'Dylan', desc: '男 · 北京话' },
                          { id: 'Eric', desc: '男 · 四川话' },
                          { id: 'Ryan', desc: '男 · English' },
                          { id: 'Aiden', desc: '男 · English' },
                          { id: 'Ono_Anna', desc: '女 · 日本語', name: 'Ono Anna' },
                          { id: 'Sohee', desc: '女 · 한국어' },
                        ].map((sp) => {
                          const active = !cloneEnabled && (voiceConfig.tts.qwen3Speaker ?? 'Vivian') === sp.id
                          return (
                            <label
                              key={sp.id}
                              className={styles['voice-speaker-item']}
                              style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                            >
                              <input
                                type="radio"
                                name="qwen3-active-voice"
                                checked={active}
                                onChange={() => selectBuiltinSpeaker(sp.id)}
                              />
                              <span>
                                内置 · {sp.name ?? sp.id}
                                <span className={styles['settings-note']} style={{ marginLeft: 6 }}>
                                  {sp.desc}
                                </span>
                              </span>
                            </label>
                          )
                        })}
                      </div>
                    </div>

                    {qwenVariant === '1.7b-custom' && !cloneEnabled && (
                      <div className={styles['setting-item']}>
                        <label className={styles['setting-label']}>风格指令（可选）</label>
                        <Input
                          placeholder="例如：用特别开心的语气说"
                          value={voiceConfig.tts.qwen3Instruct ?? ''}
                          onChange={(e) => saveVoiceConfig({ tts: { qwen3Instruct: e.target.value } })}
                          style={{ width: '320px' }}
                        />
                      </div>
                    )}

                    {/* 我的音色（克隆档案）：与内置音色同为可选音色，选中即用克隆出声 */}
                    <VoiceProfilesPanel
                      selectedProfileId={cloneEnabled ? voiceConfig.tts.qwen3ProfileId : undefined}
                      onSelectProfile={selectCloneProfile}
                      onPreviewProfile={(id) => void handlePreviewProfile(id)}
                      previewing={voicePreviewing || runtimeBusy}
                      cloneReady={qwen3CloneReady}
                    />

                    {qwen3CloneReady && (
                      <div className={styles['setting-item']} style={{ marginTop: 12 }}>
                        <label className={styles['setting-label']}>克隆模型规格</label>
                        <Select
                          value={cloneVariant}
                          options={[
                            {
                              label: qwen3Clone06Ready ? '0.6B Base' : '0.6B Base（未下载）',
                              value: '0.6b-base',
                              disabled: !qwen3Clone06Ready,
                            },
                            {
                              label: qwen3Clone17Ready ? '1.7B Base' : '1.7B Base（未下载）',
                              value: '1.7b-base',
                              disabled: !qwen3Clone17Ready,
                            },
                          ]}
                          onChange={(e) =>
                            saveVoiceConfig({
                              tts: {
                                qwen3CloneVariant: e.target.value as '0.6b-base' | '1.7b-base',
                              },
                            })
                          }
                        />
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className={styles['setting-group']}>
                <h5 className={styles['voice-block-subtitle']}>测试</h5>
                {renderRuntimeStatus()}
                <div className={styles['setting-item']}>
                  <label className={styles['setting-label']}>
                    测试文案（最多 100 字）剩余 {100 - voicePreviewText.length}
                  </label>
                  <input
                    className={styles['voice-preview-input']}
                    type="text"
                    value={voicePreviewText}
                    maxLength={100}
                    onChange={(e) => setVoicePreviewText(e.target.value.slice(0, 100))}
                    placeholder="你好，我叫 Lumii。I’m your best partner，是你的最佳伙伴呀。"
                  />
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handlePreview}
                  disabled={previewDisabled || runtimeBusy}
                >
                  {previewButtonLabel}
                </Button>
                <p className={styles['settings-note']} style={{ marginTop: 6 }}>
                  {cloneEnabled
                    ? '当前生效：克隆音色。试听将使用你选中的「我的音色」。'
                    : '当前生效：内置/引擎音色。要试听某条克隆音色，用列表里每条的「试听」。'}
                </p>
              </div>
            </div>

            {voiceSaving && <p className={styles['settings-note']}>保存中...</p>}
          </>
        )}
      </div>
    )
  }

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
        return renderWorkspaceSettings()
      case 'modelConfig':
        return renderModelConfigSettings()
      case 'voice':
        return renderVoiceSettings()
      case 'channels':
        return renderChannelsSettings()
      case 'codingDev':
        return renderCodingDevSettings()
      case 'privacy':
        return renderPrivacySettings()
      case 'pet':
        return renderPetSettings()
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
