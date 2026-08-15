import { isGitAvailable, runGit } from './git-cli'
import type { ProjectGitStatus, ProjectGitStatusFile } from './types'

/** 解析 `## ...` 分支行，提取分支名与 ahead/behind */
function parseBranchLine(line: string): { branch?: string; ahead?: number; behind?: number } {
  const content = line.slice(2).trim() // 去掉开头 "## "
  if (!content || content.startsWith('HEAD (no branch)')) return {}

  // "main...origin/main [ahead 2, behind 1]" | "No commits yet on main" | "main"
  const noCommitsMatch = content.match(/^No commits yet on (.+)$/)
  if (noCommitsMatch) return { branch: noCommitsMatch[1] }

  const branchMatch = content.match(/^([^.\s]+)/)
  const branch = branchMatch?.[1]

  const aheadMatch = content.match(/ahead (\d+)/)
  const behindMatch = content.match(/behind (\d+)/)

  return {
    branch,
    ahead: aheadMatch ? Number(aheadMatch[1]) : undefined,
    behind: behindMatch ? Number(behindMatch[1]) : undefined,
  }
}

/** 解析单条文件状态行：前两字符状态 + 空格 + 路径 */
function parseFileLine(line: string): ProjectGitStatusFile | null {
  if (line.length < 3) return null
  const index = line[0]
  const worktree = line[1]
  const path = line.slice(3).replace(/\\/g, '/')
  if (!path) return null
  return { path, index, worktree }
}

/** 状态字符集合，用于在 -z 输出中区分「状态行」与「重命名的原路径」 */
const STATUS_CHARS = new Set([' ', 'M', 'A', 'D', 'R', 'C', 'U', '?', '!', 'T'])

/** 是否为一条状态行（`XY path`）；重命名的第二段（原路径）不符合此形状 */
function isStatusLine(part: string): boolean {
  return part.length > 3 && STATUS_CHARS.has(part[0]) && STATUS_CHARS.has(part[1]) && part[2] === ' '
}

export async function getProjectGitStatus(realPath: string): Promise<ProjectGitStatus> {
  const available = await isGitAvailable()
  if (!available) {
    return { available: false, isRepo: false, files: [] }
  }

  let statusOutput: string
  try {
    // --ignored: 带出 `!!` 条目用于灰显；traditional 模式会把整体被忽略的目录折叠成单条，不会逐个列出 node_modules 里的文件
    statusOutput = await runGit(
      ['status', '--porcelain=v1', '-z', '--branch', '-unormal', '--ignored'],
      realPath,
    )
  } catch {
    return { available: true, isRepo: false, files: [] }
  }

  const parts = statusOutput.split('\0').filter((p) => p.length > 0)
  let branch: string | undefined
  let ahead: number | undefined
  let behind: number | undefined
  const files: ProjectGitStatusFile[] = []

  for (const part of parts) {
    if (part.startsWith('## ')) {
      const parsed = parseBranchLine(part)
      branch = parsed.branch
      ahead = parsed.ahead
      behind = parsed.behind
    } else if (isStatusLine(part)) {
      const file = parseFileLine(part)
      if (file) files.push(file)
    }
    // 跳过重命名的第二段（原路径）：`\0R  newPath\0oldPath\0` 中的 oldPath 不是状态行
  }

  let remoteUrl: string | undefined
  try {
    remoteUrl = (await runGit(['remote', 'get-url', 'origin'], realPath)).trim() || undefined
  } catch {
    remoteUrl = undefined
  }

  // 获取每个文件的 insertions/deletions（git diff --numstat HEAD）
  if (files.length > 0) {
    try {
      const numstatOutput = await runGit(['diff', '--numstat', 'HEAD'], realPath)
      const numstatLines = numstatOutput.split('\n').filter((line) => line.trim().length > 0)
      const numstatMap = new Map<string, { insertions: number; deletions: number }>()
      for (const line of numstatLines) {
        const [insertions, deletions, path] = line.split('\t')
        if (path) {
          numstatMap.set(path.replace(/\\/g, '/'), {
            insertions: insertions === '-' ? 0 : Number(insertions),
            deletions: deletions === '-' ? 0 : Number(deletions),
          })
        }
      }
      // 合并到 files 数组
      for (const file of files) {
        const stats = numstatMap.get(file.path)
        if (stats) {
          file.insertions = stats.insertions
          file.deletions = stats.deletions
        }
      }
    } catch {
      // numstat 失败不影响整体结果，只是没有行数统计
    }
  }

  return { available: true, isRepo: true, branch, ahead, behind, remoteUrl, files }
}
