/**
 * 「以此为准」固化（P2 T6）的跨进程契约
 *
 * 固化不是指针：选定的那一版内容立即复制到 `<ws>/.lumii/pins/<pinId>/`，
 * 文件之后被覆盖也能导出旧版。
 */

import type { ArtifactEditFailure } from './artifact-edit-types'

export interface PinEntryInfo {
  pinId: string
  /** 工作区级产物为 null */
  sessionKey: string | null
  /** 工作区相对路径 */
  path: string
  versionId: string
  bytes: number
  /** epoch ms */
  at: number
}

export interface ArtifactPinResult {
  ok: true
  pinId: string
  bytes: number
  /** 同一路径原有固化被替换时的提示（旧文件保留到清理） */
  replaced?: string
}

export type ArtifactPinFailure = ArtifactEditFailure

export type ArtifactPinListResult =
  | {
      ok: true
      pins: PinEntryInfo[]
      totalBytes: number
      /** 软上限（2GB）：超过后拒绝新增固化 */
      limitBytes: number
    }
  | ArtifactPinFailure

export interface PinVersionInput {
  sessionKey?: string | null
  /** 工作区相对路径 */
  path: string
  /** turn:<messageId> | local:<editId> */
  versionId: string
}

/** 导出「选定版」时附带的版本信息（单文件） */
export interface ExportVersionOptions {
  sessionKey: string
  versionId: string
}
