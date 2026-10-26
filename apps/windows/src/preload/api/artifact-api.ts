/**
 * 产物元数据 API（侧车）
 */
import { ipcRenderer } from 'electron'
import type { ArtifactSidecar } from '../../shared/artifact-declaration'
import type { ArtifactThumbResult } from '../../shared/artifact-thumbs-types'

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
}
