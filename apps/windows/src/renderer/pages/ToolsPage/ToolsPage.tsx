/**
 * ToolsPage - 工具管理页面
 *
 * 集成内建工具、工具进化、搜索工具三个子模块
 */

import React, { useCallback, useState } from 'react'
import clsx from 'clsx'
import { Wrench, FlaskConical, Search, Download } from 'lucide-react'
import { PageHeader } from '../../components/ui/PageHeader/PageHeader'
import { Card } from '../../components/ui/Card/Card'
import { Input } from '../../components/ui/Input/Input'
import { Button } from '../../components/ui/Button/Button'
import { Loading } from '../../components/ui/Loading/Loading'
import { Empty } from '../../components/ui/Empty/Empty'
import { useToast } from '../../components/ui/Toast/useToast'
import { ToolCard } from '../SkillsPage/components/ToolCard'
import { ToolEvolutionPanel } from './ToolEvolutionPanel'
import { AgentUsageView } from './AgentUsageView'
import { SearchToolsSection } from '../SettingsPage/components/SearchToolsSection'
import { useToolSearch } from '../../hooks/business/useToolSearch'
import { saveFile } from '../../services/dialog-service'
import { writeFile } from '../../services/file-service'
import { CATEGORY_LABELS, CATEGORY_ORDER } from '../SkillsPage/SkillsPage.const'
import styles from './ToolsPage.module.css'

type ToolsTabType = 'builtin' | 'evolution' | 'search'

/** 内建工具 tab 的两种看法：全量清单（可开关） / 逐 Agent 用量（只读） */
type UsageMode = 'all' | 'byAgent'

interface ToolsPageProps {
  embedded?: boolean
}

/** 生成默认导出文件名 tool-usage-YYYY-MM-DD.json */
function defaultExportFileName(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `tool-usage-${y}-${m}-${day}.json`
}

export const ToolsPage: React.FC<ToolsPageProps> = ({ embedded = false }) => {
  const [activeTab, setActiveTab] = useState<ToolsTabType>('builtin')
  const [usageMode, setUsageMode] = useState<UsageMode>('all')
  const [exporting, setExporting] = useState(false)
  const toast = useToast()

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

  /** 导出工具使用记录到用户选择的 JSON 文件 */
  const handleExportUsage = useCallback(async () => {
    setExporting(true)
    try {
      const result = (await window.electronAPI.agentRuntime.sendCommand({
        type: 'tools:usage:export',
      })) as { json?: string }
      const json = result?.json
      if (typeof json !== 'string' || !json) {
        toast.error('没有可导出的使用记录')
        return
      }
      const filePath = await saveFile({
        title: '导出工具使用记录',
        defaultPath: defaultExportFileName(),
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      if (!filePath) return
      await writeFile(filePath, json)
      toast.success('已导出工具使用记录')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }, [toast])

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
            {/* 全局合计答不了「这个工具到底有没有人用」——那要按 Agent 看 */}
            <div className={styles.segmented}>
              <button
                className={clsx(styles.segBtn, usageMode === 'all' && styles.active)}
                onClick={() => setUsageMode('all')}
              >
                全部
              </button>
              <button
                className={clsx(styles.segBtn, usageMode === 'byAgent' && styles.active)}
                onClick={() => setUsageMode('byAgent')}
              >
                按 Agent
              </button>
            </div>
            {usageMode === 'all' && (
              <Input
                placeholder="搜索工具..."
                value={toolQuery}
                onChange={(e) => setToolQuery(e.target.value)}
                className={styles.search}
              />
            )}
            <Button
              variant="secondary"
              size="sm"
              loading={exporting}
              onClick={() => void handleExportUsage()}
              className={styles.exportBtn}
            >
              <Download size={14} />
              导出使用记录
            </Button>
          </div>
          <Card className={styles.card} bodyClassName={styles.cardBody}>
            {usageMode === 'byAgent' ? (
              <AgentUsageView />
            ) : isToolsLoading ? (
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
