/**
 * Wiki 失效引用清理（Windows 宿主）：注入文件系统与 vault 清理。
 */
import {
  purgeBrokenWikiSources,
  resolveWikiSourceFileExists,
  readRefTarget,
  type WikiCleanupScanner,
  type WikiRepo,
  type WikiSource,
} from '@mtbot/agent-runtime'
import { createWikiVaultSyncDeps, removeWikiSourcesVaultArtifacts } from './wiki-vault-host'

const DEFAULT_WIKI_AGENT_ID = 'assistant'
const DEFAULT_WIKI_USER_ID = 'local-user'

/**
 * 构造资料底层文件存在性检查器（可解引用 .lumii-ref）。
 */
export function createWikiSourceFileExistsChecker(workspaceRoot?: string) {
  const deps = createWikiVaultSyncDeps(workspaceRoot)
  return (source: WikiSource) =>
    resolveWikiSourceFileExists(source, {
      fileExists: (absPath) => deps.fs.exists(absPath),
      readRefTarget: (refAbs) => readRefTarget(deps.fs, refAbs),
      toAbsPath: (relOrAbs) => deps.toAbsPath(relOrAbs),
    })
}

/**
 * 扫描并删除来源已失效的 Wiki 资料，同步清理 vault 侧车。
 */
export function purgeBrokenWikiSourcesOnDisk(
  wikiRepo: WikiRepo,
  wikiCleanupScanner: WikiCleanupScanner,
  workspaceRoot?: string,
  agentId = DEFAULT_WIKI_AGENT_ID,
  userId = DEFAULT_WIKI_USER_ID,
): { deleted: number; titles: readonly string[] } {
  const sourceFileExists = createWikiSourceFileExistsChecker(workspaceRoot)
  const result = purgeBrokenWikiSources(
    wikiRepo,
    wikiCleanupScanner,
    agentId,
    userId,
    {
      sourceFileExists: (source) => {
        const exists = sourceFileExists(source)
        return exists ?? true
      },
    },
    (sources) => {
      removeWikiSourcesVaultArtifacts(sources)
    },
  )
  return {
    deleted: result.deleted,
    titles: result.sources.map((s) => s.title),
  }
}

/**
 * 格式化定时任务运行摘要。
 */
export function formatWikiBrokenSourcePurgeSummary(deleted: number, titles: readonly string[]): string {
  if (deleted === 0) return 'skipped: 无失效引用'
  const preview = titles.slice(0, 5).join('、')
  const suffix = titles.length > 5 ? ` 等 ${titles.length} 条` : ''
  return `executed: 已删除 ${deleted} 条失效引用（${preview}${suffix}）`
}
