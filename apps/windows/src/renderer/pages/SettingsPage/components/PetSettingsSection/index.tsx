/**
 * 宠物模式设置区块：虚拟人模型选择、对话 Agent、表情/动作/语音等开关、主动联系与打开/关闭按钮
 */
import React, { useEffect, useState } from 'react'
import { Card } from '../../../../components/ui/Card/Card'
import { Button } from '../../../../components/ui/Button/Button'
import { Input } from '../../../../components/ui/Input/Input'
import { Checkbox } from '../../../../components/ui/Checkbox/Checkbox'
import { Select } from '../../../../components/ui/Select/Select'
import { useToast } from '../../../../components/ui/Toast/useToast'
import { getAgents, type Agent } from '../../../../services/agent-service'
import {
  subscribePetModeChanged,
  listPetModels,
  getCurrentPetModelId,
  getPetMode,
  getPetPersonality,
  getVirtualHumanSettings,
  setVirtualHumanSettings,
  setCurrentPetModelId,
  switchPetMode,
} from '../../../../services/pet-service'
import type { PetModelConfigDTO } from '../../../../../shared/pet-mode'
import {
  type VirtualHumanSettingsDTO,
  DEFAULT_VH_SETTINGS,
} from '../../../../../shared/virtual-human'
import { useFeatureAvailability } from '../../../../hooks/business/useFeatureAvailability'
import { expressionCapability, type ExpressionCapability } from '@mtbot/pet-core'
import styles from '../../SettingsPage.module.css'

/** 宠物模式 Agent 选择的本地存储键 */
const PET_AGENT_STORAGE_KEY = 'mtbot:pet-agent-id'

/**
 * 模型的表情层能力 → 给用户看的一句话（设计 §8.5）。
 *
 * **这条提示不是装饰**：没有表情层的模型（团子 / 钢羽 / shimeji 系）情绪**只能**靠
 * 动作幅度表达，不说明的话用户看到的是"我心情这么差它一点反应都没有"——
 * 会以为宠物坏了，而实际是这个模型只有一张脸。
 *
 * 判据是**能解析出几个不同表情索引**而不是 emotionMap 有几个键，理由见
 * `@mtbot/pet-core` 的 `expression-capability.ts`（xiaomai 是那条反例：
 * 14 个键全指向索引 0）。
 */
function capabilityLabel(level: ExpressionCapability): string {
  return level === 'rich' ? '表情丰富' : '基础'
}

function capabilityHint(level: ExpressionCapability): string | null {
  if (level === 'rich') return null
  if (level === 'none') {
    return '这个模型只有一张脸，它的情绪主要通过动作幅度表达（呼吸、浮动、走动）'
  }
  return '这个模型的表情较少，情绪主要靠动作幅度表达'
}

export const PetSettingsSection: React.FC = () => {
  const toast = useToast()
  const { isAvailable, blockMessage, ready } = useFeatureAvailability()
  const petModeBlocked = !isAvailable('petMode')

  // 宠物模式 Agent + 模型 + 设置
  const [petAgents, setPetAgents] = useState<Agent[]>([])
  const [petAgentId, setPetAgentId] = useState<string>(() => localStorage.getItem(PET_AGENT_STORAGE_KEY) ?? '')
  const [vhModels, setVhModels] = useState<PetModelConfigDTO[]>([])
  const [vhCurrentModelId, setVhCurrentModelId] = useState<string>('')
  const [vhSettings, setVhSettings] = useState<VirtualHumanSettingsDTO>(DEFAULT_VH_SETTINGS)
  const [isPetModeActive, setIsPetModeActive] = useState<boolean>(false)
  /** 气质标签（宠物智能化第一期）。null = 还没取到，别凭空编一个脾气出来 */
  const [petPersonality, setPetPersonality] = useState<string | null>(null)

  /**
   * 加载 Agent 列表、模型列表与设置
   */
  useEffect(() => {
    // Agent 列表与宠物模式无关，始终加载（本页其它设置项也要用）
    getAgents().then((r) => setPetAgents(r.agents ?? [])).catch(() => {})
    // 屏蔽平台上 pet:* handler 未注册，调用只会在控制台刷 "No handler registered"。
    // 挂载点要在入口层短路——与按钮置灰同一个判据。
    //
    // **必须等 `ready`**：`isAvailable` 在矩阵取回前返回 true（见 hook 文件头），
    // 只判 `petModeBlocked` 的话首次渲染就把请求发出去了，这条短路等于没加。
    if (!ready || petModeBlocked) return
    void listPetModels().then((m) => setVhModels([...m]))
    void getCurrentPetModelId().then(setVhCurrentModelId)
    void getVirtualHumanSettings().then((s) => { if (s) setVhSettings(s) })
    void getPetMode().then((mode) => setIsPetModeActive(mode === 'pet'))
  }, [ready, petModeBlocked])

  /**
   * 订阅主进程宠物模式变更事件，同步"打开/关闭"按钮文案（托盘/快捷键/控制坞等路径均会触发）
   */
  useEffect(() => {
    const handleModeChanged = (mode: unknown) => {
      setIsPetModeActive(mode === 'pet')
    }
    return subscribePetModeChanged(handleModeChanged)
  }, [])

  /**
   * 气质标签：宠物人格按模型分只（`pet:<模型ID>`），首次读即出生抽签，此后不再重掷。
   * 换模型 = 换一只宠物，所以依赖模型 ID 重取。
   */
  useEffect(() => {
    if (!ready || petModeBlocked) return
    const modelId = vhCurrentModelId || vhModels[0]?.id || ''
    if (!modelId) return
    let cancelled = false
    void getPetPersonality(modelId).then((p) => {
      if (!cancelled) setPetPersonality(p?.label ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [ready, petModeBlocked, vhCurrentModelId, vhModels])

  const currentModel = vhModels.find((m) => m.id === vhCurrentModelId) ?? vhModels[0]
  const patchVh = async (patch: Partial<VirtualHumanSettingsDTO>) => {
    setVhSettings((prev) => ({ ...prev, ...patch }))
    try {
      const next = await setVirtualHumanSettings(patch)
      if (next) setVhSettings(next)
    } catch { /* 忽略 */ }
  }

  return (
    <div className={styles['settings-section']}>
      <h3 data-app-ui-section-title>宠物模式</h3>
      <Card>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 13, lineHeight: 1.6, margin: 0 }}>
            打开宠物模式后，桌面会出现一个可交互的 Live2D 虚拟人。你可以语音或文字与它对话，
            它会用表情、口型和动作回应。主界面保持原样，宠物与它并行存在，随时可以关闭。
          </p>
          <ul style={{ color: 'var(--color-text-secondary)', fontSize: 12, lineHeight: 1.8, margin: 0, paddingLeft: 18 }}>
            <li>三种打开方式：本页按钮 / 托盘菜单 / 快捷键 <strong>Ctrl+Shift+P</strong></li>
            <li>虚拟人身体默认点击穿透，悬停到控制坞时恢复点击；<strong>Ctrl+Shift+I</strong> 切换强制穿透</li>
            <li>对话跟随当前会话，关闭后聊天记录连续</li>
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
                options={vhModels.map((m) => ({
                  value: m.id,
                  label: `${m.name}（${capabilityLabel(expressionCapability(m.emotionMap))}）`,
                }))}
                onChange={(e) => {
                  const id = e.target.value
                  setVhCurrentModelId(id)
                  void setCurrentPetModelId(id)
                }}
                className={styles['setting-select']}
              />
            </div>
            {/* 能力差异必须对用户可见，否则"没反应"会被读成"坏了"（设计 §8.5 / 验收 U7） */}
            {currentModel && capabilityHint(expressionCapability(currentModel.emotionMap)) && (
              <span className={styles['setting-hint']}>
                {capabilityHint(expressionCapability(currentModel.emotionMap))}
              </span>
            )}
          </div>

          {/* 气质标签（宠物智能化第一期）：宠物是独立 Agent，它的脾气与助手互不影响 */}
          {petPersonality && (
            <div className={styles['setting-item']}>
              <label className={styles['setting-label']} data-app-ui-label>它的脾气</label>
              <span className={styles['setting-hint']}>
                出生时随机抽签，之后随相处缓慢变化——换个模型就是另一只，脾气也不一样
              </span>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--color-text-primary)' }}>
                {petPersonality}
              </p>
            </div>
          )}

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

          {/* Agent 活动感知（R5/R6） */}
          <div className={styles['setting-item']}>
            <Checkbox
              checked={vhSettings.enableAgentActivity}
              onChange={(checked) => void patchVh({ enableAgentActivity: checked })}
            >
              Agent 状态感知
            </Checkbox>
            <span className={styles['setting-hint']}>
              Agent 在思考、跑工具、等你确认时，宠物的呼吸与姿态跟着变；关闭则只按自己的节奏待机
            </span>
          </div>

          {/* Agent 通知（R6「叫得动」） */}
          <div className={styles['setting-item']}>
            <Checkbox
              checked={vhSettings.enableAgentNotice}
              onChange={(checked) => void patchVh({ enableAgentNotice: checked })}
            >
              Agent 通知
            </Checkbox>
            <span className={styles['setting-hint']}>
              任务完成、等你审批、向你提问时，宠物会冒一句话并在控制坞列出待办，需要你出手的还会发系统通知；
              关闭则完全不打扰
            </span>
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

          {/* 闲置感知 */}
          <div className={styles['setting-item']}>
            <Checkbox
              checked={vhSettings.enableIdleAwareness}
              onChange={(checked) => void patchVh({ enableIdleAwareness: checked })}
            >
              闲置感知
            </Checkbox>
            <span className={styles['setting-hint']}>
              离开一会儿宠物会打盹，久了闭眼睡着，回来即醒。关闭则一直保持清醒（只读取系统闲置时长，不涉及任何按键内容）
            </span>
          </div>

          {/* 强制穿透默认值 */}
          <div className={styles['setting-item']}>
            <Checkbox
              checked={vhSettings.forceIgnoreMouse}
              onChange={(checked) => void patchVh({ forceIgnoreMouse: checked })}
            >
              默认开启强制穿透
            </Checkbox>
            <span className={styles['setting-hint']}>开启后打开宠物模式时鼠标仅穿透宠物身体（控制坞仍可点击）；已在宠物模式时立即生效。也可用 Ctrl+Shift+I 临时切换</span>
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
              disabled={petModeBlocked}
              title={petModeBlocked ? (blockMessage('petMode') ?? undefined) : undefined}
              onClick={async () => {
                const target = isPetModeActive ? 'desktop' : 'pet'
                const r = await switchPetMode(target)
                if (r && !r.success) {
                  toast.error(`${isPetModeActive ? '退出' : '进入'}宠物模式失败：${r.error ?? '未知错误'}`)
                }
              }}
            >
              {isPetModeActive ? '关闭宠物模式' : '打开宠物模式'}
            </Button>
            {/* D4：屏蔽必须给出原因，不能只是把按钮变灰 */}
            {petModeBlocked && (
              <p className={styles['setting-hint']}>{blockMessage('petMode')}</p>
            )}
          </div>
        </div>
      </Card>
    </div>
  )
}
