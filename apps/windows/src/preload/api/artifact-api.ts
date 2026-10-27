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
}
