import React, { useState, useCallback, useEffect, useRef } from 'react'
import { Package, ShoppingBag, Wrench, Radio, Loader2, FolderOpen, Download, Circle, ChevronDown, ChevronRight } from 'lucide-react'
import clsx from 'clsx'
import { Card } from '../../components/ui/Card/Card'
import { Button } from '../../components/ui/Button/Button'
import { Input } from '../../components/ui/Input/Input'
import { Loading } from '../../components/ui/Loading/Loading'
import { Empty } from '../../components/ui/Empty/Empty'
import { Modal } from '../../components/ui/Modal/Modal'
import { PageHeader } from '../../components/ui/PageHeader/PageHeader'
import { ErrorBanner } from '../../components/ui/ErrorBanner/ErrorBanner'
import { Select } from '../../components/ui/Select/Select'
import { SkillStoreView } from '../../components/business/SkillStoreView'
import { ToolCard } from './components/ToolCard'
import { MySkillDetailModal } from './components/MySkillDetailModal'
import { SkillRow } from './components/SkillRow'
import { useSkills } from '../../hooks/business/useSkills'
import { useToolSearch } from '../../hooks/business/useToolSearch'
import { CATEGORY_LABELS, CATEGORY_ORDER } from './SkillsPage.const'
import type { MySkillDetailInfo, TabType, FilterStatus, SkillsPageProps } from './SkillsPage.types'
import styles from './SkillsPage.module.css'

/**
 * SkillsPage - 技能管理页面
 *
 * 基于 SkillsView.tsx 重构
 * 显示已安装技能
 * 支持启用/禁用/卸载技能
 * 包含技能商店入口
 */
const SkillsPage: React.FC<SkillsPageProps> = ({
  embedded = false,
  initialTab,
  hideMcpTab = false,
  mcpOnly = false,
}) => {
  const { installedSkills, stats: skillStats, isLoading, error, loadInstalledSkills, enableSkill, disableSkill, uninstallSkill } = useSkills()
  const { filtered: filteredTools, grouped: groupedTools, stats: toolStats, query: toolQuery, setQuery: setToolQuery, isLoading: isToolsLoading, togglingTool, toggleTool, mcpStatus } = useToolSearch()

  // 标签页状态（Composer「管理」可经 sessionStorage 指定初始 Tab）
  const [activeTab, setActiveTab] = useState<TabType>(() => {
    if (initialTab) return initialTab
    try {
      const init = sessionStorage.getItem('mtbot_skills_init_tab') as TabType | null
      if (init === 'my-skills' || init === 'store' || init === 'tools' || init === 'mcp') {
        sessionStorage.removeItem('mtbot_skills_init_tab')
        return init
      }
    } catch {
      /* ignore */
    }
    return mcpOnly ? 'mcp' : 'my-skills'
  })

  useEffect(() => {
    if (initialTab) setActiveTab(initialTab)
    else if (mcpOnly) setActiveTab('mcp')
  }, [initialTab, mcpOnly])

  // 搜索和筛选状态
  const [searchQuery, setSearchQuery] = useState('')
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all')

  // 操作状态
  const [operatingSkillId, setOperatingSkillId] = useState<string | null>(null)
  const [resultMessage, setResultMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)

  // 卸载确认对话框
  const [showUninstallModal, setShowUninstallModal] = useState(false)
  const [skillToUninstall, setSkillToUninstall] = useState<string | null>(null)

  // 技能详情弹窗
  const [detailSkillInfo, setDetailSkillInfo] = useState<MySkillDetailInfo | null>(null)

  // 本地技能导入 - 拖放状态
  const [isDragOver, setIsDragOver] = useState(false)
  const [isInstalling, setIsInstalling] = useState(false)

  // 使用 hook 返回的 stats
  const stats = skillStats

  /**
   * 过滤技能列表
   */
  const filteredSkills = installedSkills.filter(skillInfo => {
    const skill = skillInfo.skill
    // 搜索过滤
    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      const matchName = skill.name.toLowerCase().includes(query)
      const matchDesc = (skill.description ?? '').toLowerCase().includes(query)
      if (!matchName && !matchDesc) return false
    }
    
    // 状态过滤
    if (filterStatus === 'enabled' && !skillInfo.isEnabled) return false
    if (filterStatus === 'disabled' && skillInfo.isEnabled) return false
    
    return true
  })

  /**
   * 按分类分组（无分类归入"其他"）
   * 分类内按启用状态排序：启用在前
   */
  const groupedByCategory = React.useMemo(() => {
    const map = new Map<string, typeof filteredSkills>()
    for (const s of filteredSkills) {
      const key = s.category || ''
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(s)
    }
    // 分类内：启用在前
    for (const [, list] of map) {
      list.sort((a, b) => (b.isEnabled ? 1 : 0) - (a.isEnabled ? 1 : 0))
    }
    // 排序：有名称的分类按字母，无分类（''）放最后
    return [...map.entries()].sort(([a], [b]) => {
      if (a === '' && b !== '') return 1
      if (a !== '' && b === '') return -1
      return a.localeCompare(b, 'zh')
    })
  }, [filteredSkills])

  /**
   * 手动刷新：重新扫描本地技能目录并上报到 Gateway，然后刷新列表
   */
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true)
    try {
      const result = await window.electronAPI.skills.refresh() as { success: boolean; count: number }
      await loadInstalledSkills()
      setResultMessage({ type: 'success', text: `已刷新，检测到 ${result.count} 个技能` })
    } catch (err) {
      setResultMessage({ type: 'error', text: err instanceof Error ? err.message : '刷新失败' })
    } finally {
      setIsRefreshing(false)
      setTimeout(() => setResultMessage(null), 3000)
    }
  }, [loadInstalledSkills])

  /**
   * 处理技能启用/禁用切换
   */
  const handleToggleSkill = useCallback(async (skillItemId: string) => {
    const skillInfo = installedSkills.find(s => s.skillItemId === skillItemId)
    if (!skillInfo) return

    setOperatingSkillId(skillItemId)
    try {
      if (skillInfo.isEnabled) {
        await disableSkill(skillItemId)
        setResultMessage({ type: 'success', text: '技能已禁用' })
      } else {
        await enableSkill(skillItemId)
        setResultMessage({ type: 'success', text: '技能已启用' })
      }
      // 状态变更后触发上报（fire-and-forget，不阻塞 UI）
      window.electronAPI.skills.refresh().catch(() => {})
    } catch (err) {
      setResultMessage({
        type: 'error',
        text: err instanceof Error ? err.message : '操作失败'
      })
    } finally {
      setOperatingSkillId(null)
      setTimeout(() => setResultMessage(null), 3000)
    }
  }, [installedSkills, enableSkill, disableSkill])

  /**
   * 处理技能卸载
   */
  const handleUninstall = useCallback(async () => {
    if (!skillToUninstall) return

    setOperatingSkillId(skillToUninstall)
    try {
      await uninstallSkill(skillToUninstall)
      setResultMessage({ type: 'success', text: '技能已卸载' })
      if (detailSkillInfo?.skillItemId === skillToUninstall) {
        setDetailSkillInfo(null)
      }
      // 卸载后触发上报
      window.electronAPI.skills.refresh().catch(() => {})
    } catch (err) {
      setResultMessage({
        type: 'error',
        text: err instanceof Error ? err.message : '卸载失败'
      })
    } finally {
      setOperatingSkillId(null)
      setShowUninstallModal(false)
      setSkillToUninstall(null)
      setTimeout(() => setResultMessage(null), 3000)
    }
  }, [skillToUninstall, uninstallSkill, detailSkillInfo])

  /**
   * 打开技能所在目录
   */
  const handleOpenDir = useCallback(async (skillItemId: string) => {
    try {
      const dirPath = await window.electronAPI.skills.getSkillDir(skillItemId)
      await window.electronAPI.app.showItemInFolder(dirPath)
    } catch (err) {
      setResultMessage({ type: 'error', text: err instanceof Error ? err.message : '打开目录失败' })
      setTimeout(() => setResultMessage(null), 3000)
    }
  }, [])

  /**
   * 打开卸载确认对话框
   */
  const openUninstallModal = useCallback((skillId: string) => {
    setSkillToUninstall(skillId)
    setShowUninstallModal(true)
  }, [])

  /**
   * 从本地目录安装技能（拖放或点击选择）
   */
  const handleInstallFromDirectory = useCallback(async (sourcePath: string) => {
    setIsInstalling(true)
    try {
      await window.electronAPI.skills.importDirectory(sourcePath)
      await loadInstalledSkills()
      setResultMessage({ type: 'success', text: `技能 ${sourcePath.split(/[\\/]/).pop()} 导入成功` })
    } catch (err) {
      setResultMessage({ type: 'error', text: err instanceof Error ? err.message : '导入失败' })
    } finally {
      setIsInstalling(false)
      setTimeout(() => setResultMessage(null), 4000)
    }
  }, [loadInstalledSkills])

  /**
   * 点击 Drop Zone：打开系统目录选择对话框
   */
  const handleDropZoneClick = useCallback(async () => {
    try {
      const result = await window.electronAPI.dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: '选择技能目录',
        buttonLabel: '导入技能',
      })
      if (!result.canceled && result.filePaths.length > 0) {
        await handleInstallFromDirectory(result.filePaths[0])
      }
    } catch (err) {
      setResultMessage({ type: 'error', text: err instanceof Error ? err.message : '无法打开目录选择器' })
      setTimeout(() => setResultMessage(null), 3000)
    }
  }, [handleInstallFromDirectory])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    const items = Array.from(e.dataTransfer.items).filter(item => item.kind === 'file')
    if (items.length === 0) return

    const firstItem = items[0]

    // 检测 ZIP 文件
    if (firstItem.type === 'application/zip' || firstItem.type === 'application/x-zip-compressed') {
      setResultMessage({ type: 'error', text: '请先解压后再拖入技能目录' })
      setTimeout(() => setResultMessage(null), 3000)
      return
    }

    const file = firstItem.getAsFile()
    if (!file) return

    // 用 Electron webUtils.getPathForFile 获取真实本地路径
    const filePath = window.electronAPI.app.getPathForFile(file)
    if (!filePath) {
      setResultMessage({ type: 'error', text: '无法获取路径，请尝试点击选择目录' })
      setTimeout(() => setResultMessage(null), 3000)
      return
    }

    await handleInstallFromDirectory(filePath)
  }, [handleInstallFromDirectory])

  // 折叠状态：存储已折叠的分类 key
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set())

  const toggleCategoryCollapse = useCallback((key: string) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  // 分类导航点击：滚动到对应分类
  const categoryRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const scrollToCategory = useCallback((key: string) => {
    const el = categoryRefs.current.get(key)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    // 如果该分类已折叠，展开它
    setCollapsedCategories(prev => {
      if (!prev.has(key)) return prev
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }, [])

  // 监听来自 AgentsPage 的「去商店下载」事件：切换到商店 tab 并预填搜索词
  useEffect(() => {
    const handler = (e: Event) => {
      const query = (e as CustomEvent<{ query?: string }>).detail?.query ?? ''
      setActiveTab('store')
      if (query) {
        // SkillStoreView 通过挂载时 loadStoreSkills() 初始化，
        // 这里借 sessionStorage 传递初始搜索词，SkillStoreView 挂载后读取。
        sessionStorage.setItem('mtbot_skill_store_init_query', query)
      }
    }
    window.addEventListener('mtbot:open-skill-store', handler)
    return () => window.removeEventListener('mtbot:open-skill-store', handler)
  }, [])

  // 监听 Composer「+」菜单「管理技能 / 管理 MCP」：打开对应 Tab
  useEffect(() => {
    const handler = (e: Event) => {
      const tab = (e as CustomEvent<{ tab?: TabType }>).detail?.tab
      if (tab === 'my-skills' || tab === 'store' || tab === 'tools' || tab === 'mcp') {
        setActiveTab(tab)
      }
    }
    window.addEventListener('mtbot:open-skills-tab', handler)
    return () => window.removeEventListener('mtbot:open-skills-tab', handler)
  }, [])

  // 独立版：技能全部走本地 IPC（workspace/skills），无需网关连接
  const isConnected = true

  return (
    <div className={clsx(styles['skills-page'], embedded && styles['skills-page--embedded'])}>
      {/* 标签页导航：我的技能 → 技能商店 → 工具 → MCP工具 */}
      {!mcpOnly && (
      <div className={styles['skills-tabs']}>
        <button
          className={clsx(styles['skills-tab'], activeTab === 'my-skills' && styles['active'])}
          onClick={() => setActiveTab('my-skills')}
        >
          <span className={styles['tab-icon']}><Package size={14} /></span>
          <span className={styles['tab-label']}>我的技能</span>
          <span className={styles['tab-badge']}>{stats.total}</span>
        </button>
        <button
          className={clsx(styles['skills-tab'], activeTab === 'store' && styles['active'])}
          onClick={() => setActiveTab('store')}
        >
          <span className={styles['tab-icon']}><ShoppingBag size={14} /></span>
          <span className={styles['tab-label']}>技能商店</span>
        </button>
        <button
          className={clsx(styles['skills-tab'], activeTab === 'tools' && styles['active'])}
          onClick={() => setActiveTab('tools')}
        >
          <span className={styles['tab-icon']}><Wrench size={14} /></span>
          <span className={styles['tab-label']}>工具</span>
          <span className={styles['tab-badge']}>{toolStats.total - (groupedTools.get('channel')?.length ?? 0)}</span>
        </button>
        {!hideMcpTab && (
        <button
          className={clsx(styles['skills-tab'], activeTab === 'mcp' && styles['active'])}
          onClick={() => setActiveTab('mcp')}
        >
          <span className={styles['tab-icon']}><Radio size={14} /></span>
          <span className={styles['tab-label']}>MCP 工具</span>
          {/* 修复: 只统计有对应 MCP Server 的 channel 工具,避免与页面内容不一致 */}
          {(() => {
            const channelTools = groupedTools.get('channel') ?? []
            const mcpToolCount = channelTools.filter(tool => 
              mcpStatus.some(server => tool.name.startsWith(`mcp__${server.name}__`))
            ).length
            return mcpToolCount > 0 ? (
              <span className={styles['tab-badge']}>{mcpToolCount}</span>
            ) : null
          })()}
        </button>
        )}
      </div>
      )}

      {/* 我的技能标签页 */}
      {activeTab === 'my-skills' && (
        <>
          {/* 工具栏 */}
          <div className={styles['skills-toolbar']}>
            <div className={styles['skills-stats']}>
              <span className={styles['stat-item']}>
                <strong>{stats.total}</strong> 总数
              </span>
              <span className={clsx(styles['stat-item'], styles['enabled'])}>
                <strong>{stats.enabled}</strong> 已启用
              </span>
              <span className={clsx(styles['stat-item'], styles['disabled'])}>
                <strong>{stats.disabled}</strong> 已禁用
              </span>
            </div>
            <div className={styles['skills-filters']}>
              <Input
                placeholder="搜索技能..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className={styles['skills-search']}
              />
              <Select
                options={[
                  { value: 'all', label: '全部状态' },
                  { value: 'enabled', label: '已启用' },
                  { value: 'disabled', label: '已禁用' },
                ]}
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value as FilterStatus)}
                className={styles['status-filter']}
              />
              <Button onClick={handleRefresh} loading={isRefreshing || isLoading}>
                刷新
              </Button>
            </div>
          </div>

          {/* 结果提示 */}
          {resultMessage && (
            <div className={clsx(styles['skills-result-banner'], styles[resultMessage.type])}>
              {resultMessage.text}
              <button onClick={() => setResultMessage(null)}>✕</button>
            </div>
          )}

          {/* 错误提示 */}
          {error && (
            <ErrorBanner
              message={error.message}
              onRetry={() => loadInstalledSkills()}
            />
          )}

          {/* 本地技能导入 Drop Zone */}
          <div
            className={clsx(
              styles['drop-zone'],
              isDragOver && styles['drop-zone--active'],
              isInstalling && styles['drop-zone--installing'],
            )}
            onClick={isInstalling ? undefined : handleDropZoneClick}
            onDragOver={handleDragOver}
            onDragEnter={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && !isInstalling && handleDropZoneClick()}
            aria-label="从本地导入技能，点击选择目录或拖入目录"
          >
            {isInstalling ? (
              <>
                <span className={styles['drop-zone-icon']}><Loader2 size={24} className="animate-spin" /></span>
                <span className={styles['drop-zone-text']}>正在安装...</span>
              </>
            ) : (
              <>
                <span className={styles['drop-zone-icon']}>{isDragOver ? <FolderOpen size={24} /> : <Download size={24} />}</span>
                <span className={styles['drop-zone-text']}>
                  {isDragOver ? '松开以导入技能目录' : '拖入技能目录 · 或点击选择'}
                </span>
              </>
            )}
          </div>

          {/* 主体：左侧分类导航 + 右侧技能列表 */}
          {isLoading && installedSkills.length === 0 && !error ? (
            <Loading text="加载技能中..." />
          ) : filteredSkills.length === 0 ? (
            <Empty
              description={searchQuery || filterStatus !== 'all' ? '没有找到匹配的技能' : '暂无已安装技能'}
              action={
                !searchQuery && filterStatus === 'all' && (
                  <Button onClick={() => setActiveTab('store')}>
                    浏览技能商店
                  </Button>
                )
              }
            />
          ) : (
            <div className={styles['skills-body']}>
              {/* 左侧分类导航 */}
              <nav className={styles['category-nav']}>
                <button
                  className={clsx(styles['category-nav-item'], styles['category-nav-all'])}
                  onClick={() => {
                    const first = groupedByCategory[0]
                    if (first) scrollToCategory(first[0])
                  }}
                >
                  <span className={styles['category-nav-label']}>全部</span>
                  <span className={styles['category-nav-count']}>{filteredSkills.length}</span>
                </button>
                {groupedByCategory.map(([category, skills]) => (
                  <button
                    key={category || '__no_category__'}
                    className={styles['category-nav-item']}
                    onClick={() => scrollToCategory(category)}
                    title={category || '未分类'}
                  >
                    <span className={styles['category-nav-label']}>{category || '未分类'}</span>
                    <span className={styles['category-nav-count']}>{skills.length}</span>
                  </button>
                ))}
              </nav>

              {/* 右侧技能列表 */}
              <div className={styles['skills-list-scroll']}>
                {groupedByCategory.map(([category, skills]) => {
                  const isCollapsed = collapsedCategories.has(category)
                  return (
                    <div
                      key={category || '__no_category__'}
                      className={styles['skill-group']}
                      ref={(el) => {
                        if (el) categoryRefs.current.set(category, el)
                        else categoryRefs.current.delete(category)
                      }}
                    >
                      {/* 分类标题行（可折叠） */}
                      <button
                        className={styles['skill-group-header']}
                        onClick={() => toggleCategoryCollapse(category)}
                        aria-expanded={!isCollapsed}
                      >
                        <span className={styles['skill-group-chevron']}>
                          {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                        </span>
                        <span className={styles['skill-group-name']}>
                          {category || '未分类'}
                        </span>
                        <span className={styles['skill-group-count']}>{skills.length}</span>
                      </button>

                      {/* 技能行列表 */}
                      {!isCollapsed && (
                        <div className={styles['skill-rows']}>
                          {skills.map((skillInfo) => (
                            <SkillRow
                              key={skillInfo.skillItemId}
                              skillInfo={skillInfo}
                              isOperating={operatingSkillId === skillInfo.skillItemId}
                              onDetail={() => setDetailSkillInfo({
                                skillItemId: skillInfo.skillItemId,
                                isEnabled: skillInfo.isEnabled,
                                category: skillInfo.category,
                                skill: skillInfo.skill,
                              })}
                              onToggle={() => handleToggleSkill(skillInfo.skillItemId)}
                              onUninstall={() => openUninstallModal(skillInfo.skillItemId)}
                              onOpenDir={skillInfo.skill.tags?.includes('本地') ? () => handleOpenDir(skillInfo.skillItemId) : undefined}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </>
      )}

      {/* 工具管理标签页（内建工具，不含 MCP） */}
      {activeTab === 'tools' && (
        <>
          <PageHeader
            title="工具管理"
            subtitle={`共 ${toolStats.total - (groupedTools.get('channel')?.length ?? 0)} 个内建工具`}
          />
          <div className={styles['skills-toolbar']}>
            <div className={styles['skills-filters']}>
              <Input
                placeholder="搜索工具..."
                value={toolQuery}
                onChange={(e) => setToolQuery(e.target.value)}
                className={styles['skills-search']}
              />
            </div>
          </div>
          <Card className={styles['skills-list-card']}>
            {isToolsLoading ? (
              <Loading text="加载工具中..." />
            ) : filteredTools.filter(t => t.category !== 'channel').length === 0 ? (
              <Empty description={toolQuery ? '没有找到匹配的工具' : '暂无内建工具'} />
            ) : (
              <div className={styles['skills-list']}>
                {[...groupedTools.entries()]
                  .filter(([category]) => category !== 'channel')
                  .sort(([a], [b]) => (CATEGORY_ORDER[a] ?? 99) - (CATEGORY_ORDER[b] ?? 99))
                  .map(([category, categoryTools]) => (
                    <div key={category} className={styles['skill-group']}>
                      <h3 className={styles['skill-group-title']}>
                        {CATEGORY_LABELS[category] ?? category}（{categoryTools.length}）
                      </h3>
                      {categoryTools.map((tool) => (
                        <ToolCard
                          key={tool.name}
                          name={tool.name}
                          label={tool.label}
                          description={tool.description}
                          category={tool.category}
                          isReadOnly={tool.isReadOnly}
                          enabled={tool.enabled}
                          usageCount={tool.usageCount}
                          lastUsedAt={tool.lastUsedAt}
                          isToggling={togglingTool === tool.name}
                          onToggle={(enabled) => toggleTool(tool.name, enabled)}
                        />
                      ))}
                    </div>
                  ))}
              </div>
            )}
          </Card>
        </>
      )}

      {/* MCP 工具标签页 */}
      {activeTab === 'mcp' && (
        <>
          {/* 连接数由上方 McpServersPanel 展示，这里只讲工具 */}
          <PageHeader
            title="MCP 工具"
            subtitle={`已加载 ${groupedTools.get('channel')?.length ?? 0} 个工具，可单独开关`}
          />
          <div className={styles['skills-toolbar']}>
            <div className={styles['skills-filters']}>
              <Input
                placeholder="搜索 MCP 工具..."
                value={toolQuery}
                onChange={(e) => setToolQuery(e.target.value)}
                className={styles['skills-search']}
              />
            </div>
          </div>
          <Card className={styles['skills-list-card']}>
            {mcpStatus.length === 0 ? (
              <div style={{ padding: '16px', color: 'var(--mt-fg-3, var(--color-text-secondary))', fontSize: 13 }}>
                暂无 MCP Server。在上方「添加」里配置后立即生效。
              </div>
            ) : (() => {
              const mcpTools = filteredTools.filter(t => t.category === 'channel')
              if (mcpTools.length === 0) {
                return <Empty description={toolQuery ? '没有找到匹配的 MCP 工具' : '所有 MCP Server 均未提供工具'} />
              }
              return (
                <div className={styles['skills-list']}>
                  {mcpStatus.map(server => {
                    const serverTools = mcpTools.filter(t => t.name.startsWith(`mcp__${server.name}__`))
                    if (serverTools.length === 0) return null
                    return (
                      <div key={server.name} className={styles['skill-group']}>
                        <h3 className={styles['skill-group-title']}>
                          {server.connected
                            ? <Circle size={8} className={styles['status-dot-online']} />
                            : <Circle size={8} className={styles['status-dot-offline']} />
                          }{' '}
                          {server.name}（{serverTools.length} 个工具）
                          {server.lastError && !server.connected ? (
                            <span
                              style={{ marginLeft: 8, color: 'var(--mt-error)', fontWeight: 400, fontSize: 12 }}
                              title={server.lastError}
                            >
                              {server.lastError}
                            </span>
                          ) : null}
                        </h3>
                        {serverTools.map((tool) => (
                          <ToolCard
                            key={tool.name}
                            name={tool.name}
                            label={tool.label}
                            description={tool.description}
                            category={tool.category}
                            isReadOnly={tool.isReadOnly}
                            enabled={tool.enabled}
                            usageCount={tool.usageCount}
                            lastUsedAt={tool.lastUsedAt}
                            isToggling={togglingTool === tool.name}
                            onToggle={(enabled) => toggleTool(tool.name, enabled)}
                          />
                        ))}
                      </div>
                    )
                  })}
                </div>
              )
            })()}
          </Card>
        </>
      )}

      {/* 技能商店标签页 */}
      {activeTab === 'store' && (
        <SkillStoreView
          isConnected={isConnected}
          onInstallComplete={() => loadInstalledSkills()}
        />
      )}

      {/* 技能详情对话框 */}
      <MySkillDetailModal
        skillInfo={detailSkillInfo}
        isOpen={detailSkillInfo !== null}
        isOperating={detailSkillInfo ? operatingSkillId === detailSkillInfo.skillItemId : false}
        onClose={() => setDetailSkillInfo(null)}
        onToggle={() => {
          if (detailSkillInfo) handleToggleSkill(detailSkillInfo.skillItemId)
        }}
        onUninstall={() => {
          if (detailSkillInfo) {
            setDetailSkillInfo(null)
            openUninstallModal(detailSkillInfo.skillItemId)
          }
        }}
        onOpenDir={detailSkillInfo?.skill.tags?.includes('本地')
          ? () => { if (detailSkillInfo) handleOpenDir(detailSkillInfo.skillItemId) }
          : undefined
        }
      />

      {/* 卸载确认对话框 */}
      <Modal
        open={showUninstallModal}
        title="确认卸载"
        onClose={() => setShowUninstallModal(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowUninstallModal(false)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={handleUninstall}
              loading={!!operatingSkillId}
            >
              卸载
            </Button>
          </>
        }
      >
        <p>确定要卸载此技能吗？此操作不可恢复。</p>
      </Modal>
    </div>
  )
}

export { SkillsPage };
export default SkillsPage
