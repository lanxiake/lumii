/** 与 agent-runtime WIKI_CONSOLIDATE_TITLE_PREFIX 保持一致 */
export const WIKI_CONSOLIDATE_TITLE_PREFIX = '[整合] '

/** 整合长文统一归档小类（各大类下共用） */
export const WIKI_CONSOLIDATE_SUBTOPIC = '整合长文'

/** 低于此字数视为「短文」，适合整合 */
export const SHORT_SOURCE_MAX_CHARS = 800

/** 同目录下至少多少篇短文才提示可整合 */
export const CONSOLIDATE_HINT_MIN_COUNT = 3

/** 手动整合至少选几篇 */
export const CONSOLIDATE_MIN_SELECTION = 2

export interface WikiConsolidateTarget {
  readonly category: string
  readonly subtopic: string
}

/**
 * 判断合成候选是否为「整合短文」类型。
 */
export function isConsolidateSynthesis(title: string): boolean {
  return title.startsWith(WIKI_CONSOLIDATE_TITLE_PREFIX)
}

/**
 * 去掉整合标题前缀用于展示。
 */
export function displaySynthesisTitle(title: string): string {
  return title.startsWith(WIKI_CONSOLIDATE_TITLE_PREFIX)
    ? title.slice(WIKI_CONSOLIDATE_TITLE_PREFIX.length)
    : title
}

/**
 * 从当前导航解析整合长文的统一归档目录：{大类} / 整合长文。
 */
export function resolveConsolidateTarget(
  nav: { kind: string; category?: string; name?: string },
): WikiConsolidateTarget | null {
  if (nav.kind === 'subtopic' && nav.category) {
    return { category: nav.category, subtopic: WIKI_CONSOLIDATE_SUBTOPIC }
  }
  if (nav.kind === 'category' && nav.name) {
    return { category: nav.name, subtopic: WIKI_CONSOLIDATE_SUBTOPIC }
  }
  return null
}

/**
 * 判断资料正文是否偏短（无正文时按标题长度估算）。
 */
export function isShortSource(textLength: number, titleLength: number): boolean {
  const effective = textLength > 0 ? textLength : titleLength
  return effective < SHORT_SOURCE_MAX_CHARS
}

/**
 * 统计目录内短文数量。
 */
export function countShortSources(
  items: ReadonlyArray<{ readonly textLength?: number; readonly title: string }>,
): number {
  return items.filter((item) =>
    isShortSource(item.textLength ?? 0, item.title.length),
  ).length
}

/** 轮询间隔（毫秒） */
const SYNTHESIS_POLL_MS = 1500

/** 最长等待生成完成（毫秒，约 15 分钟） */
const SYNTHESIS_POLL_MAX_MS = 15 * 60 * 1000

/**
 * 等待整合候选生成完成；失败或超时返回 null。
 */
export async function waitForSynthesisReady(
  getSynthesis: (id: string) => Promise<{
    progress: { chunk: number; total: number } | null
    outputPath: string | null
    error: string | null
  } | null>,
  synthesisId: string,
): Promise<'ready' | 'failed' | 'timeout'> {
  const deadline = Date.now() + SYNTHESIS_POLL_MAX_MS
  while (Date.now() < deadline) {
    const row = await getSynthesis(synthesisId)
    if (!row) return 'failed'
    if (row.error && row.error !== 'truncated') return 'failed'
    if (row.progress === null && row.outputPath) return 'ready'
    await new Promise((r) => setTimeout(r, SYNTHESIS_POLL_MS))
  }
  return 'timeout'
}
