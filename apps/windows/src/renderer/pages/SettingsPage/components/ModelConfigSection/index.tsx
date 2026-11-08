import { useState, useEffect, useCallback, useRef } from 'react'
import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react'
import { Card } from '../../../../components/ui/Card/Card'
import { Button } from '../../../../components/ui/Button/Button'
import { Input } from '../../../../components/ui/Input/Input'
import { Loading } from '../../../../components/ui/Loading/Loading'
import { Checkbox } from '../../../../components/ui/Checkbox/Checkbox'
import { Select } from '../../../../components/ui/Select/Select'
import { useToast } from '../../../../components/ui/Toast/useToast'
import {
  getProviderStore,
  saveProviderStore,
  listProviderModels,
  testProviderConnection,
  probeProviderApiFormat,
  resolveSlotFromStore,
  createProviderEntry,
  createDefaultProviderStore,
  providerDisplayName,
  PROVIDER_DEFAULT_BASE_URL,
  PROVIDER_TYPE_DEFAULTS,
  PROVIDER_TYPE_LABEL,
  listProviderTypesForSlot,
  supportsApiFormatChoice,
  CAPABILITY_SLOT_LABEL,
  CAPABILITY_SLOT_DESC,
  CAPABILITY_SLOTS,
  type LocalProviderConfigView,
  type ProviderStoreView,
  type ProviderEntryView,
  type SlotSelectionView,
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

  const [store, setStore] = useState<ProviderStoreView | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  /** 每个 provider 的远端模型列表 / 拉取与测试中的状态 */
  const [providerModels, setProviderModels] = useState<Record<string, ListedModel[]>>({})
  const [listingProvider, setListingProvider] = useState<Record<string, boolean>>({})
  const [testingProvider, setTestingProvider] = useState<Record<string, boolean>>({})
  const [probingProvider, setProbingProvider] = useState<Record<string, boolean>>({})
  /** 手动输入模型 ID 的临时文本（按 provider 存，逗号分隔） */
  const [modelIdsText, setModelIdsText] = useState<Record<string, string>>({})
  const [showApiKey, setShowApiKey] = useState<Record<string, boolean>>({})
  const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>({})
  const modelIdsTextRef = useRef(modelIdsText)
  modelIdsTextRef.current = modelIdsText

  useEffect(() => {
    setLoading(true)
    getProviderStore()
      .then((s) => {
        setStore(s)
        const first = s.providers[0]?.id
        if (first) setExpandedProviders({ [first]: true })
      })
      .catch((err) => {
        console.warn('[ModelConfigSection] 读取 Provider 配置失败', err)
        toast.error('读取 Provider 配置失败')
        setStore(createDefaultProviderStore())
      })
      .finally(() => setLoading(false))
  }, [toast])

  const patchProvider = useCallback((id: string, patch: Partial<ProviderEntryView>) => {
    setStore((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        providers: prev.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
      }
    })
  }, [])

  const patchSlot = useCallback((slot: CapabilitySlot, patch: Partial<SlotSelectionView>) => {
    setStore((prev) => {
      if (!prev) return prev
      return { ...prev, slots: { ...prev.slots, [slot]: { ...prev.slots[slot], ...patch } } }
    })
  }, [])

  const addProvider = useCallback(() => {
    setStore((prev) => {
      if (!prev) return prev
      const entry = createProviderEntry('openai')
      // 本地生成临时 id；保存时主进程会保留它
      let n = prev.providers.length + 1
      while (prev.providers.some((p) => p.id === `p${n}`)) n += 1
      entry.id = `p${n}`
      return { ...prev, providers: [...prev.providers, entry] }
    })
  }, [])

  /**
   * 删除 provider：同时清空引用它的槽，避免槽指向不存在的条目。
   * 这是破坏性操作（会丢一份凭据），因此要求确认。
   */
  const removeProvider = useCallback(
    (id: string) => {
      if (!store) return
      const target = store.providers.find((p) => p.id === id)
      const usedBy = CAPABILITY_SLOTS.filter((s) => store.slots[s].providerId === id)
      const label = target ? providerDisplayName(target) : id
      const question = usedBy.length
        ? `删除「${label}」？${usedBy.map((s) => CAPABILITY_SLOT_LABEL[s]).join('、')}将失去提供商配置。`
        : `删除「${label}」？`
      if (!window.confirm(question)) return

      setStore((prev) => {
        if (!prev) return prev
        const slots = { ...prev.slots }
        for (const slot of CAPABILITY_SLOTS) {
          if (slots[slot].providerId === id) {
            slots[slot] = { ...slots[slot], providerId: '', enabled: false }
          }
        }
        return { providers: prev.providers.filter((p) => p.id !== id), slots }
      })
    },
    [store],
  )

  /** 手动输入框失焦/回车时，把逗号分隔文本落成 modelIds */
  const commitModelIdsText = useCallback(
    (id: string) => {
      const text = modelIdsTextRef.current[id]
      if (text === undefined) return
      const ids = [...new Set(text.split(',').map((s) => s.trim()).filter(Boolean))]
      patchProvider(id, { modelIds: ids })
      setModelIdsText((t) => {
        const next = { ...t }
        delete next[id]
        return next
      })
    },
    [patchProvider],
  )

  const handleListModels = useCallback(
    async (provider: ProviderEntryView) => {
      setListingProvider((s) => ({ ...s, [provider.id]: true }))
      try {
        const draft = slotDraftForTest(store, provider)
        const models = await listProviderModels('chat', draft)
        setProviderModels((m) => ({ ...m, [provider.id]: models }))
        if (models.length === 0) {
          toast.warning('未获取到模型，可手动填写模型 ID')
        } else {
          toast.success(`已获取 ${models.length} 个模型`)
        }
      } catch (err) {
        console.error('[ModelConfigSection] 获取模型列表失败', err)
        toast.error(err instanceof Error ? err.message : '获取模型列表失败')
      } finally {
        setListingProvider((s) => ({ ...s, [provider.id]: false }))
      }
    },
    [store, toast],
  )

  const handleTestConnection = useCallback(
    async (provider: ProviderEntryView) => {
      setTestingProvider((s) => ({ ...s, [provider.id]: true }))
      try {
        const draft = slotDraftForTest(store, provider)
        const result = await testProviderConnection('chat', draft)
        if (result.ok) toast.success(`${providerDisplayName(provider)}：${result.message}`)
        else toast.error(`${providerDisplayName(provider)}：${result.message}`)
      } catch (err) {
        console.error('[ModelConfigSection] 测试连接失败', err)
        toast.error(err instanceof Error ? err.message : '测试连接失败')
      } finally {
        setTestingProvider((s) => ({ ...s, [provider.id]: false }))
      }
    },
    [store, toast],
  )

  const handleProbeApiFormat = useCallback(
    async (provider: ProviderEntryView) => {
      setProbingProvider((s) => ({ ...s, [provider.id]: true }))
      try {
        const draft = slotDraftForTest(store, provider)
        const res = await probeProviderApiFormat('chat', draft)
        if (!res.success || !res.data) {
          toast.error(res.error ?? '探测 API 格式失败')
          return
        }
        patchProvider(provider.id, { apiFormat: res.data.recommended })
        toast.success(res.data.message)
      } catch (err) {
        console.error('[ModelConfigSection] 探测 API 格式失败', err)
        toast.error(err instanceof Error ? err.message : '探测 API 格式失败')
      } finally {
        setProbingProvider((s) => ({ ...s, [provider.id]: false }))
      }
    },
    [store, toast, patchProvider],
  )

  const handleSave = useCallback(async () => {
    if (!store) return
    setSaving(true)
    try {
      const saved = await saveProviderStore(store)
      setStore(saved)
      window.dispatchEvent(new CustomEvent('mtbot:provider-config-changed'))
      const chat = resolveSlotFromStore(saved, 'chat')
      if (chat.enabled && chat.modelId) {
        window.dispatchEvent(
          new CustomEvent('mtbot:chat-model-changed', {
            detail: { modelId: `${chat.providerId}::${chat.modelId}` },
          }),
        )
      }
      toast.success('模型配置已保存（新会话生效）')
    } catch (err) {
      console.error('[ModelConfigSection] 保存 Provider 配置失败', err)
      toast.error('保存 Provider 配置失败')
    } finally {
      setSaving(false)
    }
  }, [store, toast])

  const renderProviderCard = (provider: ProviderEntryView) => {
    const expanded = expandedProviders[provider.id] === true
    const isLocalProvider = provider.type === 'ollama' || provider.type === 'lmstudio'
    const models = providerModels[provider.id] ?? []
    const allowedIds = provider.modelIds
    const usedBySlots = CAPABILITY_SLOTS.filter((s) => store?.slots[s].providerId === provider.id)
    const nameOf = providerDisplayName(provider)

    return (
      <Card key={provider.id}>
        <div className={styles['setting-item']}>
          <div className={styles['setting-label']}>
            <span data-app-ui-heading>{nameOf}</span>
            <span className={styles['setting-desc']}>
              {usedBySlots.length > 0
                ? `用于：${usedBySlots.map((s) => CAPABILITY_SLOT_LABEL[s]).join('、')}`
                : '尚未被任何能力使用'}
            </span>
          </div>
          <div className={styles['setting-control']} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              className={styles['about-link']}
              onClick={() => setExpandedProviders((e) => ({ ...e, [provider.id]: !expanded }))}
            >
              {expanded ? '收起配置' : '展开配置'}
            </button>
            <Button variant="secondary" size="sm" onClick={() => removeProvider(provider.id)}>
              <Trash2 size={14} /> 删除
            </Button>
          </div>
        </div>

        {expanded && (
          <>
            <div className={styles['setting-item']}>
              <div className={styles['setting-label']}>
                <span data-app-ui-label>名称</span>
                <span className={styles['setting-desc']}>仅用于设置页与对话页的模型分组显示</span>
              </div>
              <div className={styles['setting-control']}>
                <Input
                  type="text"
                  value={provider.name}
                  placeholder={PROVIDER_TYPE_LABEL[provider.type]}
                  onChange={(e) => patchProvider(provider.id, { name: e.target.value })}
                />
              </div>
            </div>

            <div className={styles['setting-item']}>
              <div className={styles['setting-label']}>
                <span data-app-ui-label>Provider 类型</span>
              </div>
              <div className={styles['setting-control']}>
                <Select
                  value={provider.type}
                  options={listProviderTypesForSlot('chat').map((t) => ({
                    value: t,
                    label: PROVIDER_TYPE_LABEL[t],
                  }))}
                  onChange={(e) => {
                    const nextType = e.target.value as ProviderType
                    const isUntouched =
                      !provider.baseUrl?.trim() ||
                      Object.values(PROVIDER_DEFAULT_BASE_URL).includes(provider.baseUrl.trim())
                    const defaults = PROVIDER_TYPE_DEFAULTS[nextType]
                    patchProvider(provider.id, {
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
                  {provider.type === 'deepseek'
                    ? 'DeepSeek 使用固定端点，无需修改'
                    : provider.type === 'rightapi'
                      ? '填到绘图根地址（含 /draw/v1）；任务查询地址会自动推导为站点级 /v1/tasks'
                      : '多数 OpenAI 兼容端点无需手写 /v1（会自动补全）；OpenRouter / 智谱 / 百炼 等预设已带完整路径'}
                </span>
              </div>
              <div className={styles['setting-control']}>
                <Input
                  type="text"
                  value={provider.baseUrl}
                  placeholder={PROVIDER_DEFAULT_BASE_URL[provider.type]}
                  onChange={(e) => patchProvider(provider.id, { baseUrl: e.target.value })}
                  disabled={provider.type === 'deepseek'}
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
                  type={showApiKey[provider.id] ? 'text' : 'password'}
                  value={provider.apiKey}
                  placeholder={isLocalProvider ? '（可留空）' : 'sk-...'}
                  onChange={(e) => patchProvider(provider.id, { apiKey: e.target.value })}
                  suffix={
                    <button
                      type="button"
                      className={styles['about-link']}
                      aria-label={showApiKey[provider.id] ? '隐藏 API Key' : '显示 API Key'}
                      onClick={() => setShowApiKey((s) => ({ ...s, [provider.id]: !s[provider.id] }))}
                      style={{ display: 'inline-flex', alignItems: 'center', padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }}
                    >
                      {showApiKey[provider.id] ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  }
                />
              </div>
              {/*
                密文读不出来时，输入框必然是空的——不解释一句，用户会以为是自己没填过，
                于是在这里重填一遍、保存、重启，问题照旧（而且旧密文已经被这次保存覆盖掉了）。
                文案里的「原密文会保留」对应 main 侧 preserveUnreadableKey()，不是安慰话。
                补 `!provider.apiKey`：用户一开始打字就撤掉提示。
              */}
              {provider.apiKeyDecryptFailed && !provider.apiKey && (
                <div
                  className={styles['field-msg']}
                  role="alert"
                  style={{ backgroundColor: 'var(--color-error-bg)', color: 'var(--color-error)' }}
                >
                  已保存的凭据无法解密（密钥环可能已变更，或配置来自其他系统），因此这里显示为空。
                  请重新填写——原密文会保留，不会因保存被覆盖。
                </div>
              )}
            </div>

            {supportsApiFormatChoice(provider.type) && (
              <div className={styles['setting-item']}>
                <div className={styles['setting-label']}>
                  <span data-app-ui-label>API 格式</span>
                  <span className={styles['setting-desc']}>
                    responses 接口支持 prompt caching（推荐）；completions 为传统接口
                  </span>
                </div>
                <div className={styles['setting-control']} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Select
                    value={provider.apiFormat ?? PROVIDER_TYPE_DEFAULTS[provider.type]?.apiFormat ?? 'completions'}
                    options={[
                      { value: 'completions', label: 'Completions（中转/传统，最稳）' },
                      { value: 'responses', label: 'Responses（官方 DeepSeek 等，支持缓存）' },
                    ]}
                    onChange={(e) => patchProvider(provider.id, { apiFormat: e.target.value as 'completions' | 'responses' })}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={probingProvider[provider.id]}
                    onClick={() => { void handleProbeApiFormat(provider) }}
                  >
                    {probingProvider[provider.id] ? '探测中…' : '自动探测'}
                  </Button>
                </div>
              </div>
            )}

            {supportsApiFormatChoice(provider.type) && (
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
                    value={provider.thinkingFormat ?? 'auto'}
                    aria-label="思考参数格式"
                    options={[
                      { value: 'auto', label: '自动（按端点与模型推断）' },
                      { value: 'openai', label: 'OpenAI：reasoning_effort' },
                      { value: 'qwen', label: 'Qwen / vLLM：enable_thinking' },
                      { value: 'zai', label: '智谱 z.ai：thinking.type' },
                    ]}
                    onChange={(e) =>
                      patchProvider(provider.id, { thinkingFormat: e.target.value as ThinkingFormat })
                    }
                  />
                </div>
              </div>
            )}

            <div className={styles['setting-item']}>
              <div className={styles['setting-label']}>
                <span data-app-ui-label>可用模型</span>
                <span className={styles['setting-desc']}>
                  勾选或手动填写。对话页的模型下拉会按 Provider 分组列出这些模型
                </span>
              </div>
              <div className={styles['setting-control']} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {models.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflow: 'auto' }}>
                    {models.map((m) => (
                      <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Checkbox
                          checked={allowedIds.includes(m.id)}
                          onChange={(next) => {
                            const nextIds = next
                              ? [...new Set([...allowedIds, m.id])]
                              : allowedIds.filter((id) => id !== m.id)
                            patchProvider(provider.id, { modelIds: nextIds })
                          }}
                        >
                          {m.name || m.id}
                        </Checkbox>
                      </div>
                    ))}
                  </div>
                )}
                <Input
                  type="text"
                  value={modelIdsText[provider.id] ?? allowedIds.join(', ')}
                  placeholder="模型 ID，多个用逗号分隔；可手动输入，勾选后自动填充"
                  onChange={(e) => setModelIdsText((t) => ({ ...t, [provider.id]: e.target.value }))}
                  onBlur={() => commitModelIdsText(provider.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commitModelIdsText(provider.id)
                    }
                  }}
                />
                {models.length === 0 && allowedIds.map((id) => (
                  <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className={styles['setting-desc']}>{id}</span>
                  </div>
                ))}
                {allowedIds.length > 0 && (
                  <span className={styles['setting-desc']}>已配置 {allowedIds.length} 个模型</span>
                )}
              </div>
            </div>

            <div className={styles['category-save-actions']} style={{ gap: 8 }}>
              <Button
                variant="secondary"
                loading={!!listingProvider[provider.id]}
                onClick={() => { void handleListModels(provider) }}
              >
                获取模型列表
              </Button>
              <Button
                variant="secondary"
                loading={!!testingProvider[provider.id]}
                onClick={() => { void handleTestConnection(provider) }}
              >
                测试连接
              </Button>
            </div>
          </>
        )}
      </Card>
    )
  }

  const renderSlotCard = (slot: CapabilitySlot) => {
    if (!store) return null
    const sel = store.slots[slot]
    const provider = store.providers.find((p) => p.id === sel.providerId)
    const providerOptions = store.providers.map((p) => ({
      value: p.id,
      label: `${providerDisplayName(p)}${p.modelIds.length ? `（${p.modelIds.length} 个模型）` : '（未配模型）'}`,
    }))
    const modelOptions = provider?.modelIds ?? []

    return (
      <Card key={slot}>
        <div className={styles['setting-item']}>
          <div className={styles['setting-label']}>
            <span data-app-ui-heading>{CAPABILITY_SLOT_LABEL[slot]}</span>
            <span className={styles['setting-desc']}>{CAPABILITY_SLOT_DESC[slot]}</span>
          </div>
          <div className={styles['setting-control']}>
            <div className={styles['slot-enable-group']} role="group" aria-label={`${CAPABILITY_SLOT_LABEL[slot]}启停`}>
              <button
                type="button"
                className={`${styles['slot-enable-btn']} ${sel.enabled ? styles['slot-enable-btn--on'] : ''}`}
                onClick={() => patchSlot(slot, { enabled: true })}
              >
                已启用
              </button>
              <button
                type="button"
                className={`${styles['slot-enable-btn']} ${!sel.enabled ? styles['slot-enable-btn--off'] : ''}`}
                onClick={() => patchSlot(slot, { enabled: false })}
              >
                未启用
              </button>
            </div>
          </div>
        </div>

        <div className={styles['setting-item']}>
          <div className={styles['setting-label']}>
            <span data-app-ui-label>使用哪个提供商</span>
            <span className={styles['setting-desc']}>
              未选择时该能力不可用；同一提供商可被多个能力共用
            </span>
          </div>
          <div className={styles['setting-control']}>
            <Select
              value={sel.providerId}
              aria-label={`${CAPABILITY_SLOT_LABEL[slot]}提供商`}
              options={[{ value: '', label: '（未选择）' }, ...providerOptions]}
              onChange={(e) => {
                const providerId = e.target.value
                const next = store.providers.find((p) => p.id === providerId)
                patchSlot(slot, {
                  providerId,
                  // 换提供商时旧模型 ID 多半不存在，回退到它列出的第一个
                  modelId: next?.modelIds.includes(sel.modelId) ? sel.modelId : (next?.modelIds[0] ?? ''),
                })
              }}
            />
          </div>
        </div>

        {provider && (
          <div className={styles['setting-item']}>
            <div className={styles['setting-label']}>
              <span data-app-ui-label>
                {slot === 'image' ? '默认生图模型' : '使用哪个模型'}
              </span>
              <span className={styles['setting-desc']}>
                {slot === 'chat'
                  ? '对话页仍可临时切到别的模型；这里是新会话的默认值'
                  : slot === 'image'
                    ? 'Agent 显式指定 modelId 时才会被覆盖'
                    : '图片识别默认使用它'}
              </span>
            </div>
            <div className={styles['setting-control']}>
              {modelOptions.length > 0 ? (
                <Select
                  value={sel.modelId}
                  aria-label={`${CAPABILITY_SLOT_LABEL[slot]}模型`}
                  options={modelOptions.map((id) => ({ value: id, label: id }))}
                  onChange={(e) => patchSlot(slot, { modelId: e.target.value })}
                />
              ) : (
                <Input
                  type="text"
                  value={sel.modelId}
                  placeholder="该提供商还没配置模型，请先在上面填写"
                  onChange={(e) => patchSlot(slot, { modelId: e.target.value })}
                />
              )}
            </div>
            {/* 解密失败的提示只在提供商卡片上说一次，槽卡片不重复刷同一句话 */}
          </div>
        )}

        {/*
          每个模型的附加配置放在**槽**上而不是 provider 上：
          同一个模型交给不同能力时，上下文预算与思考开关可以是不同的。
          生图没有这两个概念，不渲染——挂上只会让人以为它们有用。
        */}
        {provider && slot !== 'image' && modelOptions.length > 0 && (
          <div className={styles['setting-item']}>
            <div className={styles['setting-label']}>
              <span data-app-ui-label>模型参数</span>
              <span className={styles['setting-desc']}>
                上下文长度按模型覆盖（单位 K，缺省用内置表）；勾掉「思考」则不发送任何思考参数
              </span>
            </div>
            <div className={styles['setting-control']} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {modelOptions.map((modelId) => {
                const contextWindowK = sel.contextWindowK ?? {}
                const modelReasoning = sel.modelReasoning ?? {}
                const reasoningOn = modelReasoning[modelId] ?? defaultSupportsReasoning(modelId)
                const setContextWindowK = (value: string) => {
                  const next = { ...contextWindowK }
                  const n = Number(value)
                  if (value.trim() === '') delete next[modelId]
                  else if (Number.isFinite(n) && n > 0) next[modelId] = n
                  patchSlot(slot, { contextWindowK: next })
                }
                const setReasoning = (next: boolean) => {
                  patchSlot(slot, {
                    modelReasoning: { ...modelReasoning, [modelId]: next },
                  })
                }
                return (
                  <div key={modelId} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span className={styles['setting-desc']} style={{ minWidth: 160 }}>{modelId}</span>
                    <Input
                      type="number"
                      min={1}
                      step={1}
                      value={String(contextWindowK[modelId] ?? defaultContextWindowK(modelId))}
                      onChange={(e) => setContextWindowK(e.target.value)}
                      style={{ width: 90 }}
                      aria-label={`${modelId} 上下文长度（K）`}
                    />
                    <span className={styles['setting-desc']}>K</span>
                    <Checkbox
                      checked={reasoningOn}
                      aria-label={`${modelId} 支持思考`}
                      onChange={setReasoning}
                    >
                      <span
                        className={styles['setting-desc']}
                        title="该模型是否支持思考（reasoning）。不勾选时不会发送任何思考参数。"
                      >
                        思考
                      </span>
                    </Checkbox>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </Card>
    )
  }

  if (loading || !store) {
    return (
      <div className={styles['settings-section']}>
        <Loading text="加载中..." />
      </div>
    )
  }

  return (
    <div className={styles['settings-section']}>
      <h3 data-app-ui-section-title>模型提供商</h3>
      <p className={styles['setting-desc']} style={{ marginBottom: 16 }}>
        在这里配置多个提供商（如 DeepSeek、OpenRouter、OpenAI）。同一家的 Key 只需填一次，
        文本对话、视觉理解、图片生成三个能力分别选用其中一个提供商与模型。
        语音 ASR/TTS 请在下方「语音设置」中配置。
      </p>

      {store.providers.map((p) => (
        <div key={p.id} style={{ marginBottom: 12 }}>
          {renderProviderCard(p)}
        </div>
      ))}
      <div style={{ marginBottom: 24 }}>
        <Button variant="secondary" onClick={addProvider}>
          <Plus size={14} /> 添加提供商
        </Button>
      </div>

      <h3 data-app-ui-section-title>能力使用哪个提供商</h3>
      <p className={styles['setting-desc']} style={{ marginBottom: 16 }}>
        「已启用 / 未启用」控制该能力是否真正生效：未启用时即使配置了也不会调用，便于临时关闭而不丢配置。
        测试连接成功时会自动设为已启用。
      </p>
      {CAPABILITY_SLOTS.map((slot) => (
        <div key={slot} style={{ marginBottom: 12 }}>
          {renderSlotCard(slot)}
        </div>
      ))}

      <div className={styles['category-save-actions']}>
        <Button onClick={() => { void handleSave() }} loading={saving}>
          保存全部
        </Button>
      </div>
    </div>
  )
}

/** 用某个 provider 的字段拼出「测试/拉模型」所需的草稿配置 */
function slotDraftForTest(
  store: ProviderStoreView | null,
  provider: ProviderEntryView,
): LocalProviderConfigView {
  const fallback = (store && resolveSlotFromStore(store, 'chat')) || null
  return {
    enabled: true,
    type: provider.type,
    baseUrl: provider.baseUrl,
    modelId: provider.modelIds[0] ?? '',
    apiKey: provider.apiKey,
    allowedModelIds: provider.modelIds,
    apiFormat: provider.apiFormat,
    apiFormatByModel: provider.apiFormatByModel,
    thinkingFormat: provider.thinkingFormat,
    contextWindowK: fallback?.contextWindowK ?? {},
    modelReasoning: fallback?.modelReasoning ?? {},
  }
}
