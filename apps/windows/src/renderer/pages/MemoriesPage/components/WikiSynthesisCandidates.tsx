import React, { useMemo, useState } from 'react'
import { Button } from '../../../components/ui/Button/Button'
import { WikiTopicPicker } from './WikiTopicPicker'
import type { WikiSynthesisListItem, WikiTopicTree } from '../../../hooks/business/useWikiPage'

interface WikiSynthesisCandidatesProps {
  readonly rows: readonly WikiSynthesisListItem[]
  readonly tree: WikiTopicTree | null
  readonly onAccept: (synthesisId: string, category: string, subtopic: string) => void
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
  onAccept,
  onReject,
  onRefresh,
}) => {
  const [pendingId, setPendingId] = useState<string | null>(null)

  const candidates = useMemo(() => rows.filter((r) => r.status === 'candidate'), [rows])

  if (candidates.length === 0) {
    return (
      <div className="wiki-synthesis-candidates">
        <p className="wiki-empty-hint">
          还没有待审阅的综述。在目录里多选文件后点「生成本组综述」。
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
          return (
            <li key={row.id} className="wiki-synthesis-candidate">
              <div className="wiki-synthesis-candidate-main">
                <p className="wiki-synthesis-candidate-title">{row.title}</p>
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
                  <Button variant="primary" size="sm" onClick={() => setPendingId(row.id)}>
                    接受到目录…
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
        title="综述归档到…"
        itemTitle={pending?.title}
        onCancel={() => setPendingId(null)}
        onConfirm={(category, subtopic) => {
          const id = pendingId
          setPendingId(null)
          if (id) onAccept(id, category, subtopic)
        }}
      />
    </div>
  )
}

export default WikiSynthesisCandidates
