/**
 * Wiki vault 宿主适配：Node fs + workspace 路径解析。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  ensureWikiVaultLayout,
  syncSourceToVault,
  type WikiSource,
  type WikiVaultFs,
  type WikiVaultSyncDeps,
} from '@mtbot/agent-runtime'
import type { WikiRepo } from '@mtbot/agent-runtime'
import { resolveActiveWorkspaceDir, resolveWikiDir } from '../workspace-paths'

/**
 * 构造 Node fs 适配器，供 agent-runtime vault 模块使用。
 */
export function createNodeWikiVaultFs(): WikiVaultFs {
  return {
    joinPath: (...segments) => path.join(...segments),
    exists: (p) => fs.existsSync(p),
    mkdir: (p) => {
      fs.mkdirSync(p, { recursive: true })
    },
    writeFile: (p, content) => {
      fs.writeFileSync(p, content, 'utf8')
    },
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    rename: (from, to) => {
      fs.renameSync(from, to)
    },
    unlink: (p) => {
      fs.unlinkSync(p)
    },
    copyFile: (from, to) => {
      fs.copyFileSync(from, to)
    },
  }
}

/**
 * 构造 vault 同步依赖（vaultRoot 与 workspaceRoot 由当前工作空间解析）。
 */
export function createWikiVaultSyncDeps(workspaceRoot?: string): WikiVaultSyncDeps {
  const workspace = path.resolve(workspaceRoot ?? resolveActiveWorkspaceDir())
  const vaultRoot = resolveWikiDir(workspace)
  const fsAdapter = createNodeWikiVaultFs()
  return {
    vaultRoot,
    workspaceRoot: workspace,
    fs: fsAdapter,
    toRelPath: (absPath) => {
      const rel = path.relative(workspace, absPath)
      return rel.split(path.sep).join('/')
    },
    toAbsPath: (relOrAbs) => {
      if (path.isAbsolute(relOrAbs)) return path.resolve(relOrAbs)
      return path.resolve(workspace, relOrAbs.replace(/\//g, path.sep))
    },
  }
}

/**
 * 初始化 wiki/ 目录树。
 */
export function ensureWikiVaultLayoutOnDisk(workspaceRoot?: string): {
  vaultRoot: string
  createdDirs: readonly string[]
} {
  const deps = createWikiVaultSyncDeps(workspaceRoot)
  const result = ensureWikiVaultLayout(deps.vaultRoot, deps.fs)
  return { vaultRoot: result.vaultRoot, createdDirs: result.createdDirs }
}

/**
 * 将单条资料同步到 vault，并更新 DB 中的 source_path。
 */
export function syncWikiSourceToVault(
  repo: WikiRepo,
  source: WikiSource,
  workspaceRoot?: string,
): WikiSource {
  const deps = createWikiVaultSyncDeps(workspaceRoot)
  const synced = syncSourceToVault(deps, source)
  if (!synced) return source
  return repo.updateSourcePath(source.agent_id, source.user_id, source.id, synced.relPath)
}

/**
 * 按 id 拉取资料并同步 vault。
 */
export function syncWikiSourceById(
  repo: WikiRepo,
  agentId: string,
  userId: string,
  sourceId: string,
  workspaceRoot?: string,
): void {
  const source = repo.findSourceById(sourceId, agentId, userId)
  if (!source) return
  syncWikiSourceToVault(repo, source, workspaceRoot)
}

/**
 * 确保目录存在并回填全部资料。
 */
export function ensureAndBackfillWikiVault(
  repo: WikiRepo,
  agentId: string,
  userId: string,
  workspaceRoot?: string,
): { vaultRoot: string; synced: number } {
  const deps = createWikiVaultSyncDeps(workspaceRoot)
  ensureWikiVaultLayout(deps.vaultRoot, deps.fs, repo.getOrCreateTopicTree())
  const sources = repo.listSources(agentId, userId)
  let synced = 0
  for (const source of sources) {
    const result = syncSourceToVault(deps, source)
    if (result) {
      repo.updateSourcePath(source.agent_id, source.user_id, source.id, result.relPath)
      synced += 1
    }
  }
  return { vaultRoot: deps.vaultRoot, synced }
}

/**
 * 创建资料落库后的 vault 同步回调（供 WikiOrganizer 使用）。
 */
export function createWikiVaultSourceHook(repo: WikiRepo, workspaceRoot?: string) {
  return (source: WikiSource): void => {
    try {
      syncWikiSourceToVault(repo, source, workspaceRoot)
    } catch (err) {
      console.warn('[wiki-vault] sync failed:', (err as Error).message)
    }
  }
}
