import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Card } from '../../../../components/ui/Card/Card'
import { Button } from '../../../../components/ui/Button/Button'
import { Input } from '../../../../components/ui/Input/Input'
import { Loading } from '../../../../components/ui/Loading/Loading'
import { Checkbox } from '../../../../components/ui/Checkbox/Checkbox'
import { Select } from '../../../../components/ui/Select/Select'
import { useToast } from '../../../../components/ui/Toast/useToast'
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
  defaultContextWindowK,
} from '../../../../services/model-config-service'
import styles from '../../SettingsPage.module.css'

export function ModelConfigSection() {
  const toast = useToast()

  const [providerSlots, setProviderSlots] = useState<ProviderSlotsConfigView | null>(null)
  const [providerLoading, setProviderLoading] = useState(false)
  const [providerSaving, setProviderSaving] = useState(false)
  const [slotModels, setSlotModels] = useState<Partial<Record<CapabilitySlot, ListedModel[]>>>({})
  const [slotModelIdsText, setSlotModelIdsText] = useState<Partial<Record<CapabilitySlot, string>>>({})
  const [slotListing, setSlotListing] = useState<Partial<Record<CapabilitySlot, boolean>>>({})
  const [slotTesting, setSlotTesting] = useState<Partial<Record<CapabilitySlot, boolean>>>({})
  const [expandedSlots, setExpandedSlots] = useState<Partial<Record<CapabilitySlot, boolean>>>({
    chat: true,
  })
  const [showApiKeyBySlot, setShowApiKeyBySlot] = useState<Partial<Record<CapabilitySlot, boolean>>>({})
  const providerDraftCacheRef = useRef<
    Partial<
      Record<
        string,
        { baseUrl: string; modelId: string; allowedModelIds: string[]; modelIdsText?: string }
      >
    >
  >({})
  const slotModelIdsTextRef = useRef<Partial<Record<CapabilitySlot, string>>>({})
  slotModelIdsTextRef.current = slotModelIdsText

  useEffect(() => {
    setProviderLoading(true)
    providerDraftCacheRef.current = {}
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
        console.warn('[ModelConfigSection] 读取 Provider 配置失败', err)
        toast.error('读取 Provider 配置失败')
        setProviderSlots(createDefaultSlotsConfig())
      })
      .finally(() => setProviderLoading(false))
  }, [toast])

  const patchSlot = useCallback((slot: CapabilitySlot, patch: Partial<LocalProviderConfigView>) => {
    setProviderSlots((prev) => {
      if (!prev) return prev
      const current = prev[slot]
      const nextSlot = { ...current, ...patch }
      if (patch.type && patch.type !== current.type) {
        const cache = providerDraftCacheRef.current
        cache[`${slot}:${current.type}`] = {
          baseUrl: current.baseUrl,
          modelId: current.modelId,
          allowedModelIds: [...(current.allowedModelIds ?? [])],
          modelIdsText: slotModelIdsTextRef.current[slot],
        }
        const restored = cache[`${slot}:${patch.type}`]
        if (restored) {
          nextSlot.baseUrl = restored.baseUrl
          nextSlot.modelId = restored.modelId
          nextSlot.allowedModelIds = [...restored.allowedModelIds]
          setSlotModelIdsText((t) => ({ ...t, [slot]: restored.modelIdsText }))
        } else {
          nextSlot.baseUrl = PROVIDER_DEFAULT_BASE_URL[patch.type]
          nextSlot.modelId = ''
          nextSlot.allowedModelIds = []
          setSlotModelIdsText((t) => ({ ...t, [slot]: undefined }))
        }
        setSlotModels((m) => ({ ...m, [slot]: [] }))
      }
      if (patch.enabled === true) {
        setExpandedSlots((e) => ({ ...e, [slot]: true }))
      }
      return { ...prev, [slot]: nextSlot }
    })
  }, [])

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

  const handleListModels = useCallback(async (slot: CapabilitySlot) => {
    if (!providerSlots) return
    setSlotListing((s) => ({ ...s, [slot]: true }))
    try {
      const models = await listProviderModels(slot, providerSlots[slot])
      setSlotModels((m) => ({ ...m, [slot]: models }))
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
      console.error('[ModelConfigSection] 获取模型列表失败', err)
      toast.error(err instanceof Error ? err.message : '获取模型列表失败')
    } finally {
      setSlotListing((s) => ({ ...s, [slot]: false }))
    }
  }, [providerSlots, toast, patchSlot])

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
      console.error('[ModelConfigSection] 测试连接失败', err)
      toast.error(err instanceof Error ? err.message : '测试连接失败')
    } finally {
      setSlotTesting((s) => ({ ...s, [slot]: false }))
    }
  }, [providerSlots, toast])

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
      console.error('[ModelConfigSection] 保存 Provider 配置失败', err)
      toast.error('保存 Provider 配置失败')
    } finally {
      setProviderSaving(false)
    }
  }, [providerSlots, toast])

  const renderSlotCard = (slot: CapabilitySlot) => {
    if (!providerSlots) return null
    const cfg = providerSlots[slot]
    const isLocalProvider = cfg.type === 'ollama' || cfg.type === 'lmstudio'
    const expanded = expandedSlots[slot] === true
    const models = slotModels[slot] ?? []
    const contextWindowK = cfg.contextWindowK ?? {}
    const setContextWindowK = (modelId: string, value: string) => {
      const n = Number(value)
      const next = { ...contextWindowK }
      if (value.trim() === '') delete next[modelId]
      else if (Number.isFinite(n) && n > 0) next[modelId] = n
      patchSlot(slot, { contextWindowK: next })
    }

    return (
      <Card key={slot}>
        <div className={styles['setting-item']}>
          <div className={styles['setting-label']}>
            <span data-app-ui-heading>{CAPABILITY_SLOT_LABEL[slot]}</span>
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
                <span data-app-ui-label>Provider 类型</span>
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
                    const isUntouched =
                      !cfg.baseUrl?.trim() ||
                      Object.values(PROVIDER_DEFAULT_BASE_URL).includes(cfg.baseUrl.trim())
                    const defaultApiFormat = nextType === 'deepseek' ? 'responses' : 'completions'
                    patchSlot(slot, {
                      type: nextType,
                      ...(isUntouched ? { baseUrl: PROVIDER_DEFAULT_BASE_URL[nextType] } : {}),
                      apiFormat: defaultApiFormat,
                    })
                  }}
                />
              </div>
            </div>

            <div className={styles['setting-item']}>
              <div className={styles['setting-label']}>
                <span data-app-ui-label>接口地址（Base URL）</span>
                <span className={styles['setting-desc']}>
                  {cfg.type === 'deepseek'
                    ? 'DeepSeek 使用固定端点，无需修改'
                    : cfg.type === 'rightapi'
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
                  disabled={cfg.type === 'deepseek'}
                />
              </div>
            </div>

            <div className={styles['setting-item']}>
              <div className={styles['setting-label']}>
                <span data-app-ui-label>API Key</span>
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

            {(cfg.type === 'openai' || cfg.type === 'deepseek') && (
              <div className={styles['setting-item']}>
                <div className={styles['setting-label']}>
                  <span data-app-ui-label>API 格式</span>
                  <span className={styles['setting-desc']}>
                    responses 接口支持 prompt caching（推荐）；completions 为传统接口
                  </span>
                </div>
                <div className={styles['setting-control']}>
                  <Select
                    value={cfg.apiFormat ?? 'responses'}
                    options={[
                      { value: 'responses', label: 'Responses（推荐，支持缓存）' },
                      { value: 'completions', label: 'Completions（传统）' },
                    ]}
                    onChange={(e) => patchSlot(slot, { apiFormat: e.target.value as 'completions' | 'responses' })}
                  />
                </div>
              </div>
            )}

            <div className={styles['setting-item']}>
              <div className={styles['setting-label']}>
                <span data-app-ui-label>模型 ID</span>
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
                            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <Checkbox
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
                                setSlotModelIdsText((t) => ({ ...t, [slot]: undefined }))
                              }}
                            >
                                {m.name || m.id}
                              </Checkbox>
                              <Input
                                type="number"
                                min={1}
                                step={1}
                                value={String(contextWindowK[m.id] ?? defaultContextWindowK(m.id))}
                                onChange={(e) => setContextWindowK(m.id, e.target.value)}
                                style={{ width: 90 }}
                                aria-label={`${m.id} 上下文长度（K）`}
                              />
                              <span className={styles['setting-desc']}>K</span>
                            </div>
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
                    {models.length === 0 && (cfg.allowedModelIds ?? []).map((id) => (
                      <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className={styles['setting-desc']}>{id}</span>
                        <Input
                          type="number"
                          min={1}
                          step={1}
                          value={String(contextWindowK[id] ?? defaultContextWindowK(id))}
                          onChange={(e) => setContextWindowK(id, e.target.value)}
                          style={{ width: 90 }}
                          aria-label={`${id} 上下文长度（K）`}
                        />
                        <span className={styles['setting-desc']}>K</span>
                      </div>
                    ))}
                    {slotModelIdsText[slot] && slotModelIdsText[slot]!.split(',').map((id) => id.trim()).filter(Boolean).length === 1 && (() => {
                      const id = slotModelIdsText[slot]!.split(',')[0]!.trim()
                      return <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className={styles['setting-desc']}>上下文长度</span>
                        <Input type="number" min={1} step={1} value={String(contextWindowK[id] ?? defaultContextWindowK(id))} onChange={(e) => setContextWindowK(id, e.target.value)} style={{ width: 90 }} />
                        <span className={styles['setting-desc']}>K</span>
                      </div>
                    })()}
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

  if (providerLoading || !providerSlots) {
    return (
      <div className={styles['settings-section']}>
        <Loading text="加载中..." />
      </div>
    )
  }

  return (
    <div className={styles['settings-section']}>
      <h3 data-app-ui-section-title>模型能力槽</h3>
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
