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
import type {
  ArtifactVariantResult,
  CreateVariantInput,
} from '../../shared/artifact-variant-types'
import type {
  ArtifactPinFailure,
  ArtifactPinListResult,
  ArtifactPinResult,
  ExportVersionOptions,
  PinVersionInput,
} from '../../shared/artifact-pin-types'

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
  exportFiles: (
    paths: readonly string[],
    mode: ArtifactExportMode,
    options?: ExportVersionOptions,
  ): Promise<ArtifactExportResult> =>
    ipcRenderer.invoke('artifact:export', {
      paths,
      mode,
      ...(options ? { versionId: options.versionId, sessionKey: options.sessionKey } : {}),
    }),

  /** 多选移入回收站（可在「清理」对话框里恢复） */
  trash: (paths: readonly string[]): Promise<ArtifactTrashResult> =>
    ipcRenderer.invoke('artifact:trash', paths),

  /** 文本区间替换（无 LLM）：只生成候选稿，不改目标文件 */
  proposeTextEdit: (
    input: ProposeTextEditInput,
  ): Promise<ArtifactEditProposal | ArtifactEditFailure> =>
    ipcRenderer.invoke('artifact:edit:proposeText', input),

  /** 文档选区 / PPT 单页改写（单轮 LLM）：先生成候选稿；editId 同时用于取消 */
  proposeEdit: (
    input: ProposeTextRangeInput | ProposeSlideEditInput,
  ): Promise<ArtifactEditProposal | SlideEditProposal | ArtifactEditFailure> =>
    ipcRenderer.invoke('artifact:edit:propose', input),

  /** PPT 页列表 + Python 依赖状态（jszip 提取，不依赖 Python） */
  slidesOutline: (input: { path: string }): Promise<SlideOutlineResult> =>
    ipcRenderer.invoke('artifact:slidesOutline', input),

  /** 取消在飞的改写请求 */
  abortEdit: (editId: string): Promise<{ ok: true; aborted: boolean }> =>
    ipcRenderer.invoke('artifact:edit:abort', { editId }),

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

  /** 两版文本 diff（内容不可取时返回原因） */
  versionDiff: (input: ArtifactVersionDiffInput): Promise<ArtifactVersionDiffResult> =>
    ipcRenderer.invoke('artifact:versionDiff', input),

  /** 某一版的只读文本内容 */
  versionContent: (input: ArtifactVersionContentInput): Promise<ArtifactVersionContentResult> =>
    ipcRenderer.invoke('artifact:versionContent', input),

  /** 图片同源变体：同 prompt/模型/尺寸再生成一张，落在源图同目录 */
  variant: (
    input: CreateVariantInput,
  ): Promise<ArtifactVariantResult | ArtifactEditFailure> =>
    ipcRenderer.invoke('artifact:variant', input),

  /** 「以此为准」：把某一版内容立即复制固化 */
  pinVersion: (input: PinVersionInput): Promise<ArtifactPinResult | ArtifactPinFailure> =>
    ipcRenderer.invoke('artifact:pinVersion', input),

  /** 取消选定（只删索引项，副本留到清理） */
  unpin: (pinId: string): Promise<{ ok: true } | ArtifactPinFailure> =>
    ipcRenderer.invoke('artifact:unpin', { pinId }),

  /** 已固化版本（设置页占用 / 动作条导出选定版） */
  pins: (input?: { sessionKey?: string; path?: string }): Promise<ArtifactPinListResult> =>
    ipcRenderer.invoke('artifact:pins', input ?? {}),

  /** 清空固化（设置页显式操作） */
  clearPins: (): Promise<{ ok: true; removed: number; freedBytes: number } | ArtifactPinFailure> =>
    ipcRenderer.invoke('artifact:pins:clear'),
}
