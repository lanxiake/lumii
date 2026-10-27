/**
 * 版本对照（P2 T6）
 *
 * 按产物类型分派：
 * - 文本/代码：逐行 diff（沿用 T3）；
 * - 图片：两版内容都可用时物化副本，交给渲染层并排看（`CompareView`）；
 * - PPT：两版都可用时做**页级文本对照**（标题 + 正文），只列有变化的页。
 *
 * 二进制旧版通常没有副本（VCS 不含二进制）；只有本地编辑副本与固化副本能让
 * 「两版都可用」成立，拿不到时如实返回原因。
 */

import path from 'node:path'
import type { LocalArtifactEdit } from '../shared/artifact-edit-types'
import type {
  ArtifactVersionDiffResult,
  ArtifactVersionInfo,
  SlideVersionDiff,
} from '../shared/artifact-version-types'
import { kindOf } from '../shared/artifact-rules'
import { MAX_DIFF_BYTES, diffText } from '../shared/text-diff'
import { readSlideOutline } from './artifact-slides'
import { materializeVersionFile, readVersionBytes } from './artifact-versions'

export async function compareVersionPair(opts: {
  workspaceDir: string
  path: string
  from: ArtifactVersionInfo
  to: ArtifactVersionInfo
  allVersions: readonly ArtifactVersionInfo[]
  localEdits?: readonly LocalArtifactEdit[]
  fromLabel: string
  toLabel: string
}): Promise<ArtifactVersionDiffResult> {
  const kind = kindOf(opts.path)

  if (kind === 'image') {
    const from = await materializeVersionFile({
      workspaceDir: opts.workspaceDir,
      path: opts.path,
      version: opts.from,
      allVersions: opts.allVersions,
      ...(opts.localEdits ? { localEdits: opts.localEdits } : {}),
    })
    if (!from.ok) return { ok: false, reason: `起始版：${from.reason}` }
    const to = await materializeVersionFile({
      workspaceDir: opts.workspaceDir,
      path: opts.path,
      version: opts.to,
      allVersions: opts.allVersions,
      ...(opts.localEdits ? { localEdits: opts.localEdits } : {}),
    })
    if (!to.ok) return { ok: false, reason: `目标版：${to.reason}` }
    return {
      ok: true,
      kind: 'image',
      from: { path: from.rel, label: opts.fromLabel },
      to: { path: to.rel, label: opts.toLabel },
    }
  }

  if (kind === 'slides') {
    const from = await materializeVersionFile({
      workspaceDir: opts.workspaceDir,
      path: opts.path,
      version: opts.from,
      allVersions: opts.allVersions,
      ...(opts.localEdits ? { localEdits: opts.localEdits } : {}),
    })
    if (!from.ok) return { ok: false, reason: `起始版：${from.reason}` }
    const to = await materializeVersionFile({
      workspaceDir: opts.workspaceDir,
      path: opts.path,
      version: opts.to,
      allVersions: opts.allVersions,
      ...(opts.localEdits ? { localEdits: opts.localEdits } : {}),
    })
    if (!to.ok) return { ok: false, reason: `目标版：${to.reason}` }
    const fromAbs = path.join(opts.workspaceDir, ...from.rel.split('/'))
    const toAbs = path.join(opts.workspaceDir, ...to.rel.split('/'))
    const before = await readSlideOutline(fromAbs)
    if (!before.ok) return { ok: false, reason: `起始版：${before.error}` }
    const after = await readSlideOutline(toAbs)
    if (!after.ok) return { ok: false, reason: `目标版：${after.error}` }
    return {
      ok: true,
      kind: 'slides',
      fromLabel: opts.fromLabel,
      toLabel: opts.toLabel,
      pages: diffSlides(before.slides, after.slides, opts.path),
      totalPages: Math.max(before.slides.length, after.slides.length),
    }
  }

  const fromBytes = await readVersionBytes({
    workspaceDir: opts.workspaceDir,
    path: opts.path,
    version: opts.from,
    allVersions: opts.allVersions,
    ...(opts.localEdits ? { localEdits: opts.localEdits } : {}),
  })
  if (!fromBytes.ok) return { ok: false, reason: `起始版：${fromBytes.reason}` }
  const toBytes = await readVersionBytes({
    workspaceDir: opts.workspaceDir,
    path: opts.path,
    version: opts.to,
    allVersions: opts.allVersions,
    ...(opts.localEdits ? { localEdits: opts.localEdits } : {}),
  })
  if (!toBytes.ok) return { ok: false, reason: `目标版：${toBytes.reason}` }
  if (fromBytes.bytes.includes(0) || toBytes.bytes.includes(0)) {
    return { ok: false, reason: '该类型是二进制内容，暂不支持逐行对照' }
  }
  if (fromBytes.bytes.byteLength > MAX_DIFF_BYTES || toBytes.bytes.byteLength > MAX_DIFF_BYTES) {
    return { ok: false, reason: '文件过大（超过 512KB），暂不显示逐行差异' }
  }
  const diff = diffText(
    fromBytes.bytes.toString('utf8'),
    toBytes.bytes.toString('utf8'),
    opts.path,
  )
  return { ok: true, kind: 'text', ...diff }
}

/** 页级对照：按页合并标题+正文，只保留有变化的页 */
export function diffSlides(
  before: readonly { index: number; title: string; lines: readonly string[] }[],
  after: readonly { index: number; title: string; lines: readonly string[] }[],
  filePath: string,
): SlideVersionDiff[] {
  const total = Math.max(before.length, after.length)
  const out: SlideVersionDiff[] = []
  for (let index = 0; index < total; index += 1) {
    const older = before[index]
    const newer = after[index]
    const olderText = older ? older.lines.join('\n') : ''
    const newerText = newer ? newer.lines.join('\n') : ''
    if (olderText === newerText) continue
    const diff = diffText(olderText, newerText, `${filePath}#slide-${index + 1}`)
    out.push({
      index,
      title: newer?.title || older?.title || '',
      insertions: diff.insertions,
      deletions: diff.deletions,
      hunks: diff.hunks,
    })
  }
  return out
}
