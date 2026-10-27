/**
 * 产物元数据 API（侧车）
 */
import { ipcRenderer } from 'electron'
import type { ArtifactSidecar } from '../../shared/artifact-declaration'
import type { ArtifactThumbResult } from '../../shared/artifact-thumbs-types'
import type {
  ArtifactExportMode,
  ArtifactExportResult,
  ArtifactTrashResult,
} from '../../shared/artifact-export-types'
import type {
  ArtifactEditApplyResult,
  ArtifactEditFailure,
  ArtifactEditListResult,
  ArtifactEditProposal,
  ArtifactEditUndoResult,
  ProposeTextEditInput,
} from '../../shared/artifact-edit-types'

export const artifactApi = {
  /** 批量读 `<path>.lumii-artifact.json`；缺失/坏 JSON 不返回该项 */
  readMeta: (paths: readonly string[]): Promise<{
    ok: boolean
    metas: Record<string, ArtifactSidecar>
    error?: string
  }> => ipcRenderer.invoke('artifact:readMeta', paths),

  /** 缩略图（图片/视频首帧/PPT 页数）；缓存命中 fromCache=true */
  thumb: (relPath: string): Promise<ArtifactThumbResult> =>
    ipcRenderer.invoke('artifact:thumb', relPath),

  /** 多选导出：主进程弹框选目标，zip（保留目录结构）或 copy（平铺到目录） */
  exportFiles: (paths: readonly string[], mode: ArtifactExportMode): Promise<ArtifactExportResult> =>
    ipcRenderer.invoke('artifact:export', { paths, mode }),

  /** 多选移入回收站（可在「清理」对话框里恢复） */
  trash: (paths: readonly string[]): Promise<ArtifactTrashResult> =>
    ipcRenderer.invoke('artifact:trash', paths),

  /** 文本区间替换：只生成候选稿，不改目标文件 */
  proposeTextEdit: (
    input: ProposeTextEditInput,
  ): Promise<ArtifactEditProposal | ArtifactEditFailure> =>
    ipcRenderer.invoke('artifact:edit:proposeText', input),

  /** 应用候选稿（校验 baseHash；冲突拒绝） */
  applyEdit: (editId: string): Promise<ArtifactEditApplyResult | ArtifactEditFailure> =>
    ipcRenderer.invoke('artifact:edit:apply', { editId }),

  /** 放弃候选稿 */
  discardEdit: (editId: string): Promise<{ ok: true } | ArtifactEditFailure> =>
    ipcRenderer.invoke('artifact:edit:discard', { editId }),

  /** 撤销最近一次应用（当前内容必须仍等于该次结果） */
  undoEdit: (editId: string): Promise<ArtifactEditUndoResult | ArtifactEditFailure> =>
    ipcRenderer.invoke('artifact:edit:undo', { editId }),

  /** 已应用的本地编辑（rail 合并 / 版本历史用） */
  listEdits: (sessionKey?: string, limit?: number): Promise<ArtifactEditListResult | ArtifactEditFailure> =>
    ipcRenderer.invoke('artifact:edits:list', {
      ...(sessionKey !== undefined ? { sessionKey } : {}),
      ...(limit !== undefined ? { limit } : {}),
    }),
}
