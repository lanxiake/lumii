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
} from '../../shared/artifact-edit-types'

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
}
