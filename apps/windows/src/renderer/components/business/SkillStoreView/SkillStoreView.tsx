/**
 * SkillStoreView Component - 技能商店视图
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  useSkillStore,
  pickStoreSkillCardDescription,
  pickStoreSkillDetailText,
  type StoreSkillInfo,
  type SkillCategory,
  type StoreFilters
} from '../../../hooks/business/useSkillStore'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Input'
import { Select } from '../../ui/Select'
import { Loading } from '../../ui/Loading'
import { Empty } from '../../ui/Empty'
import { Modal } from '../../ui/Modal'
import { Plug, Search, RefreshCw, Star, Download, Check, Monitor, Server, Repeat, Wrench, CheckSquare, X } from 'lucide-react'
import clsx from 'clsx'
import styles from './SkillStoreView.module.css'

export interface SkillStoreViewProps {
  isConnected: boolean
  onInstallComplete?: () => void
}

function formatDownloads(count: number): string {
  if (count >= 10000) return `${(count / 10000).toFixed(1)}万`
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
  return count.toString()
}

/**
 * 技能行组件（紧凑列表）
 */
const StoreSkillRow: React.FC<{
  skill: StoreSkillInfo
  index: number
  onSelect: () => void
  onInstall: () => void
  isInstalling: boolean
}> = ({ skill, index, onSelect, onInstall, isInstalling }) => {
  const handleInstallClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onInstall()
  }

  return (
    <div className={styles['store-skill-row']} onClick={onSelect}>
      <span className={styles['store-row-index']}>{index + 1}</span>
      <span className={styles['store-row-icon']}>{skill.icon || <Wrench size={14} />}</span>

      {skill.installed && (
        <span className={styles['store-row-installed']} title="已安装">
          <Check size={10} />
        </span>
      )}

      <span className={styles['store-row-name']} title={skill.name}>{skill.name}</span>

      <span className={styles['store-row-desc']} title={pickStoreSkillCardDescription(skill)}>
        {pickStoreSkillCardDescription(skill)}
      </span>

      <div className={styles['store-row-stats']}>
        <span className={styles['store-row-stat']}>
          <Star size={10} />{skill.rating.toFixed(1)}
        </span>
        <span className={styles['store-row-stat']}>
          <Download size={10} />{formatDownloads(skill.downloads)}
        </span>
      </div>

      <div className={styles['store-row-action']}>
        {skill.installed ? (
          <Button variant={skill.hasUpdate ? 'ghost' : 'secondary'} size="sm" disabled={!skill.hasUpdate} onClick={handleInstallClick}>
            {skill.hasUpdate ? '更新' : '已装'}
          </Button>
        ) : (
          <Button variant="primary" size="sm" onClick={handleInstallClick} disabled={isInstalling} loading={isInstalling}>
            安装
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * 技能详情对话框
 */
const SkillDetailDialog: React.FC<{
  skill: StoreSkillInfo | null
  isOpen: boolean
  onClose: () => void
  onInstall: () => void
  isInstalling: boolean
}> = ({ skill, isOpen, onClose, onInstall, isInstalling }) => {
  if (!skill) return null

  const footer = (
    <>
      <Button variant="ghost" onClick={onClose}>关闭</Button>
      {skill.installed ? (
        <Button variant={skill.hasUpdate ? 'primary' : 'secondary'} disabled={!skill.hasUpdate}>
          {skill.hasUpdate ? '有更新' : '已安装'}
        </Button>
      ) : (
        <Button variant="primary" onClick={onInstall} loading={isInstalling}>安装</Button>
      )}
    </>
  )

  return (
    <Modal open={isOpen} onClose={onClose} width={500} footer={footer}>
      <div className={styles['skill-detail-content']}>
        <div className={styles['skill-detail-header']}>
          <span className={styles['skill-detail-icon']}>{skill.icon || <Wrench size={24} />}</span>
          <div className={styles['skill-detail-title']}>
            <h3>{skill.name}</h3>
            <span className={styles['skill-detail-author']}>by {skill.author}</span>
          </div>
        </div>

        <div className={styles['skill-detail-stats']}>
          <div className={styles['detail-stat-item']}>
            <span className={styles['detail-stat-label']}>评分</span>
            <span className={styles['detail-stat-value']}>
              <Star size={12} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 3 }} />
              {skill.rating.toFixed(1)} ({skill.ratingCount})
            </span>
          </div>
          <div className={styles['detail-stat-item']}>
            <span className={styles['detail-stat-label']}>下载</span>
            <span className={styles['detail-stat-value']}>
              <Download size={12} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 3 }} />
              {formatDownloads(skill.downloads)}
            </span>
          </div>
          <div className={styles['detail-stat-item']}>
            <span className={styles['detail-stat-label']}>版本</span>
            <span className={styles['detail-stat-value']}>v{skill.version}</span>
          </div>
        </div>

        <div className={styles['skill-detail-section']}>
          <h4>描述</h4>
          <p className={styles['skill-detail-body']}>{pickStoreSkillDetailText(skill)}</p>
        </div>

        <div className={styles['skill-detail-section']}>
          <h4>运行模式</h4>
          <p>
            {skill.runMode === 'local' && <><Monitor size={13} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} /> 本地运行 - 在您的设备上执行</>}
            {skill.runMode === 'server' && <><Server size={13} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} /> 服务端运行 - 在云端执行</>}
            {skill.runMode === 'hybrid' && <><Repeat size={13} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} /> 混合模式 - 本地与云端协作</>}
          </p>
        </div>

        {skill.screenshots && skill.screenshots.length > 0 && (
          <div className={styles['skill-detail-section']}>
            <h4>截图</h4>
            <div className={styles['skill-detail-screenshots']}>
              {skill.screenshots.map((url: string, index: number) => (
                <img key={index} src={url} alt={`截图 ${index + 1}`} />
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

/**
 * 分类侧边栏
 */
const CategorySidebar: React.FC<{
  categories: SkillCategory[]
  selectedCategory: string | null
  onSelectCategory: (category: string | null) => void
}> = ({ categories, selectedCategory, onSelectCategory }) => {
  return (
    <div className={styles['store-sidebar']}>
      <div className={styles['sidebar-section']}>
        <h3>分类</h3>
        <ul className={styles['category-list']}>
          {categories.map(category => (
            <li
              key={category.id}
              className={clsx(
                styles['category-item'],
                (selectedCategory === category.id || (category.id === 'all' && !selectedCategory)) && styles['selected']
              )}
              onClick={() => onSelectCategory(category.id === 'all' ? null : category.id)}
            >
              <span className={styles['category-name']}>{category.name}</span>
              <span className={styles['category-count']}>{category.count}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/**
 * 技能商店视图
 */
export const SkillStoreView: React.FC<SkillStoreViewProps> = ({
  isConnected,
  onInstallComplete
}) => {
  const {
    skills,
    stats,
    categories,
    isLoading,
    isLoadingMore,
    isRefreshing,
    hasMore,
    loadStoreSkills,
    loadMore,
    loadStats,
    loadCategories,
    searchSkills,
    updateFilters,
    getSkillDetail,
    installSkill,
    refreshStore,
    refreshInstallStatus,
  } = useSkillStore()

  const sidebarCategories = useMemo((): SkillCategory[] => {
    const total = stats?.totalSkills ?? 0
    return [{ id: 'all', name: '全部', icon: '🔍', count: total }, ...categories]
  }, [stats?.totalSkills, categories])

  const [searchQuery, setSearchQuery] = useState('')
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<string>('updated')
  const [quickFilter, setQuickFilter] = useState<'all' | 'installed' | 'not-installed' | 'featured'>('all')
  const [selectedSkill, setSelectedSkill] = useState<StoreSkillInfo | null>(null)
  const [showDetailDialog, setShowDetailDialog] = useState(false)
  const [installingSkillId, setInstallingSkillId] = useState<string | null>(null)
  const [installResult, setInstallResult] = useState<{ success: boolean; message: string } | null>(null)

  // 实时搜索 debounce 300ms
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => {
      searchSkills(value)
    }, 300)
  }, [searchSkills])

  useEffect(() => {
    if (isConnected) {
      const initQuery = sessionStorage.getItem('mtbot_skill_store_init_query') ?? ''
      if (initQuery) {
        sessionStorage.removeItem('mtbot_skill_store_init_query')
        setSearchQuery(initQuery)
        searchSkills(initQuery)
      } else {
        loadStoreSkills({ sortBy: 'updated' })
      }
      void loadStats()
      void loadCategories()
    }
  }, [isConnected, loadStoreSkills, loadStats, loadCategories, searchSkills])

  // 快速筛选（前端过滤）—— 使用严格比较避免 installed=undefined 导致分类混乱
  const displayedSkills = useMemo(() => {
    if (quickFilter === 'installed') return skills.filter(s => s.installed === true)
    if (quickFilter === 'not-installed') return skills.filter(s => s.installed !== true)
    if (quickFilter === 'featured') return skills.filter(s => s.isFeatured === true)
    return skills
  }, [skills, quickFilter])

  const handleCategorySelect = useCallback((category: string | null) => {
    setSelectedCategory(category)
    void updateFilters({ category: category || undefined })
  }, [updateFilters])

  const handleSortChange = useCallback((value: string) => {
    setSortBy(value)
    void updateFilters({ sortBy: value as StoreFilters['sortBy'] })
  }, [updateFilters])

  const handleSkillSelect = useCallback(async (skill: StoreSkillInfo) => {
    const detail = await getSkillDetail(skill.id)
    if (detail) {
      setSelectedSkill(detail)
      setShowDetailDialog(true)
    }
  }, [getSkillDetail])

  const handleInstall = useCallback(async (skillId: string) => {
    setInstallingSkillId(skillId)
    setInstallResult(null)
    try {
      const result = await installSkill(skillId)
      if (result.success) {
        setInstallResult({ success: true, message: '技能安装成功！' })
        loadStoreSkills()
        onInstallComplete?.()
      } else {
        setInstallResult({ success: false, message: result.error || '安装失败' })
      }
    } catch (err) {
      setInstallResult({ success: false, message: err instanceof Error ? err.message : '安装失败' })
    } finally {
      setInstallingSkillId(null)
    }
  }, [installSkill, loadStoreSkills, onInstallComplete])

  // 切换快速过滤器：需要激活时重新同步本地安装状态，避免脏数据
  const handleQuickFilterChange = useCallback(async (f: 'all' | 'installed' | 'not-installed' | 'featured') => {
    setQuickFilter(f)
    if (f === 'installed' || f === 'not-installed') {
      await refreshInstallStatus()
    }
  }, [refreshInstallStatus])

  // 滚动到底部自动加载更多
  const sentinelRef = useRef<HTMLDivElement>(null)
  const loadMoreRef = useRef(loadMore)
  loadMoreRef.current = loadMore
  const hasMoreRef = useRef(hasMore)
  hasMoreRef.current = hasMore
  const isLoadingRef = useRef(isLoading)
  isLoadingRef.current = isLoading
  const isLoadingMoreRef = useRef(isLoadingMore)
  isLoadingMoreRef.current = isLoadingMore
  // 过滤器激活时不触发 loadMore（避免计数跳变）
  const quickFilterRef = useRef(quickFilter)
  quickFilterRef.current = quickFilter

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries[0].isIntersecting &&
          hasMoreRef.current &&
          !isLoadingRef.current &&
          !isLoadingMoreRef.current &&
          quickFilterRef.current === 'all'  // 仅在"全部"模式下自动加载
        ) {
          loadMoreRef.current()
        }
      },
      { threshold: 0.1 }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, []) // 只挂载一次，通过 ref 读取最新状态

  if (!isConnected) {
    return (
      <div className={clsx(styles['skill-store-view'], styles['disconnected'])}>
        <div className={styles['disconnected-message']}>
          <Plug size={24} className={styles['icon']} />
          <p>请先连接 Gateway 以访问技能商店</p>
        </div>
      </div>
    )
  }

  return (
    <div className={styles['skill-store-view']}>
      {/* 顶部搜索和筛选 */}
      <div className={styles['store-header']}>
        <div className={styles['search-form']}>
          <Input
            placeholder="搜索技能..."
            value={searchQuery}
            onChange={e => handleSearchChange(e.target.value)}
            suffix={<Search size={13} style={{ color: 'var(--text-muted)' }} />}
          />
        </div>
        <div className={styles['store-filter-chips']}>
          {(['all', 'installed', 'not-installed', 'featured'] as const).map(f => (
            <button
              key={f}
              type="button"
              className={clsx(styles['filter-chip'], quickFilter === f && styles['active'])}
              onClick={() => handleQuickFilterChange(f)}
            >
              {f === 'all' ? '全部' : f === 'installed' ? '已安装' : f === 'not-installed' ? '未安装' : '推荐'}
            </button>
          ))}
        </div>
        <div className={styles['filter-controls']}>
          <Select
            value={sortBy}
            onChange={e => handleSortChange(e.target.value)}
            options={[
              { value: 'downloads', label: '按下载量' },
              { value: 'rating', label: '按评分' },
              { value: 'updated', label: '按更新时间' },
              { value: 'name', label: '按名称' },
            ]}
          />
          <Button variant="ghost" size="sm" onClick={refreshStore} disabled={isRefreshing} title="刷新">
            <RefreshCw size={13} style={isRefreshing ? { animation: 'spin 1s linear infinite' } : undefined} />
          </Button>
        </div>
      </div>

      {/* 安装结果提示 */}
      {installResult && (
        <div className={clsx(styles['result-banner'], installResult.success ? styles['success'] : styles['error'])}>
          <span>
            {installResult.success
              ? <CheckSquare size={14} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />
              : <X size={14} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />
            }
            {installResult.message}
          </span>
          <button onClick={() => setInstallResult(null)}><X size={13} /></button>
        </div>
      )}

      {/* 主内容区 */}
      <div className={styles['store-content']}>
        <CategorySidebar
          categories={sidebarCategories}
          selectedCategory={selectedCategory}
          onSelectCategory={handleCategorySelect}
        />

        <div className={styles['store-main']}>
          <section className={styles['store-section']}>
            <h2 className={styles['section-title']}>
              {searchQuery
                ? `"${searchQuery}" 的结果`
                : selectedCategory
                  ? sidebarCategories.find(c => c.id === selectedCategory)?.name || '技能'
                  : quickFilter === 'installed' ? '已安装'
                  : quickFilter === 'not-installed' ? '未安装'
                  : quickFilter === 'featured' ? '推荐技能'
                  : '全部技能'}
              <span className={styles['count']}>
                ({quickFilter === 'all' && !selectedCategory && !searchQuery
                  ? (stats?.totalSkills ?? displayedSkills.length)
                  : displayedSkills.length})
              </span>
            </h2>

            {isLoading && displayedSkills.length === 0 ? (
              <Loading text="加载中..." />
            ) : !isLoading && displayedSkills.length === 0 ? (
              <Empty title={quickFilter === 'installed' ? '暂无已安装技能' : '没有找到匹配的技能'} />
            ) : (
              <div className={styles['store-skill-rows']}>
                {displayedSkills.map((skill, i) => (
                  <StoreSkillRow
                    key={skill.id}
                    skill={skill}
                    index={i}
                    onSelect={() => handleSkillSelect(skill)}
                    onInstall={() => handleInstall(skill.id)}
                    isInstalling={installingSkillId === skill.id}
                  />
                ))}
              </div>
            )}

            {/* 底部 sentinel：滚动到底自动加载更多 */}
            <div ref={sentinelRef} className={styles['load-more-container']}>
              {isLoadingMore && (
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>加载中...</span>
              )}
            </div>
          </section>
        </div>
      </div>

      <SkillDetailDialog
        skill={selectedSkill}
        isOpen={showDetailDialog}
        onClose={() => setShowDetailDialog(false)}
        onInstall={() => selectedSkill && handleInstall(selectedSkill.id)}
        isInstalling={selectedSkill ? installingSkillId === selectedSkill.id : false}
      />
    </div>
  )
}

export default SkillStoreView
