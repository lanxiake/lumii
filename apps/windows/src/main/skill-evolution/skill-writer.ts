/**
 * 技能写入器 — 本地文件读写、.meta.json 管理、局部 Patch 应用
 * 存储路径：~/.lumii/workspace/skills/<category>/<skillName>/
 */

import path from 'node:path'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolveLegacySkillsDir } from '../paths'
import type { SkillMeta, EvolutionRecord, SkillDraft } from './types'

const SKILLS_BASE_DIR = resolveLegacySkillsDir()
const PENDING_DRAFTS_FILE = path.join(path.dirname(SKILLS_BASE_DIR), 'skill-evolution-pending.json')

// ─── 内部工具 ────────────────────────────────────────────────────────────────

/** 防止路径穿越：name 段必须是合法目录名，不含路径分隔符 */
function safeSegment(segment: string): string {
  const sanitized = path.basename(segment).trim()
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new Error(`Invalid path segment: "${segment}"`)
  }
  return sanitized
}

/** 技能目录：支持可选分类子目录 */
function skillDir(skillName: string, category?: string): string {
  const safeName = safeSegment(skillName)
  if (!/^[a-z][a-z0-9-]*$/.test(safeName)) {
    throw new Error(`Invalid skill name: "${skillName}"`)
  }
  if (category) {
    return path.join(SKILLS_BASE_DIR, safeSegment(category), safeName)
  }
  return path.join(SKILLS_BASE_DIR, safeName)
}

function skillMdPath(skillName: string, category?: string): string {
  return path.join(skillDir(skillName, category), 'SKILL.md')
}

function metaPath(skillName: string, category?: string): string {
  return path.join(skillDir(skillName, category), '.meta.json')
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

// ─── Patch 应用逻辑 ──────────────────────────────────────────────────────────

function applyPatchToContent(
  skillMd: string,
  oldString: string,
  newString: string,
): { success: boolean; result: string } {
  if (skillMd.includes(oldString)) {
    return { success: true, result: skillMd.replace(oldString, newString) }
  }
  const trimmedOld = oldString.trim()
  const lines = skillMd.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === trimmedOld) {
      lines[i] = newString
      return { success: true, result: lines.join('\n') }
    }
  }
  return { success: false, result: skillMd }
}

function bumpPatchVersion(version: string): string {
  const parts = version.split('.').map(Number)
  if (parts.length !== 3 || parts.some(isNaN)) return '1.0.1'
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`
}

// ─── 公开 API ────────────────────────────────────────────────────────────────

/** 写入新技能（同名目录已存在则直接返回，不覆盖） */
export async function writeNewSkill(
  skillName: string,
  skillMd: string,
  meta: SkillMeta,
  category?: string,
): Promise<void> {
  const dir = skillDir(skillName, category)
  try {
    await fs.access(dir)
    return // 已存在，不覆盖
  } catch {
    // 不存在，继续创建
  }
  await ensureDir(dir)
  await fs.writeFile(skillMdPath(skillName, category), skillMd, 'utf-8')
  await fs.writeFile(metaPath(skillName, category), JSON.stringify(meta, null, 2), 'utf-8')
}

/**
 * 查找技能所在目录（支持分类子目录和根目录两种布局）。
 * 返回 { skillName, category? } 或 null（未找到）。
 */
export async function findSkill(skillName: string): Promise<{ skillName: string; category?: string } | null> {
  // 先尝试根目录
  try {
    await fs.access(skillDir(skillName))
    return { skillName }
  } catch { /* 继续 */ }

  // 再扫描分类子目录
  try {
    const entries = await fs.readdir(SKILLS_BASE_DIR, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        await fs.access(skillDir(skillName, entry.name))
        return { skillName, category: entry.name }
      } catch { /* 继续 */ }
    }
  } catch { /* 目录不存在 */ }

  return null
}

/** 读取技能 meta（自动查找分类） */
export async function readMeta(skillName: string): Promise<SkillMeta | null> {
  const found = await findSkill(skillName)
  if (!found) return null
  try {
    const raw = await fs.readFile(metaPath(found.skillName, found.category), 'utf-8')
    return JSON.parse(raw) as SkillMeta
  } catch {
    return null
  }
}

/** 读取技能 SKILL.md 内容（自动查找分类） */
export async function readSkillMd(skillName: string): Promise<string | null> {
  const found = await findSkill(skillName)
  if (!found) return null
  try {
    return await fs.readFile(skillMdPath(found.skillName, found.category), 'utf-8')
  } catch {
    return null
  }
}

/** 应用局部 Patch（精确匹配优先，失败降级全量重写） */
export async function applyPatch(
  skillName: string,
  patchOldString: string,
  patchNewString: string,
  record: Omit<EvolutionRecord, 'version'>,
): Promise<{ method: 'patch' | 'full_rewrite' }> {
  const found = await findSkill(skillName)
  if (!found) throw new Error(`Skill not found: ${skillName}`)

  const currentMd = await fs.readFile(skillMdPath(found.skillName, found.category), 'utf-8')
  const { success, result } = applyPatchToContent(currentMd, patchOldString, patchNewString)
  const method: 'patch' | 'full_rewrite' = success ? 'patch' : 'full_rewrite'

  const finalContent = success ? result : patchNewString
  await fs.writeFile(skillMdPath(found.skillName, found.category), finalContent, 'utf-8')

  const meta = await readMeta(skillName)
  if (meta) {
    const newVersion = bumpPatchVersion(meta.version)
    const fullRecord: EvolutionRecord = { ...record, version: newVersion, patchOldString, patchNewString }
    await updateMeta(skillName, { version: newVersion, evolutionHistory: [...meta.evolutionHistory, fullRecord] })
  }

  return { method }
}

/** 更新 meta 字段（不触碰 SKILL.md） */
export async function updateMeta(skillName: string, patch: Partial<SkillMeta>): Promise<void> {
  const found = await findSkill(skillName)
  const dir = found ? skillDir(found.skillName, found.category) : skillDir(skillName)
  const mp = path.join(dir, '.meta.json')
  let existing: SkillMeta | null = null
  try {
    existing = JSON.parse(await fs.readFile(mp, 'utf-8')) as SkillMeta
  } catch { /* 新建 */ }
  const updated = existing ? { ...existing, ...patch } : (patch as SkillMeta)
  await ensureDir(dir)
  await fs.writeFile(mp, JSON.stringify(updated, null, 2), 'utf-8')
}

/** 废弃技能（state → deprecated，不删除文件） */
export async function deprecateSkill(skillName: string): Promise<void> {
  await updateMeta(skillName, { state: 'deprecated' })
}

/**
 * 列出所有技能名称（扫描根目录 + 一级分类子目录）。
 * 返回格式：skillName（根目录）或 category/skillName（分类目录）
 */
export async function listSkillNames(): Promise<string[]> {
  await ensureDir(SKILLS_BASE_DIR)
  const result: string[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(SKILLS_BASE_DIR, { withFileTypes: true })
  } catch {
    return result
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const hasSkillMd = await fs.access(path.join(SKILLS_BASE_DIR, entry.name, 'SKILL.md')).then(() => true).catch(() => false)
    if (hasSkillMd) {
      // 根目录下的技能
      result.push(entry.name)
    } else {
      // 可能是分类目录，扫描一层
      try {
        const subEntries = await fs.readdir(path.join(SKILLS_BASE_DIR, entry.name), { withFileTypes: true })
        for (const sub of subEntries) {
          if (!sub.isDirectory()) continue
          const subHas = await fs.access(path.join(SKILLS_BASE_DIR, entry.name, sub.name, 'SKILL.md')).then(() => true).catch(() => false)
          if (subHas) result.push(sub.name)
        }
      } catch { /* 忽略 */ }
    }
  }
  return result
}

/** 列出所有已有分类目录名 */
export async function listCategories(): Promise<string[]> {
  await ensureDir(SKILLS_BASE_DIR)
  try {
    const entries = await fs.readdir(SKILLS_BASE_DIR, { withFileTypes: true })
    const categories: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // 有 SKILL.md 的是技能目录，没有的是分类目录
      const hasSkillMd = await fs.access(path.join(SKILLS_BASE_DIR, entry.name, 'SKILL.md')).then(() => true).catch(() => false)
      if (!hasSkillMd) categories.push(entry.name)
    }
    return categories
  } catch {
    return []
  }
}

// ─── Pending Drafts ──────────────────────────────────────────────────────────

async function loadPendingDrafts(): Promise<SkillDraft[]> {
  try {
    const raw = await fs.readFile(PENDING_DRAFTS_FILE, 'utf-8')
    return JSON.parse(raw) as SkillDraft[]
  } catch {
    return []
  }
}

async function savePendingDraftsFile(drafts: SkillDraft[]): Promise<void> {
  await ensureDir(path.dirname(PENDING_DRAFTS_FILE))
  await fs.writeFile(PENDING_DRAFTS_FILE, JSON.stringify(drafts, null, 2), 'utf-8')
}

// 串行锁：防止并发读写 pending drafts 文件导致数据丢失
let pendingDraftsLock = Promise.resolve()
function withPendingDraftsLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = pendingDraftsLock.then(fn, fn)
  pendingDraftsLock = next.then(() => {}, () => {})
  return next
}

export async function readPendingDrafts(): Promise<SkillDraft[]> {
  return loadPendingDrafts()
}

export function savePendingDraft(draft: SkillDraft): Promise<void> {
  return withPendingDraftsLock(async () => {
    const drafts = await loadPendingDrafts()
    drafts.push(draft)
    await savePendingDraftsFile(drafts)
  })
}

export function removePendingDraft(draftId: string): Promise<void> {
  return withPendingDraftsLock(async () => {
    const drafts = await loadPendingDrafts()
    await savePendingDraftsFile(drafts.filter(d => d.id !== draftId))
  })
}

export { SKILLS_BASE_DIR }
