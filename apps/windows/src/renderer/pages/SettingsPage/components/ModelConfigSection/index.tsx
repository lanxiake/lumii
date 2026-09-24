import { useState, useEffect, useCallback, useRef } from 'react'
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
  PROVIDER_TYPE_DEFAULTS,
  PROVIDER_TYPE_LABEL,
  listProviderTypesForSlot,
  supportsApiFormatChoice,
  CAPABILITY_SLOT_LABEL,
  CAPABILITY_SLOT_DESC,
  CAPABILITY_SLOTS,
  createDefaultSlotsConfig,
  type LocalProviderConfigView,
  type ProviderSlotsConfigView,
  type ProviderType,
  type CapabilitySlot,
  type ListedModel,
  type ThinkingFormat,
  defaultContextWindowK,
  defaultSupportsReasoning,
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
          // 端点级参数一并复制（apiFormat / 思考参数格式属于同一个 Provider）
          apiFormat: chat.apiFormat,
          thinkingFormat: chat.thinkingFormat,
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
      toast.success('模型能力槽配置已保存（新会话生效）')
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
    const modelReasoning = cfg.modelReasoning ?? {}
    /** 未显式勾选时显示内置默认表推断值（勾一次即落成显式值） */
    const reasoningFor = (modelId: string) =>
      modelReasoning[modelId] ?? defaultSupportsReasoning(modelId)
    const setModelReasoning = (modelId: string, value: boolean) => {
      patchSlot(slot, { modelReasoning: { ...modelReasoning, [modelId]: value } })
    }
    const thinkingCheckbox = (modelId: string) => (
      <Checkbox
        checked={reasoningFor(modelId)}
        aria-label={`${modelId} 支持思考`}
        onChange={(next) => setModelReasoning(modelId, next)}
      >
        <span className={styles['setting-desc']} title="该模型是否支持思考（reasoning）。不勾选时不会发送任何思考参数。">
          思考
        </span>
      </Checkbox>
    )

    /** 候选模型集合：显式勾过就用勾的，否则退化为「当前这一个」 */
    const allowedIds = cfg.allowedModelIds?.length
      ? cfg.allowedModelIds
      : (cfg.modelId ? [cfg.modelId] : [])
    /**
     * image 槽下拉的候选项 = 远端拉到的列表 ∪ 已配置的候选。
     * 右半边不能省：中转站的模型列表常常拉不到（rightapi 就没有这个端点），
     * 那时下拉里只剩手填的那几个，否则用户会以为「模型没法改」。
     */
    const imageModelOptions =
      slot === 'image' ? [...new Set([...models.map((m) => m.id), ...allowedIds])] : []
    /**
     * 每个模型行右侧的附加配置。**生图模型没有这两个概念**，不渲染——
     * 给 image 槽挂上「上下文长度(K)」和「思考」只会让人以为它们有用。
     */
    const modelExtras = (modelId: string) =>
      slot === 'image' ? null : (
        <>
          <Input
            type="number"
            min={1}
            step={1}
            value={String(contextWindowK[modelId] ?? defaultContextWindowK(modelId))}
            onChange={(e) => setContextWindowK(modelId, e.target.value)}
            style={{ width: 90 }}
            aria-label={`${modelId} 上下文长度（K）`}
          />
          <span className={styles['setting-desc']}>K</span>
          {thinkingCheckbox(modelId)}
        </>
      )

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
                    const defaults = PROVIDER_TYPE_DEFAULTS[nextType]
                    patchSlot(slot, {
                      type: nextType,
                      ...(isUntouched ? { baseUrl: PROVIDER_DEFAULT_BASE_URL[nextType] } : {}),
                      ...(defaults.apiFormat ? { apiFormat: defaults.apiFormat } : {}),
                      thinkingFormat: defaults.thinkingFormat,
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
                      : '多数 OpenAI 兼容端点无需手写 /v1（会自动补全）；OpenRouter / 智谱 / 百炼 等预设已带完整路径'}
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
              {/*
                密文读不出来时，输入框必然是空的——不解释一句，用户会以为是自己没填过，
                于是在这里重填一遍、保存、重启，问题照旧（而且旧密文已经被这次保存覆盖掉了）。
                文案里的「原密文会保留」对应 main 侧 preserveUnreadableKey()，不是安慰话。
                补 `!cfg.apiKey`：用户一开始打字就撤掉提示，否则「请重新填写」会一直挂在他已经填好的框下面。
              */}
              {cfg.apiKeyDecryptFailed && !cfg.apiKey && (
                <div
                  className={styles['field-msg']}
                  role="alert"
                  style={{
                    backgroundColor: 'var(--color-error-bg)',
                    color: 'var(--color-error)',
                  }}
                >
                  已保存的凭据无法解密（密钥环可能已变更，或配置来自其他系统），因此这里显示为空。
                  请重新填写——原密文会保留，不会因保存被覆盖。
                </div>
              )}
            </div>

            {supportsApiFormatChoice(cfg.type) && (
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

            {supportsApiFormatChoice(cfg.type) && (
              <div className={styles['setting-item']}>
                <div className={styles['setting-label']}>
                  <span data-app-ui-label>思考参数格式</span>
                  <span className={styles['setting-desc']}>
                    自动会按端点推断：qwen 系模型用 chat_template_kwargs，z.ai 用 thinking，其余用
                    reasoning_effort。端点不认某种格式时在这里改（对话页的思考开关依赖它才生效）
                  </span>
                </div>
                <div className={styles['setting-control']}>
                  <Select
                    value={cfg.thinkingFormat ?? 'auto'}
                    aria-label="思考参数格式"
                    options={[
                      { value: 'auto', label: '自动（按端点与模型推断）' },
                      { value: 'openai', label: 'OpenAI：reasoning_effort' },
                      { value: 'qwen', label: 'Qwen / vLLM：enable_thinking' },
                      { value: 'zai', label: '智谱 z.ai：thinking.type' },
                    ]}
                    onChange={(e) =>
                      patchSlot(slot, { thinkingFormat: e.target.value as ThinkingFormat })
                    }
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
                      ? '可勾选多个生图模型（勾选的才会被采纳）；Agent 显式指定 modelId 时用它，否则用下拉选中的那个'
                      : '可勾选多个，也可手动填写，如 dall-e-3 / gpt-image-1'
                    : slot === 'vision'
                      ? '可勾选多个模型；对话/识别时再选用其一'
                      : '可勾选多个模型；对话框中切换使用'}
                </span>
              </div>
              <div className={styles['setting-control']} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {models.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflow: 'auto' }}>
                    {models.map((m) => {
                      const checked = allowedIds.includes(m.id)
                      return (
                        <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <Checkbox
                            checked={checked}
                            onChange={(next) => {
                              const nextIds = next
                                ? [...new Set([...allowedIds, m.id])]
                                : allowedIds.filter((id) => id !== m.id)
                              const nextModelId =
                                nextIds.includes(cfg.modelId) ? cfg.modelId : (nextIds[0] ?? '')
                              patchSlot(slot, { allowedModelIds: nextIds, modelId: nextModelId })
                              setSlotModelIdsText((t) => ({ ...t, [slot]: undefined }))
                            }}
                          >
                            {m.name || m.id}
                          </Checkbox>
                          {modelExtras(m.id)}
                        </div>
                      )
                    })}
                  </div>
                ) : null}
                {/*
                  生图槽多一个「默认用哪个」的下拉：chat/vision 是在对话里切模型，
                  而 image 槽只有一个 modelId 决定 image_generate 用谁（Agent 显式传 modelId 时才被覆盖）。
                  选中一个不在候选集里的模型时**并入**候选集而不是顶掉它——
                  用户点这一下的意图是「改默认」，不该顺手丢掉他配过的其它模型。
                */}
                {slot === 'image' && imageModelOptions.length > 0 && (
                  <Select
                    value={cfg.modelId}
                    aria-label="默认生图模型"
                    options={imageModelOptions.map((id) => ({ value: id, label: id }))}
                    onChange={(e) =>
                      patchSlot(slot, {
                        modelId: e.target.value,
                        allowedModelIds: [...new Set([...allowedIds, e.target.value])],
                      })
                    }
                  />
                )}
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
                {slot !== 'image' && models.length === 0 && allowedIds.map((id) => (
                  <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className={styles['setting-desc']}>{id}</span>
                    {modelExtras(id)}
                  </div>
                ))}
                {slot !== 'image' && slotModelIdsText[slot] && slotModelIdsText[slot]!.split(',').map((id) => id.trim()).filter(Boolean).length === 1 && (() => {
                  const id = slotModelIdsText[slot]!.split(',')[0]!.trim()
                  return <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className={styles['setting-desc']}>上下文长度</span>
                    <Input type="number" min={1} step={1} value={String(contextWindowK[id] ?? defaultContextWindowK(id))} onChange={(e) => setContextWindowK(id, e.target.value)} style={{ width: 90 }} />
                    <span className={styles['setting-desc']}>K</span>
                    {thinkingCheckbox(id)}
                  </div>
                })()}
                {allowedIds.length > 0 && (
                  <span className={styles['setting-desc']}>
                    已选 {allowedIds.length} 个；{slot === 'image' ? 'Agent 未指定模型时用' : '默认使用'}：{cfg.modelId || '（未设）'}
                  </span>
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
