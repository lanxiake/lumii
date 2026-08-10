/**
 * 开发类 AI 工具（ACP）项目管理。
 *
 * 项目统一驱动「文件浏览」与「ACP 工作目录」：
 * - 新建项目：在 workspace/projects/<name> 下 mkdir，realPath 即该目录
 * - 打开已有项目：在 workspace/projects/<name> 建 junction 软链接指向真实路径
 *   （junction 在 Windows 无需管理员权限，符号链接需要）
 * - 活动项目：其 realPath 写入所有 MTBOT_*_ACP_CWD 环境变量作为 ACP cwd
 *
 * 安全约束：移除外部项目时只删 junction 链接（fs.unlink），
 * 绝不递归删除真实目标目录，避免误删用户项目源文件。
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import type { CodingDevProject } from './config/types.js'

/** 项目名非法字符（路径分隔符与 Windows 保留字符） */
const INVALID_NAME_RE = /[<>:"/\\|?*\x00-\x1f]/

/**
 * 校验项目名：非空、无路径分隔符/非法字符、非 . 或 ..。
 * 抛出错误说明具体原因，供 IPC 层直接透传给用户。
 */
export function assertValidProjectName(name: string): void {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('项目名不能为空')
  if (trimmed === '.' || trimmed === '..') throw new Error('项目名非法')
  if (INVALID_NAME_RE.test(trimmed)) throw new Error('项目名不能包含 < > : " / \\ | ? * 等字符')
  if (trimmed.length > 100) throw new Error('项目名过长（最多 100 字符）')
}

/**
 * 解析活动项目的 realPath。找不到活动项目时返回 undefined（调用方回退）。
 */
export function resolveActiveProjectPath(
  projects: CodingDevProject[] | undefined,
  activeProjectName: string | undefined,
): string | undefined {
  const name = activeProjectName?.trim()
  if (!name || !projects) return undefined
  return projects.find((p) => p.name === name)?.realPath
}

/**
 * 新建项目：在 projectsDir/<name> 下创建目录（不可与现有项目重名）。
 * 返回追加后的新项目列表（不可变，调用方负责持久化）。
 */
export async function createProject(params: {
  projectsDir: string
  name: string
  existing: CodingDevProject[]
}): Promise<CodingDevProject[]> {
  const name = params.name.trim()
  assertValidProjectName(name)
  if (params.existing.some((p) => p.name === name)) {
    throw new Error(`项目「${name}」已存在`)
  }
  // 确保 projectsDir 父目录存在
  await fs.mkdir(params.projectsDir, { recursive: true })
  const realPath = join(params.projectsDir, name)
  await fs.mkdir(realPath, { recursive: true })
  return [...params.existing, { name, realPath, isExternal: false }]
}

/**
 * 打开已有项目：在 projectsDir/<name> 建 junction 指向 targetPath。
 * 返回追加后的新项目列表。
 */
export async function openExistingProject(params: {
  projectsDir: string
  name: string
  targetPath: string
  existing: CodingDevProject[]
}): Promise<CodingDevProject[]> {
  const name = params.name.trim()
  assertValidProjectName(name)
  if (params.existing.some((p) => p.name === name)) {
    throw new Error(`项目「${name}」已存在`)
  }
  const target = params.targetPath.trim()
  const stat = await fs.stat(target).catch(() => null)
  if (!stat) throw new Error('目标目录不存在')
  if (!stat.isDirectory()) throw new Error('目标路径不是目录')

  await fs.mkdir(params.projectsDir, { recursive: true })
  const linkPath = join(params.projectsDir, name)
  // junction：Windows 无需管理员权限；type 参数在非 Windows 被忽略（退化为普通 symlink）
  await fs.symlink(target, linkPath, 'junction')
  return [...params.existing, { name, realPath: target, isExternal: true }]
}

/**
 * 将配置中的项目列表与磁盘 projects/ 目录对齐：
 * - 磁盘上有、配置中无的内部目录 → 补进列表
 * - 配置中指向已消失路径的条目保留（由用户手动移除）
 * - 若活动项目名不在列表中 → 清空或回退到首项
 */
export async function reconcileProjectsWithDisk(params: {
  projectsDir: string
  existing: CodingDevProject[]
  activeProject?: string
}): Promise<{ projects: CodingDevProject[]; activeProject: string | undefined; changed: boolean }> {
  await fs.mkdir(params.projectsDir, { recursive: true })
  const byName = new Map(params.existing.map((p) => [p.name, p]))

  let entries: string[] = []
  try {
    entries = await fs.readdir(params.projectsDir)
  } catch {
    entries = []
  }

  let changed = false
  for (const name of entries) {
    if (name.startsWith('.')) continue
    if (byName.has(name)) continue
    const abs = join(params.projectsDir, name)
    const st = await fs.lstat(abs).catch(() => null)
    if (!st) continue
    // 内部目录或 junction 均视为可登记项目
    if (st.isDirectory() || st.isSymbolicLink()) {
      let realPath = abs
      let isExternal = false
      if (st.isSymbolicLink()) {
        isExternal = true
        realPath = await fs.realpath(abs).catch(() => abs)
      }
      byName.set(name, { name, realPath, isExternal })
      changed = true
    }
  }

  const projects = Array.from(byName.values()).sort((a, b) =>
    a.name.localeCompare(b.name, 'zh-CN', { numeric: true }),
  )
  if (projects.length !== params.existing.length) changed = true

  let activeProject = params.activeProject?.trim() || undefined
  if (activeProject && !projects.some((p) => p.name === activeProject)) {
    activeProject = projects[0]?.name
    changed = true
  }

  return { projects, activeProject, changed }
}

/**
 * 移除项目。外部项目仅删除 junction 链接（保留真实目标）；
 * 内部项目保留磁盘数据，但重命名为 `.removed-<name>-<ts>` 前缀
 * （避免破坏性删除用户数据，同时让 reconcileProjectsWithDisk 的
 * `name.startsWith('.')` 跳过逻辑不再把它当"新项目"扫描回列表）。
 * 返回移除后的新项目列表。
 */
export async function removeProject(params: {
  projectsDir: string
  name: string
  existing: CodingDevProject[]
}): Promise<CodingDevProject[]> {
  const target = params.existing.find((p) => p.name === params.name)
  if (!target) return params.existing
  if (target.isExternal) {
    const linkPath = join(params.projectsDir, target.name)
    // 只删链接本身，绝不递归删除真实目标目录
    await fs.unlink(linkPath).catch(async (err: NodeJS.ErrnoException) => {
      // 部分 Windows 环境下 junction 需用 rmdir 删除
      if (err.code === 'EPERM' || err.code === 'EISDIR') {
        await fs.rmdir(linkPath).catch(() => {})
        return
      }
      if (err.code !== 'ENOENT') throw err
    })
  } else {
    const oldPath = join(params.projectsDir, target.name)
    const removedPath = join(params.projectsDir, `.removed-${target.name}-${Date.now()}`)
    await fs.rename(oldPath, removedPath).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err
    })
  }
  return params.existing.filter((p) => p.name !== params.name)
}
