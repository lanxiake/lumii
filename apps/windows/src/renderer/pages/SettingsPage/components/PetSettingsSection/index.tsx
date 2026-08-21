/**
 * 宠物模式设置区块：虚拟人模型选择、对话 Agent、表情/动作/语音等开关、主动联系与进入/退出按钮
 */
import React, { useEffect, useState } from 'react'
import { Card } from '../../../../components/ui/Card/Card'
import { Button } from '../../../../components/ui/Button/Button'
import { Input } from '../../../../components/ui/Input/Input'
import { Checkbox } from '../../../../components/ui/Checkbox/Checkbox'
import { Select } from '../../../../components/ui/Select/Select'
import { useToast } from '../../../../components/ui/Toast/useToast'
import { getAgents, type Agent } from '../../../../services/agent-service'
import type { PetModelConfigDTO } from '../../../../../shared/pet-mode'
import {
  type VirtualHumanSettingsDTO,
  DEFAULT_VH_SETTINGS,
} from '../../../../../shared/virtual-human'
import styles from '../../SettingsPage.module.css'

/** 宠物模式 Agent 选择的本地存储键 */
const PET_AGENT_STORAGE_KEY = 'mtbot:pet-agent-id'

export const PetSettingsSection: React.FC = () => {
  const toast = useToast()

  // 宠物模式 Agent + 模型 + 设置
  const [petAgents, setPetAgents] = useState<Agent[]>([])
  const [petAgentId, setPetAgentId] = useState<string>(() => localStorage.getItem(PET_AGENT_STORAGE_KEY) ?? '')
  const [vhModels, setVhModels] = useState<PetModelConfigDTO[]>([])
  const [vhCurrentModelId, setVhCurrentModelId] = useState<string>('')
  const [vhSettings, setVhSettings] = useState<VirtualHumanSettingsDTO>(DEFAULT_VH_SETTINGS)
  const [isPetModeActive, setIsPetModeActive] = useState<boolean>(false)

  /**
   * 加载 Agent 列表、模型列表与设置
   */
  useEffect(() => {
    getAgents().then((r) => setPetAgents(r.agents ?? [])).catch(() => {})
    const pet = window.electronAPI?.pet
    if (!pet) return
    pet.listModels?.().then((m) => setVhModels(m ?? [])).catch(() => {})
    pet.getCurrentModelId?.().then(setVhCurrentModelId).catch(() => {})
    pet.getVirtualHumanSettings?.().then(setVhSettings).catch(() => {})
    pet.getMode?.().then((mode) => setIsPetModeActive(mode === 'pet')).catch(() => {})
  }, [])

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
      <h3 data-app-ui-section-title>宠物模式</h3>
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
            <label className={styles['setting-label']} data-app-ui-label>虚拟人模型</label>
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
            <label className={styles['setting-label']} data-app-ui-label>对话 Agent</label>
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
                <label className={styles['setting-label']} data-app-ui-label>联系频率</label>
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
                <label className={styles['setting-label']} data-app-ui-label>怎么称呼你</label>
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
