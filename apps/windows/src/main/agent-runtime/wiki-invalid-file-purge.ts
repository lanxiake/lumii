/**
 * Wiki 不合规文件清理（Windows 宿主）：注入 vault 清理。
 */
import {
  purgeInvalidWikiFiles,
  listInvalidWikiFiles,
  type WikiRepo,
  type WikiSource,
} from '@mtbot/agent-runtime'
import { removeWikiSourcesVaultArtifacts } from './wiki-vault-host'

const DEFAULT_WIKI_AGENT_ID = 'assistant'
const DEFAULT_WIKI_USER_ID = 'local-user'

/**
 * 扫描并删除不符合摄入规则的 Wiki 资料（代码/脚本类文件），同步清理 vault 侧车。
 */
export function purgeInvalidWikiFilesOnDisk(
  wikiRepo: WikiRepo,
  workspaceRoot?: string,
  agentId = DEFAULT_WIKI_AGENT_ID,
  userId = DEFAULT_WIKI_USER_ID,
): { deleted: number; titles: readonly string[] } {
  const result = purgeInvalidWikiFiles(
    wikiRepo,
    agentId,
    userId,
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
export function formatWikiInvalidFilePurgeSummary(deleted: number, titles: readonly string[]): string {
  if (deleted === 0) return 'skipped: 无不合规文件'
  const preview = titles.slice(0, 5).join('、')
  const suffix = titles.length > 5 ? ` 等 ${titles.length} 条` : ''
  return `executed: 已删除 ${deleted} 条不合规文件（${preview}${suffix}）`
}
