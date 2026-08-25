/**
 * MemoriesPage - 记忆管理页面
 *
 * Tab 结构：
 * - AI灵魂：定义 AI 助手的性格与风格，支持模板一键切换和手动编辑
 * - AI记忆：AI 从对话中自动提取的动态信息
 * - 记忆插件：MemPalace 向量记忆系统
 */

import React, { useState, useCallback, useEffect, useRef } from 'react'
import MDEditor from '@uiw/react-md-editor'
import { Brain, Check, RotateCcw, HelpCircle } from 'lucide-react'
import { Button } from '../../components/ui/Button/Button'
import { Loading } from '../../components/ui/Loading/Loading'
import { ErrorBanner } from '../../components/ui/ErrorBanner/ErrorBanner'
import { PageHeader } from '../../components/ui/PageHeader/PageHeader'
import { Tooltip } from '../../components/ui/Tooltip/Tooltip'
import { MemoryViewer } from '../SettingsPage/components/MemoryViewer/MemoryViewer'
import { useMemPalace } from '../../hooks/business/useMemPalace/useMemPalace'
import { usePluginsContext } from '../../contexts/PluginsContext/PluginsContext'
import type { ViewType } from '../../components/Router'
import { useSoul } from '../../hooks/business/useSoul/useSoul'
import { useUserMemory } from '../../hooks/business/useUserMemory'
import {
  useSettings,
  SETTINGS_STORAGE_KEY,
  SETTINGS_UPDATE_EVENT,
} from '../../hooks/business/useSettings'
import { Checkbox } from '../../components/ui/Checkbox/Checkbox'
import { SOUL_TEMPLATES } from './soul-templates'
import { DEFAULT_SOUL_CONTENT } from '../../../../../../packages/agent-runtime/src/prompt/default-soul'
import { MemPalaceViewer } from './MemPalaceViewer'
import './MemoriesPage.css'

type MemoryTab = 'soul' | 'ai' | 'user-memory' | 'plugin'

interface MemoriesPageProps {
  onViewChange?: (view: ViewType) => void
  /** Hub 嵌入时隐藏 PageHeader 标题区 */
  embedded?: boolean
}

export const MemoriesPage: React.FC<MemoriesPageProps> = ({ onViewChange, embedded = false }) => {
  const [activeTab, setActiveTab] = useState<MemoryTab>('soul')
  const [isEditMode, setIsEditMode] = useState(false)
  const [content, setContent] = useState('')
  const [showDraftRestore, setShowDraftRestore] = useState(false)
  const autoSaveIntervalRef = useRef<NodeJS.Timeout | null>(null)

  const {
    soul,
    isLoading,
    isSaving,
    error,
    fetchSoul,
    updateSoul,
    clearError,
    saveDraft,
    clearDraft,
    hasDraft,
    getDraft,
  } = useSoul()

  // MemPalace 记忆数据管理（列表/搜索/删除）。安装状态改用共享 PluginsContext。
  const mempalace = useMemPalace()
  // 安装状态统一来自插件中心同源的 PluginsContext，保证两处状态一致。
  const { statuses } = usePluginsContext()
  const mempalaceInstalled = statuses['mempalace'].installed
  const mempalaceChecking = statuses['mempalace'].installing || statuses['mempalace'].uninstalling

  const {
    memory: userMemoryData,
    isLoading: userMemoryLoading,
    isSaving: userMemorySaving,
    error: userMemoryError,
    fetchMemory: fetchUserMemory,
    updateMemory: updateUserMemory,
  } = useUserMemory()

  const { settings, updateMemory } = useSettings()

  const handleMemoryInjectionChange = useCallback(
    (key: 'injectPersonalMemory' | 'injectWorkMemory', checked: boolean) => {
      const nextSettings = {
        ...settings,
        memory: {
          ...settings.memory,
          injectPersonalMemory: settings.memory?.injectPersonalMemory !== false,
          injectWorkMemory: settings.memory?.injectWorkMemory !== false,
          [key]: checked,
        },
      }
      updateMemory({ [key]: checked })
      try {
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(nextSettings))
        window.dispatchEvent(new CustomEvent(SETTINGS_UPDATE_EVENT, { detail: nextSettings }))
        void window.electronAPI?.settings?.updateMemoryInjection?.({
          injectPersonalMemory: nextSettings.memory.injectPersonalMemory,
          injectWorkMemory: nextSettings.memory.injectWorkMemory,
        })
      } catch {
        // 忽略本地存储写入失败
      }
    },
    [settings, updateMemory],
  )

  const [userMemoryClearOnce, setUserMemoryClearOnce] = useState(false)
  const [userMemoryEditing, setUserMemoryEditing] = useState(false)
  const [userMemoryDraft, setUserMemoryDraft] = useState('')

  useEffect(() => {
    if (activeTab === 'user-memory') {
      void fetchUserMemory()
    }
  }, [activeTab, fetchUserMemory])

  const handleClearUserMemory = useCallback(async () => {
    if (!userMemoryClearOnce) {
      setUserMemoryClearOnce(true)
      return
    }
    setUserMemoryClearOnce(false)
    await updateUserMemory('')
  }, [userMemoryClearOnce, updateUserMemory])

  useEffect(() => {
    fetchSoul()
  }, [fetchSoul])

  useEffect(() => {
    if (soul !== null) {
      setContent(soul.content)

      if (hasDraft()) {
        const draft = getDraft()
        if (draft) {
          const draftTime = new Date(draft.savedAt).getTime()
          const serverTime = new Date(soul.updatedAt).getTime()
          if (draftTime > serverTime && draft.content !== soul.content) {
            setShowDraftRestore(true)
          }
        }
      }
    }
  }, [soul, hasDraft, getDraft])

  useEffect(() => {
    if (isEditMode && content) {
      saveDraft(content)
      autoSaveIntervalRef.current = setInterval(() => { saveDraft(content) }, 30000)
    }
    return () => {
      if (autoSaveIntervalRef.current) clearInterval(autoSaveIntervalRef.current)
    }
  }, [isEditMode, content, saveDraft])

  const handleToggleEdit = useCallback(() => {
    if (isEditMode && soul !== null) setContent(soul.content)
    if (isEditMode) setShowDraftRestore(false)
    setIsEditMode(!isEditMode)
  }, [isEditMode, soul])

  const handleSave = useCallback(async () => {
    if (isSaving) return
    const success = await updateSoul(content)
    if (success) {
      setIsEditMode(false)
      setShowDraftRestore(false)
    }
  }, [content, isSaving, updateSoul])

  const handleRestoreDraft = useCallback(() => {
    const draft = getDraft()
    if (draft) setContent(draft.content)
    setShowDraftRestore(false)
  }, [getDraft])

  const handleDiscardDraft = useCallback(() => {
    clearDraft()
    setShowDraftRestore(false)
  }, [clearDraft])

  const handleApplyTemplate = useCallback((templateContent: string) => {
    setContent(templateContent)
    setIsEditMode(true)
  }, [])

  const handleResetSoul = useCallback(() => {
    setContent(DEFAULT_SOUL_CONTENT)
    setIsEditMode(true)
  }, [])

  const startUserMemoryEdit = useCallback(() => {
    setUserMemoryDraft(userMemoryData?.content ?? '')
    setUserMemoryEditing(true)
  }, [userMemoryData])

  const cancelUserMemoryEdit = useCallback(() => {
    setUserMemoryEditing(false)
    setUserMemoryDraft('')
  }, [])

  const handleSaveUserMemory = useCallback(async () => {
    const ok = await updateUserMemory(userMemoryDraft)
    if (ok) {
      setUserMemoryEditing(false)
      setUserMemoryDraft('')
    }
  }, [userMemoryDraft, updateUserMemory])

  const activeTemplateId = SOUL_TEMPLATES.find(t => t.content.trim() === content.trim())?.id

  return (
    <div className={`page-container memories-page${embedded ? ' memories-page--embedded' : ''}`}>
      {!embedded ? (
      <PageHeader
        title="记忆管理"
        subtitle={activeTab === 'soul' ? '定义 AI 助手的性格、风格与行为方式' : '管理 AI 助手的长期记忆，让 AI 更了解您'}
        actions={
          activeTab === 'soul' ? (
            <div className="header-actions">
              {isEditMode && (
                <Button variant="primary" onClick={handleSave} disabled={isSaving}>
                  {isSaving ? '保存中...' : '保存'}
                </Button>
              )}
              <Button variant="ghost" onClick={handleResetSoul} title="重置为默认模板">
                <RotateCcw size={16} style={{ marginRight: 4 }} />
                重置
              </Button>
              <Button variant={isEditMode ? 'secondary' : 'ghost'} onClick={handleToggleEdit}>
                {isEditMode ? '取消' : '编辑'}
              </Button>
            </div>
          ) : null
        }
      />
      ) : activeTab === 'soul' ? (
        <div className="header-actions memories-embedded-actions">
          {isEditMode && (
            <Button variant="primary" onClick={handleSave} disabled={isSaving}>
              {isSaving ? '保存中...' : '保存'}
            </Button>
          )}
          <Button variant="ghost" onClick={handleResetSoul} title="重置为默认模板">
            <RotateCcw size={16} style={{ marginRight: 4 }} />
            重置
          </Button>
          <Button variant={isEditMode ? 'secondary' : 'ghost'} onClick={handleToggleEdit}>
            {isEditMode ? '取消' : '编辑'}
          </Button>
        </div>
      ) : null}

      {/* Tab 导航 */}
      <div className="memories-tabs">
        <Tooltip content="定义 AI 助手的性格与风格，支持模板一键切换" placement="bottom">
          <button type="button" className={`memories-tab ${activeTab === 'soul' ? 'memories-tab--active' : ''}`} onClick={() => setActiveTab('soul')}>
            AI 灵魂
          </button>
        </Tooltip>
        <Tooltip content="当前进行中的任务、项目、资源引用。按 Agent 隔离，随任务结束归档，仅存本地" placement="bottom">
          <button type="button" className={`memories-tab ${activeTab === 'ai' ? 'memories-tab--active' : ''}`} onClick={() => setActiveTab('ai')}>
            工作记忆
          </button>
        </Tooltip>
        <Tooltip content="你的身份、偏好等跨会话稳定信息。全局生效，不区分 Agent，需手动管理" placement="bottom">
          <button type="button" className={`memories-tab ${activeTab === 'user-memory' ? 'memories-tab--active' : ''}`} onClick={() => setActiveTab('user-memory')}>
            个人记忆
          </button>
        </Tooltip>
        <Tooltip content="基于向量数据库的语义长期记忆，自动召回相关历史对话" placement="bottom">
          <button type="button" className={`memories-tab ${activeTab === 'plugin' ? 'memories-tab--active' : ''}`} onClick={() => setActiveTab('plugin')}>
            记忆插件
          </button>
        </Tooltip>
      </div>

      {/* 记忆注入开关 */}
      <div className="memory-injection-settings">
        <div className="memory-injection-header">
          <h3 className="memory-injection-title">记忆注入</h3>
          <Tooltip content="控制是否将记忆预注入系统提示词。关闭后 AI 不会自动看到相应记忆，但仍可通过工具按需搜索读取。" placement="bottom">
            <HelpCircle size={16} className="memory-injection-help-icon" />
          </Tooltip>
        </div>
        <div className="memory-injection-options">
          <Tooltip content="你是谁、你的偏好 — 跨会话稳定，全局生效" placement="bottom">
            <label className="memory-injection-option" htmlFor="memory-inject-personal">
              <Checkbox
                id="memory-inject-personal"
                checked={settings.memory?.injectPersonalMemory !== false}
                onChange={(checked) => void handleMemoryInjectionChange('injectPersonalMemory', checked)}
              />
              <span>注入个人记忆</span>
            </label>
          </Tooltip>
          <Tooltip content="当前在做什么、用什么资源 — 按 Agent 隔离，会随任务结束归档" placement="bottom">
            <label className="memory-injection-option" htmlFor="memory-inject-work">
              <Checkbox
                id="memory-inject-work"
                checked={settings.memory?.injectWorkMemory !== false}
                onChange={(checked) => void handleMemoryInjectionChange('injectWorkMemory', checked)}
              />
              <span>注入工作记忆</span>
            </label>
          </Tooltip>
        </div>
      </div>

      {/* AI 灵魂 Tab */}
      {activeTab === 'soul' && (
        <>
          {/* 模板选择条 */}
          <div className="soul-templates">
            {SOUL_TEMPLATES.map(tpl => {
              const Icon = tpl.icon
              return (
                <button
                  key={tpl.id}
                  type="button"
                  className={`soul-template-card ${activeTemplateId === tpl.id ? 'soul-template-card--active' : ''}`}
                  onClick={() => handleApplyTemplate(tpl.content)}
                  title={tpl.desc}
                >
                  <span className="soul-template-icon"><Icon size={20} /></span>
                  <span className="soul-template-name">{tpl.name}</span>
                  <span className="soul-template-desc">{tpl.desc}</span>
                </button>
              )
            })}
          </div>

          {error && (
            <ErrorBanner message={error.message} onRetry={() => { clearError(); fetchSoul() }} />
          )}

          {isLoading && !soul ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flex: 1 }}>
              <Loading text="加载 AI 灵魂中..." />
            </div>
          ) : (
            <>
              {showDraftRestore && (
                <div className="draft-restore-banner">
                  <div className="draft-message"><span>发现有未保存的草稿，是否恢复？</span></div>
                  <div className="draft-actions">
                    <Button variant="ghost" size="sm" onClick={handleRestoreDraft}>恢复</Button>
                    <Button variant="ghost" size="sm" onClick={handleDiscardDraft}>丢弃</Button>
                  </div>
                </div>
              )}

              <div className="memories-editor-container">
                <div className="editor-wrapper">
                  <MDEditor
                    value={content}
                    onChange={(val: string | undefined) => setContent(val ?? '')}
                    preview={isEditMode ? 'live' : 'preview'}
                    height="100%"
                    visibleDragbar={false}
                    hideToolbar={!isEditMode}
                    enableScroll={true}
                  />
                </div>
              </div>

              <div className="memories-footer">
                <div className="last-update">
                  {soul?.updatedAt && (
                    <span>最后更新: {new Date(soul.updatedAt).toLocaleString('zh-CN')}</span>
                  )}
                </div>
              </div>
            </>
          )}
        </>
      )}

      {/* 工作记忆 Tab */}
      {activeTab === 'ai' && (
        <div className="memories-ai-panel">
          <MemoryViewer />
        </div>
      )}

      {/* 个人记忆 Tab */}
      {activeTab === 'user-memory' && (
        <div className="memories-ai-panel">
          {userMemoryError && (
            <ErrorBanner message={userMemoryError.message} onRetry={fetchUserMemory} />
          )}
          {userMemoryLoading ? (
            <Loading text="加载个人记忆..." />
          ) : userMemoryEditing ? (
            <>
              <MDEditor
                value={userMemoryDraft}
                onChange={(val: string | undefined) => setUserMemoryDraft(val ?? '')}
                preview="edit"
                height={360}
                visibleDragbar={false}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <Button variant="primary" onClick={() => void handleSaveUserMemory()} disabled={userMemorySaving}>
                  {userMemorySaving ? '保存中...' : '保存'}
                </Button>
                <Button variant="secondary" onClick={cancelUserMemoryEdit} disabled={userMemorySaving}>
                  取消
                </Button>
              </div>
            </>
          ) : (
            <>
              {userMemoryData?.content ? (
                <pre className="user-memory-preview">{userMemoryData.content}</pre>
              ) : (
                <p className="memories-ai-intro" style={{ color: 'var(--color-text-tertiary)' }}>
                  暂无个人记忆。AI 会在对话中自动提取并保存关于你的信息。
                </p>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <Button variant="secondary" onClick={startUserMemoryEdit}>
                  编辑
                </Button>
                <Button
                  variant={userMemoryClearOnce ? 'danger' : 'secondary'}
                  onClick={() => void handleClearUserMemory()}
                  disabled={userMemorySaving || !userMemoryData?.content}
                >
                  {userMemorySaving ? '清空中...' : userMemoryClearOnce ? '确认清空个人记忆' : '清空个人记忆'}
                </Button>
                {userMemoryClearOnce && (
                  <Button variant="secondary" onClick={() => setUserMemoryClearOnce(false)}>
                    取消
                  </Button>
                )}
              </div>
              {userMemoryData?.updatedAt && (
                <p style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 8 }}>
                  最后更新: {new Date(userMemoryData.updatedAt).toLocaleString('zh-CN')}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {/* 记忆插件 Tab */}
      {activeTab === 'plugin' && (
        <div className="memories-plugin-panel">
          <div className="plugin-card">
            <div className="plugin-card-header">
              <div className="plugin-card-icon"><Brain size={28} /></div>
              <div className="plugin-card-info">
                <h3 className="plugin-card-name">MemPalace 长期记忆</h3>
                <p className="plugin-card-desc">
                  基于向量数据库的语义记忆系统，自动召回相关历史对话，让 AI 真正记住你。
                </p>
              </div>
              <div className="plugin-card-status">
                {mempalaceChecking ? (
                  <span className="plugin-status plugin-status--loading">处理中...</span>
                ) : mempalaceInstalled ? (
                  <span className="plugin-status plugin-status--installed"><Check size={14} style={{ verticalAlign: 'middle', marginRight: 2 }} />已安装</span>
                ) : (
                  <span className="plugin-status plugin-status--not-installed">未安装</span>
                )}
              </div>
            </div>

            {!mempalaceInstalled && (
              <div className="plugin-card-body">
                <p className="plugin-install-note">
                  长期记忆插件的安装与卸载已统一到「插件中心」管理。安装完成后重启应用即可在此查看与管理记忆数据。
                </p>
                <Button
                  variant="primary"
                  onClick={() => onViewChange?.('plugins')}
                  disabled={!onViewChange}
                >
                  前往插件中心安装
                </Button>
              </div>
            )}

            {mempalaceInstalled && mempalace.status?.runtimeDir && (
              <div className="plugin-card-body">
                <p className="plugin-data-dir">
                  数据目录：<code>{mempalace.status.runtimeDir}</code>
                </p>
                <p className="plugin-install-note" style={{ marginTop: 8 }}>
                  如需卸载，请前往「插件中心」操作。
                </p>
              </div>
            )}
          </div>

          {mempalaceInstalled && <MemPalaceViewer />}
        </div>
      )}
    </div>
  )
}

export default MemoriesPage
