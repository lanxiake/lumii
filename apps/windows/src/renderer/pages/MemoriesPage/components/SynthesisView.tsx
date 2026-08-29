/**
 * SynthesisView — 综述页列表与一键刷新
 *
 * 展示 category === 'syntheses' 的 Wiki 页面；「立即刷新全部」触发 autoRunSynthesis
 * 并刷新页面列表。不再渲染多选发起、候选审阅与接受/拒绝主流程。
 */
import React, { useCallback, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '../../../components/ui/Button/Button'
import { WikiSynthesisCandidates } from './WikiSynthesisCandidates'
import type {
  WikiPageListItem,
  WikiSynthesisListItem,
  WikiTopicTree,
} from '../../../hooks/business/useWikiPage'
import type { WikiConsolidateTarget } from './wikiConsolidate'

/** autoRunSynthesis 单条结果 */
interface AutoRunResultItem {
  readonly category: string
  readonly pageId: string
  readonly path: string
  readonly skipped?: boolean
  readonly error?: string
}

interface SynthesisViewProps {
  readonly pages: readonly WikiPageListItem[]
  readonly autoRunSynthesis: () => Promise<{ results: readonly AutoRunResultItem[] } | null>
  readonly onOpenPage: (pageId: string) => void
  readonly onRefreshPages: () => void | Promise<void>
  /** 二期：待审阅候选 + 接受/拒绝 */
  readonly synthesisRows?: readonly WikiSynthesisListItem[]
  readonly topicTree?: WikiTopicTree | null
  readonly consolidateTarget?: WikiConsolidateTarget | null
  readonly onAcceptSynthesis?: (
    synthesisId: string,
    category: string,
    subtopic: string,
    archiveSources?: boolean,
  ) => void
  readonly onRejectSynthesis?: (synthesisId: string) => void
  readonly onRefreshSyntheses?: () => void | Promise<void>
}

/** 将 auto-run 结果格式化为简短中文状态行 */
function formatRunStatusLine(results: readonly AutoRunResultItem[]): string {
  return results
    .map((r) => {
      if (r.error) return `${r.category}：失败（${r.error}）`
      if (r.skipped) return `${r.category}：跳过`
      return `${r.category}：成功`
    })
    .join(' · ')
}

/** 综述页列表与一键刷新视图 */
export const SynthesisView: React.FC<SynthesisViewProps> = ({
  pages,
  autoRunSynthesis,
  onOpenPage,
  onRefreshPages,
  synthesisRows = [],
  topicTree = null,
  consolidateTarget = null,
  onAcceptSynthesis,
  onRejectSynthesis,
  onRefreshSyntheses,
}) => {
  const [refreshing, setRefreshing] = useState(false)
  const [lastStatus, setLastStatus] = useState<string | null>(null)

  const synthesisPages = useMemo(
    () => pages.filter((p) => p.category === 'syntheses'),
    [pages],
  )

  /** 触发自动综述并刷新 Wiki 页面列表 */
  const handleRefreshAll = useCallback(async () => {
    setRefreshing(true)
    setLastStatus(null)
    try {
      const result = await autoRunSynthesis()
      if (result?.results?.length) {
        setLastStatus(formatRunStatusLine(result.results))
      } else if (result === null) {
        setLastStatus('刷新失败：无法连接 Agent 运行时')
      } else {
        setLastStatus('暂无需要更新的综述')
      }
      await onRefreshPages()
    } finally {
      setRefreshing(false)
    }
  }, [autoRunSynthesis, onRefreshPages])

  return (
    <div className="wiki-synthesis-view">
      <div className="wiki-synthesis-header">
        <h3>综述</h3>
        <Button
          variant="primary"
          size="sm"
          disabled={refreshing}
          onClick={() => void handleRefreshAll()}
        >
          <RefreshCw size={12} style={{ marginRight: 4 }} />
          {refreshing ? '刷新中…' : '立即刷新全部'}
        </Button>
      </div>

      {lastStatus && (
        <p className="wiki-synthesis-status" role="status">
          {lastStatus}
        </p>
      )}

      <WikiSynthesisCandidates
        rows={synthesisRows}
        tree={topicTree}
        consolidateTarget={consolidateTarget}
        onAccept={(id, category, subtopic, archiveSources) =>
          onAcceptSynthesis?.(id, category, subtopic, archiveSources)
        }
        onReject={(id) => onRejectSynthesis?.(id)}
        onRefresh={onRefreshSyntheses ? () => void onRefreshSyntheses() : undefined}
      />

      <div className="wiki-synthesis-list">
        {synthesisPages.length === 0 ? (
          <p className="wiki-empty-hint">
            定时任务会自动生成分类综述，也可点击立即刷新。
          </p>
        ) : (
          synthesisPages.map((page) => (
            <button
              key={page.id}
              type="button"
              className="wiki-page-list-item"
              onClick={() => onOpenPage(page.id)}
            >
              <div className="wiki-page-list-title">{page.title}</div>
              <div className="wiki-page-list-path">{page.path}</div>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

export default SynthesisView
