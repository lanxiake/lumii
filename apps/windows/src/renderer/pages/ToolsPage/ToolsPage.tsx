/**
 * ToolsPage - 工具管理页面
 *
 * 集成内建工具、工具进化、搜索工具三个子模块
 */

import React, { useState } from 'react'
import clsx from 'clsx'
import { Wrench, FlaskConical, Search } from 'lucide-react'
import { PageHeader } from '../../components/ui/PageHeader/PageHeader'
import { Card } from '../../components/ui/Card/Card'
import { Input } from '../../components/ui/Input/Input'
import { Loading } from '../../components/ui/Loading/Loading'
import { Empty } from '../../components/ui/Empty/Empty'
import { ToolCard } from '../SkillsPage/components/ToolCard'
import { ToolEvolutionPanel } from './ToolEvolutionPanel'
import { SearchToolsSection } from '../SettingsPage/components/SearchToolsSection'
import { useToolSearch } from '../../hooks/business/useToolSearch'
import { CATEGORY_LABELS, CATEGORY_ORDER } from '../SkillsPage/SkillsPage.const'
import styles from './ToolsPage.module.css'

type ToolsTabType = 'builtin' | 'evolution' | 'search'

interface ToolsPageProps {
  embedded?: boolean
}

export const ToolsPage: React.FC<ToolsPageProps> = ({ embedded = false }) => {
  const [activeTab, setActiveTab] = useState<ToolsTabType>('builtin')

  const {
    filtered: filteredTools,
    grouped: groupedTools,
    stats: toolStats,
    query: toolQuery,
    setQuery: setToolQuery,
    isLoading: isToolsLoading,
    togglingTool,
    toggleTool,
  } = useToolSearch()

  // 过滤掉 channel 分类的工具（MCP 工具已移到 MCP Tab）
  const builtinTools = filteredTools.filter(t => t.category !== 'channel')
  const builtinGrouped = new Map(
    Array.from(groupedTools.entries()).filter(([category]) => category !== 'channel')
  )

  return (
    <div className={clsx(styles.toolsPage, embedded && styles.embedded)}>
      {/* Tab 导航 */}
      <div className={styles.tabs}>
        <button
          className={clsx(styles.tab, activeTab === 'builtin' && styles.active)}
          onClick={() => setActiveTab('builtin')}
        >
          <Wrench size={14} />
          <span>内建工具</span>
          <span className={styles.badge}>{toolStats.total - (groupedTools.get('channel')?.length ?? 0)}</span>
        </button>
        <button
          className={clsx(styles.tab, activeTab === 'evolution' && styles.active)}
          onClick={() => setActiveTab('evolution')}
        >
          <FlaskConical size={14} />
          <span>工具进化（实验）</span>
        </button>
        <button
          className={clsx(styles.tab, activeTab === 'search' && styles.active)}
          onClick={() => setActiveTab('search')}
        >
          <Search size={14} />
          <span>搜索工具</span>
        </button>
      </div>

      {/* Tab 内容 */}
      {activeTab === 'builtin' && (
        <>
          <PageHeader
            title="内建工具"
            subtitle={`共 ${toolStats.total - (groupedTools.get('channel')?.length ?? 0)} 个系统工具`}
          />
          <div className={styles.toolbar}>
            <Input
              placeholder="搜索工具..."
              value={toolQuery}
              onChange={(e) => setToolQuery(e.target.value)}
              className={styles.search}
            />
          </div>
          <Card className={styles.card} bodyClassName={styles.cardBody}>
            {isToolsLoading ? (
              <Loading text="加载工具中..." />
            ) : builtinTools.length === 0 ? (
              <Empty description={toolQuery ? '没有找到匹配的工具' : '暂无内建工具'} />
            ) : (
              <div className={styles.list}>
                {[...builtinGrouped.entries()]
                  .sort(([a], [b]) => (CATEGORY_ORDER[a] ?? 99) - (CATEGORY_ORDER[b] ?? 99))
                  .map(([category, categoryTools]) => (
                    <div key={category} className={styles.group}>
                      <h3 className={styles.groupTitle}>
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

      {activeTab === 'evolution' && <ToolEvolutionPanel />}

      {activeTab === 'search' && <SearchToolsSection />}
    </div>
  )
}

export default ToolsPage
