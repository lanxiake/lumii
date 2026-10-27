/**
 * 就地修改（renderer 薄封装）
 *
 * T1 只有 `listEdits` 有消费者（rail 合并）；propose/apply/discard/undo 在 T2/T4/T5
 * 接线。集中在这里，避免各处直接摸 `window.electronAPI.artifact`。
 */

import type {
  ArtifactEditApplyResult,
  ArtifactEditFailure,
  ArtifactEditListResult,
  ArtifactEditProposal,
  ArtifactEditUndoResult,
  ProposeTextEditInput,
  ProposeTextRangeInput,
} from '../../shared/artifact-edit-types'
import type {
  ArtifactVersionContentInput,
  ArtifactVersionContentResult,
  ArtifactVersionDiffInput,
  ArtifactVersionDiffResult,
} from '../../shared/artifact-version-types'
import type {
  ProposeSlideEditInput,
  SlideEditProposal,
  SlideOutlineResult,
} from '../../shared/artifact-slide-types'

function api() {
  return window.electronAPI?.artifact
}

export const artifactEditService = {
  proposeTextEdit: (
    input: ProposeTextEditInput,
  ): Promise<ArtifactEditProposal | ArtifactEditFailure> => {
    const target = api()
    if (!target?.proposeTextEdit) {
      return Promise.resolve({ ok: false, error: '当前版本不支持就地修改', code: 'unavailable' })
    }
    return target.proposeTextEdit(input)
  },

  proposeEdit: (
    input: ProposeTextRangeInput | ProposeSlideEditInput,
  ): Promise<ArtifactEditProposal | SlideEditProposal | ArtifactEditFailure> => {
    const target = api()
    if (!target?.proposeEdit) {
      return Promise.resolve({ ok: false, error: '当前版本不支持 AI 改写', code: 'unavailable' })
    }
    return target.proposeEdit(input)
  },

  slidesOutline: (input: { path: string }): Promise<SlideOutlineResult> => {
    const target = api()
    if (!target?.slidesOutline) {
      return Promise.resolve({ ok: false, error: '当前版本不支持 PPT 页列表' })
    }
    return target.slidesOutline(input)
  },

  abortEdit: (editId: string): Promise<{ ok: true; aborted: boolean }> => {
    const target = api()
    if (!target?.abortEdit) return Promise.resolve({ ok: true, aborted: false })
    return target.abortEdit(editId)
  },

  applyEdit: (editId: string): Promise<ArtifactEditApplyResult | ArtifactEditFailure> => {
    const target = api()
    if (!target?.applyEdit) {
      return Promise.resolve({ ok: false, error: '当前版本不支持就地修改', code: 'unavailable' })
    }
    return target.applyEdit(editId)
  },

  discardEdit: (editId: string): Promise<{ ok: true } | ArtifactEditFailure> => {
    const target = api()
    if (!target?.discardEdit) {
      return Promise.resolve({ ok: false, error: '当前版本不支持就地修改', code: 'unavailable' })
    }
    return target.discardEdit(editId)
  },

  undoEdit: (editId: string): Promise<ArtifactEditUndoResult | ArtifactEditFailure> => {
    const target = api()
    if (!target?.undoEdit) {
      return Promise.resolve({ ok: false, error: '当前版本不支持就地修改', code: 'unavailable' })
    }
    return target.undoEdit(editId)
  },

  listEdits: (
    sessionKey?: string,
    limit?: number,
  ): Promise<ArtifactEditListResult | ArtifactEditFailure> => {
    const target = api()
    if (!target?.listEdits) {
      return Promise.resolve({ ok: false, error: '当前版本不支持就地修改', code: 'unavailable' })
    }
    return target.listEdits(sessionKey, limit)
  },

  versionDiff: (input: ArtifactVersionDiffInput): Promise<ArtifactVersionDiffResult> => {
    const target = api()
    if (!target?.versionDiff) {
      return Promise.resolve({ ok: false, reason: '当前版本不支持版本对照' })
    }
    return target.versionDiff(input)
  },

  versionContent: (
    input: ArtifactVersionContentInput,
  ): Promise<ArtifactVersionContentResult> => {
    const target = api()
    if (!target?.versionContent) {
      return Promise.resolve({ ok: false, reason: '当前版本不支持版本预览' })
    }
    return target.versionContent(input)
  },
}
