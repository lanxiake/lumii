import React, { useMemo, useState } from 'react'
import { Button } from '../../../components/ui/Button/Button'
import { Checkbox } from '../../../components/ui/Checkbox/Checkbox'
import { WikiTopicPicker } from './WikiTopicPicker'
import type { WikiSynthesisListItem, WikiTopicTree } from '../../../hooks/business/useWikiPage'
import {
  displaySynthesisTitle,
  isConsolidateSynthesis,
  type WikiConsolidateTarget,
} from './wikiConsolidate'

interface WikiSynthesisCandidatesProps {
  readonly rows: readonly WikiSynthesisListItem[]
  readonly tree: WikiTopicTree | null
  /** 整合长文默认归档目录；有值时整合候选一键接受，不再弹目录选择器 */
  readonly consolidateTarget?: WikiConsolidateTarget | null
  readonly onAccept: (
    synthesisId: string,
    category: string,
    subtopic: string,
    archiveSources?: boolean,
  ) => void
  readonly onReject: (synthesisId: string) => void
  readonly onRefresh?: () => void
}

/** `truncated` 是「正文被截断」的标记，不是失败 */
const TRUNCATED = 'truncated'

/**
 * 待审阅综述候选列表。
 *
 * 二期语义：接受后综述成为目录里的一份普通文件（不是摘要页），所以接受时必须先选目录。
 * 生成中的候选只显示进度、不给接受按钮，避免接受到空正文。
 */
export const WikiSynthesisCandidates: React.FC<WikiSynthesisCandidatesProps> = ({
  rows,
  tree,
  consolidateTarget = null,
  onAccept,
  onReject,
  onRefresh,
}) => {
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [archiveSources, setArchiveSources] = useState(true)

  const candidates = useMemo(() => rows.filter((r) => r.status === 'candidate'), [rows])

  if (candidates.length === 0) {
    return (
      <div className="wiki-synthesis-candidates">
        <p className="wiki-empty-hint">
          还没有待审阅的整合/综述。在目录里多选短文后点「整合为长文」。
        </p>
        {onRefresh && (
          <Button variant="ghost" size="sm" onClick={onRefresh}>
            刷新
          </Button>
        )}
      </div>
    )
  }

  const pending = candidates.find((r) => r.id === pendingId) ?? null

  return (
    <div className="wiki-synthesis-candidates">
      <ul className="wiki-synthesis-candidate-list">
        {candidates.map((row) => {
          const running = row.progress !== null
          const failed = row.error !== null && row.error !== TRUNCATED
          const consolidate = isConsolidateSynthesis(row.title)
          return (
            <li key={row.id} className="wiki-synthesis-candidate">
              <div className="wiki-synthesis-candidate-main">
                <p className="wiki-synthesis-candidate-title">
                  {consolidate ? '整合：' : '综述：'}
                  {displaySynthesisTitle(row.title)}
                </p>
                {consolidate && !running && !failed && (
                  <p className="wiki-synthesis-candidate-note">
                    {consolidateTarget
                      ? `接受后将归档到 ${consolidateTarget.category} / ${consolidateTarget.subtopic}，并归档原短文`
                      : '接受后可归档原短文，目录只保留一篇长文'}
                  </p>
                )}
                {running && (
                  <p className="wiki-synthesis-candidate-progress">
                    生成中 {row.progress!.chunk} / {row.progress!.total}
                  </p>
                )}
                {failed && (
                  <p className="wiki-synthesis-candidate-error" role="alert">
                    生成失败：{row.error}
                  </p>
                )}
                {!running && !failed && row.error === TRUNCATED && (
                  <p className="wiki-synthesis-candidate-note">正文已截断到上限</p>
                )}
                {row.outputPath && !running && (
                  <p className="wiki-synthesis-candidate-path">{row.outputPath}</p>
                )}
              </div>
              <div className="wiki-synthesis-candidate-actions">
                {!running && !failed && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      if (consolidate && consolidateTarget) {
                        onAccept(row.id, consolidateTarget.category, consolidateTarget.subtopic, true)
                        return
                      }
                      setArchiveSources(consolidate)
                      setPendingId(row.id)
                    }}
                  >
                    {consolidate && consolidateTarget
                      ? `归档到${consolidateTarget.subtopic}`
                      : consolidate
                        ? '接受到本目录…'
                        : '接受到目录…'}
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => onReject(row.id)}>
                  丢弃
                </Button>
              </div>
            </li>
          )
        })}
      </ul>

      <WikiTopicPicker
        open={pending !== null}
        tree={tree}
        title={pending && isConsolidateSynthesis(pending.title) ? '整合长文归档到…' : '综述归档到…'}
        itemTitle={pending ? displaySynthesisTitle(pending.title) : undefined}
        onCancel={() => setPendingId(null)}
        onConfirm={(category, subtopic) => {
          const id = pendingId
          const archive = pending && isConsolidateSynthesis(pending.title) ? archiveSources : false
          setPendingId(null)
          if (id) onAccept(id, category, subtopic, archive)
        }}
        extraSection={
          pending && isConsolidateSynthesis(pending.title) ? (
            <label className="wiki-consolidate-accept-option">
              <Checkbox
                checked={archiveSources}
                onChange={(checked) => setArchiveSources(checked)}
              />
              <span>接受后归档被合并的原短文（推荐，减少碎片化）</span>
            </label>
          ) : null
        }
      />
    </div>
  )
}

export default WikiSynthesisCandidates
