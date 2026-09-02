/**
 * Wiki vault 宿主适配：Node fs + workspace 路径解析。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  ensureWikiVaultLayout,
  syncSourceToVault,
  removeSourceVaultArtifacts,
  WIKI_VAULT_LAYOUT_ID,
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
export function createWikiVaultSyncDeps(workspaceRoot?: string, vaultRootOverride?: string): WikiVaultSyncDeps {
  // vaultRootOverride 供测试注入隔离的临时目录，跳过默认的真实用户 workspace/wiki 路径。
  // 未显式传 workspaceRoot 时让它跟 vaultRoot 重合，这样 toRelPath/toAbsPath 的相对路径
  // 计算落在同一棵临时目录树内，不会因为落回真实 workspace 而产生跨目录的 ".." 相对路径
  // 或误把测试文件解析回生产环境路径。
  const workspace = path.resolve(workspaceRoot ?? vaultRootOverride ?? resolveActiveWorkspaceDir())
  const vaultRoot = vaultRootOverride ? path.resolve(vaultRootOverride) : resolveWikiDir(workspace)
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
 * 是否需要清空重建 wiki/：旧序号目录、过期 layoutId、损坏的 meta。
 */
export function wikiVaultNeedsRebuild(vaultRoot: string): boolean {
  if (!fs.existsSync(vaultRoot)) return false
  const names = fs.readdirSync(vaultRoot)
  if (names.length === 0) return false
  if (names.some((name) => /^\d{2}-/.test(name))) return true
  const metaPath = path.join(vaultRoot, '.lumii', 'wiki-meta.json')
  if (!fs.existsSync(metaPath)) return true
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { layoutId?: string }
    return meta.layoutId !== WIKI_VAULT_LAYOUT_ID
  } catch {
    return true
  }
}

/**
 * 删除 wiki/ 下全部历史文件与目录，随后由 ensureWikiVaultLayout 重建空树。
 */
export function emptyWikiVaultDir(vaultRoot: string): void {
  if (!fs.existsSync(vaultRoot)) return
  for (const name of fs.readdirSync(vaultRoot)) {
    fs.rmSync(path.join(vaultRoot, name), { recursive: true, force: true })
  }
}

/**
 * 初始化磁盘上的 wiki/ 目录树；遇到旧序号目录或过期 layoutId 时先清空再重建。
 */
export function ensureWikiVaultLayoutOnDisk(workspaceRoot?: string): {
  vaultRoot: string
  createdDirs: readonly string[]
} {
  const deps = createWikiVaultSyncDeps(workspaceRoot)
  if (wikiVaultNeedsRebuild(deps.vaultRoot)) {
    emptyWikiVaultDir(deps.vaultRoot)
  }
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
  vaultRootOverride?: string,
): WikiSource {
  const deps = createWikiVaultSyncDeps(workspaceRoot, vaultRootOverride)
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
  if (wikiVaultNeedsRebuild(deps.vaultRoot)) {
    emptyWikiVaultDir(deps.vaultRoot)
  }
  ensureWikiVaultLayout(deps.vaultRoot, deps.fs, repo.getOrCreateTopicTree())
  repo.remapLegacyTopicCategories()
  const sources = repo.listSources(agentId, userId)
  let synced = 0
  for (const source of sources) {
    try {
      const result = syncSourceToVault(deps, source)
      if (result) {
        repo.updateSourcePath(source.agent_id, source.user_id, source.id, result.relPath)
        synced += 1
      }
    } catch (err) {
      console.warn('[wiki-vault] backfill skipped:', source.id, (err as Error).message)
    }
  }
  return { vaultRoot: deps.vaultRoot, synced }
}

/**
 * 删除多条资料在 wiki/ vault 内的侧车或 native 实体，不碰 file-ref 指向的原始文件。
 */
export function removeWikiSourcesVaultArtifacts(sources: readonly WikiSource[], workspaceRoot?: string): number {
  const deps = createWikiVaultSyncDeps(workspaceRoot)
  let removed = 0
  for (const source of sources) {
    try {
      if (removeSourceVaultArtifacts(deps, source)) removed += 1
    } catch (err) {
      console.warn('[wiki-vault] remove artifact failed:', source.id, (err as Error).message)
    }
  }
  return removed
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
