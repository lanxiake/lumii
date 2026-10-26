/**
 * 产物缩略图（main → renderer）
 *
 * 缓存放在**工作区** `.lumii/cache/thumbs/`：
 * - `lumii-local://media` 的 ACL 只放行工作区与录制/截图目录；
 * - `.lumii/` 本身归 internal，清理不会碰；
 * - 换工作区就换缓存，不会串档。
 */

export interface ArtifactThumbMeta {
  width?: number
  height?: number
  durationSec?: number
  pages?: number
}

export interface ArtifactThumbResult {
  ok: boolean
  /** 可直接给 <img> 用的 lumii-local URL */
  url?: string
  meta?: ArtifactThumbMeta
  /** 命中磁盘缓存（真机验收用） */
  fromCache?: boolean
  error?: string
}
