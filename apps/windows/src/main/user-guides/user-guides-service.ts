/**
 * 内置使用指南读取服务
 */

import fs from 'node:fs'
import path from 'node:path'
import type {
  BundledUserGuideContent,
  BundledUserGuideIndex,
  BundledUserGuidesManifest,
} from '../../shared/user-guides-types'
import { resolveUserGuidesDir } from './user-guides-paths'

/**
 * 读取并校验 manifest.json。
 */
function readManifest(dir: string): BundledUserGuidesManifest {
  const raw = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')
  const parsed = JSON.parse(raw) as BundledUserGuidesManifest
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.guides)) {
    throw new Error('内置指南 manifest 格式无效')
  }
  return parsed
}

/**
 * 列出所有已打包的使用指南索引。
 */
export function listBundledUserGuides(): readonly BundledUserGuideIndex[] {
  const dir = resolveUserGuidesDir()
  if (!dir) return []
  try {
    return readManifest(dir).guides
  } catch {
    return []
  }
}

/**
 * 按 id 读取指南 Markdown 正文。
 */
export function readBundledUserGuide(guideId: string): BundledUserGuideContent {
  const dir = resolveUserGuidesDir()
  if (!dir) throw new Error('内置指南目录不可用')

  const manifest = readManifest(dir)
  const entry = manifest.guides.find((g) => g.id === guideId)
  if (!entry) throw new Error(`指南不存在: ${guideId}`)

  const filePath = path.join(dir, entry.file)
  if (!fs.existsSync(filePath)) {
    throw new Error(`指南文件缺失: ${entry.file}`)
  }

  const markdown = fs.readFileSync(filePath, 'utf8')
  const stat = fs.statSync(filePath)
  return {
    id: entry.id,
    title: entry.title,
    markdown,
    updatedAt: stat.mtime.toISOString(),
  }
}
