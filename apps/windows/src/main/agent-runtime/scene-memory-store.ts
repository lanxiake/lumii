/**
 * SceneMemoryStore — 场景记忆存储层
 *
 * 把「项目偏好」「渠道偏好」从全局 user-memory.md 中分离出来，按场景存储：
 * - 有目录的项目：<项目目录>/.lumii/memory.md（跟项目走，可随 git 管理）
 * - 无目录的项目：<data>/scene-memory/project-<key>.md（如概念性项目、技能类项目）
 * - 渠道偏好：<data>/scene-memory/channel-<channelType>.md
 * - 项目注册表：<data>/scene-memory/_registry.json（名称/别名/路径，供命中匹配）
 *
 * 全部函数接受 baseDir（客户端数据根，生产传 resolveClientStateDir()），便于测试隔离。
 * 设计文档：docs/design/记忆设计/2026-09-12-scene-memory-design.md
 */

import path from 'node:path'
import fs from 'node:fs'
import { promises as fsp } from 'node:fs'

const log = {
  info: (...args: unknown[]) => console.log('[SceneMemoryStore]', ...args),
  warn: (...args: unknown[]) => console.warn('[SceneMemoryStore]', ...args),
  error: (...args: unknown[]) => console.error('[SceneMemoryStore]', ...args),
}

/** 场景记忆单文件上限（与 user-memory.md 保持一致） */
export const SCENE_MEMORY_MAX_CHARS = 65536

/** 项目注册表条目 */
export interface ProjectEntry {
  /** 稳定 slug，用于文件名 */
  key: string
  /** 显示名 */
  name: string
  /** 命中匹配词（含路径），大小写不敏感子串匹配 */
  aliases: string[]
  /** 项目目录绝对路径；无目录项目为 null */
  path: string | null
  /** 最近活跃时间戳 */
  lastActiveAt: number
}

export interface SceneRegistry {
  projects: ProjectEntry[]
}

export type SceneKind = 'project' | 'channel'

export interface SceneMemoryFile {
  content: string
  updatedAt: string
}

// ── 路径解析 ──────────────────────────────────────────────────────────────────

/** 场景记忆数据目录：<baseDir>/data/scene-memory */
export function resolveSceneMemoryDir(baseDir: string): string {
  return path.join(baseDir, 'data', 'scene-memory')
}

/** 注册表路径 */
export function resolveSceneRegistryPath(baseDir: string): string {
  return path.join(resolveSceneMemoryDir(baseDir), '_registry.json')
}

/**
 * 场景记忆文件路径。
 * - project + 有目录 → <项目目录>/.lumii/memory.md
 * - project 无目录 → <sceneDir>/project-<key>.md
 * - channel → <sceneDir>/channel-<key>.md
 */
export function resolveSceneFilePath(
  baseDir: string,
  scene: SceneKind,
  key: string,
  projectPath?: string | null,
): string {
  if (scene === 'project' && projectPath) {
    return path.join(projectPath, '.lumii', 'memory.md')
  }
  const prefix = scene === 'project' ? 'project' : 'channel'
  return path.join(resolveSceneMemoryDir(baseDir), `${prefix}-${key}.md`)
}

// ── slug 生成 ─────────────────────────────────────────────────────────────────

/**
 * 由显示名生成文件名安全的 slug：小写、非字母数字（含标点/路径符号）转 -。
 * 中文等任意语言字母保留（\p{L}），长度截断。
 */
export function slugifySceneKey(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  return base || `scene-${Date.now().toString(36)}`
}

// ── 注册表读写 ────────────────────────────────────────────────────────────────

/** 读取注册表；文件不存在或损坏时返回空注册表（不抛错） */
export async function loadRegistry(baseDir: string): Promise<SceneRegistry> {
  const p = resolveSceneRegistryPath(baseDir)
  try {
    if (!fs.existsSync(p)) return { projects: [] }
    const raw = await fsp.readFile(p, 'utf-8')
    const parsed = JSON.parse(raw) as SceneRegistry
    if (!parsed || !Array.isArray(parsed.projects)) return { projects: [] }
    return {
      projects: parsed.projects.filter(
        (e): e is ProjectEntry =>
          !!e && typeof e.key === 'string' && typeof e.name === 'string',
      ),
    }
  } catch (err) {
    log.warn(`[loadRegistry] 读取注册表失败，按空处理: ${err instanceof Error ? err.message : String(err)}`)
    return { projects: [] }
  }
}

/** 写入注册表（内容小，直接覆盖写） */
export async function saveRegistry(baseDir: string, registry: SceneRegistry): Promise<void> {
  const dir = resolveSceneMemoryDir(baseDir)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(
    resolveSceneRegistryPath(baseDir),
    JSON.stringify({ projects: registry.projects }, null, 2),
    'utf-8',
  )
}

// ── 项目登记 ──────────────────────────────────────────────────────────────────

function normalizePathForCompare(p: string): string {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase()
}

/** 按 key / path / name / alias 查找项目（key、path 精确；name 精确不区分大小写） */
export function findProject(registry: SceneRegistry, ref: string): ProjectEntry | null {
  const trimmed = ref.trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()

  const byKey = registry.projects.find((p) => p.key === lower)
  if (byKey) return byKey

  const asPath = normalizePathForCompare(trimmed)
  const byPath = registry.projects.find(
    (p) => p.path && normalizePathForCompare(p.path) === asPath,
  )
  if (byPath) return byPath

  const byName = registry.projects.find((p) => p.name.toLowerCase() === lower)
  if (byName) return byName

  const byAlias = registry.projects.find((p) =>
    p.aliases.some((a) => a.toLowerCase() === lower),
  )
  return byAlias ?? null
}

/**
 * 登记项目（幂等）：已存在（按 path 或 name）则合并别名并更新 lastActiveAt；否则新建。
 * @returns 登记后的条目
 */
export async function registerProject(
  baseDir: string,
  input: { name: string; path?: string | null; aliases?: readonly string[] },
): Promise<ProjectEntry> {
  const registry = await loadRegistry(baseDir)
  const name = input.name.trim()
  const projPath = input.path ? path.resolve(input.path) : null
  const extraAliases = (input.aliases ?? []).map((a) => a.trim()).filter(Boolean)

  // 按 path 优先查重，其次按 name
  let existing = projPath ? findProject(registry, projPath) : null
  if (!existing) existing = findProject(registry, name)

  if (existing) {
    const aliasSet = new Set(existing.aliases)
    if (projPath) aliasSet.add(projPath)
    for (const a of extraAliases) aliasSet.add(a)
    // 补全此前缺失的路径
    const updated: ProjectEntry = {
      ...existing,
      path: existing.path ?? projPath,
      aliases: Array.from(aliasSet),
      lastActiveAt: Date.now(),
    }
    const projects = registry.projects.map((p) => (p.key === existing!.key ? updated : p))
    await saveRegistry(baseDir, { projects })
    log.info(`[registerProject] 更新既有项目 key=${updated.key} name=${updated.name}`)
    return updated
  }

  // 新项目：生成不冲突的 key
  const baseKey = slugifySceneKey(name)
  let key = baseKey
  let n = 2
  while (registry.projects.some((p) => p.key === key)) {
    key = `${baseKey}-${n++}`
  }

  const entry: ProjectEntry = {
    key,
    name,
    aliases: Array.from(new Set([name, ...(projPath ? [projPath] : []), ...extraAliases])),
    path: projPath,
    lastActiveAt: Date.now(),
  }
  await saveRegistry(baseDir, { projects: [...registry.projects, entry] })
  log.info(`[registerProject] 新建项目 key=${key} name=${name} path=${projPath ?? '（无目录）'}`)
  return entry
}

/** 更新项目最近活跃时间（命中时调用；失败不抛） */
export async function touchProject(baseDir: string, key: string): Promise<void> {
  try {
    const registry = await loadRegistry(baseDir)
    const projects = registry.projects.map((p) =>
      p.key === key ? { ...p, lastActiveAt: Date.now() } : p,
    )
    await saveRegistry(baseDir, { projects })
  } catch (err) {
    log.warn(`[touchProject] 更新活跃时间失败: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ── 场景文件读写 ──────────────────────────────────────────────────────────────

/** 读取场景记忆文件；不存在返回 undefined */
export async function readSceneMemory(filePath: string): Promise<SceneMemoryFile | undefined> {
  try {
    if (!fs.existsSync(filePath)) return undefined
    const content = await fsp.readFile(filePath, 'utf-8')
    const stat = await fsp.stat(filePath)
    return { content, updatedAt: stat.mtime.toISOString() }
  } catch (err) {
    log.warn(`[readSceneMemory] 读取失败 path=${filePath}: ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}

/**
 * 写入场景记忆文件：目录自动创建、旧内容备份为 .bak、超上限拒绝。
 * @returns 成功返回 true
 */
export async function writeSceneMemory(filePath: string, content: string): Promise<boolean> {
  try {
    if (content.length > SCENE_MEMORY_MAX_CHARS) {
      log.warn(
        `[writeSceneMemory] 超出 ${SCENE_MEMORY_MAX_CHARS} 字符限制 (${content.length})，拒绝写入 path=${filePath}`,
      )
      return false
    }
    await fsp.mkdir(path.dirname(filePath), { recursive: true })
    if (fs.existsSync(filePath)) {
      await fsp.copyFile(filePath, `${filePath}.bak`)
    }
    await fsp.writeFile(filePath, content, 'utf-8')
    return true
  } catch (err) {
    log.error(`[writeSceneMemory] 写入失败 path=${filePath}: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

// ── 场景清单 ──────────────────────────────────────────────────────────────────

export interface SceneListEntry {
  scene: SceneKind
  key: string
  name: string
  path: string | null
  /** 记忆文件是否已存在 */
  hasMemory: boolean
}

/** 列出全部已知场景：注册表中的项目 + 数据目录中的渠道文件 */
export async function listScenes(baseDir: string): Promise<SceneListEntry[]> {
  const registry = await loadRegistry(baseDir)
  const out: SceneListEntry[] = []

  for (const p of registry.projects) {
    const filePath = resolveSceneFilePath(baseDir, 'project', p.key, p.path)
    out.push({
      scene: 'project',
      key: p.key,
      name: p.name,
      path: p.path,
      hasMemory: fs.existsSync(filePath),
    })
  }

  const sceneDir = resolveSceneMemoryDir(baseDir)
  try {
    if (fs.existsSync(sceneDir)) {
      const entries = await fsp.readdir(sceneDir)
      for (const name of entries) {
        const m = /^channel-(.+)\.md$/.exec(name)
        if (m && m[1]) {
          out.push({
            scene: 'channel',
            key: m[1],
            name: m[1],
            path: null,
            hasMemory: true,
          })
        }
      }
    }
  } catch (err) {
    log.warn(`[listScenes] 扫描渠道记忆失败: ${err instanceof Error ? err.message : String(err)}`)
  }

  return out
}
