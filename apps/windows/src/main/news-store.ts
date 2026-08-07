/**
 * 本地资讯抓取与存储（概览页「最近资讯」数据源）
 *
 * 抓取：硬编码国内免费 RSS 白名单，不接受外部传入 URL —— 定时任务只能抓这几个站，
 *       避免变成一个可被 prompt 操纵的任意 URL 请求器（SSRF）。
 * 存储：`~/.lumii/news/latest.json` 覆盖写。概览只需要「最新一批」，不做历史留存，
 *       所以不像 usage-store 那样按月 JSONL 追加。
 * 解析：正则抽 `<item>` 字段。源固定且都是标准 RSS 2.0，为此引一个 XML 解析依赖不值。
 *
 * ponytail: 正则解析 + 覆盖写；换成结构复杂的 Atom 源再上真正的 XML 解析。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { resolveWindowsClientDataRoot } from './client-data-root'
import {
  readDashboardFeedSnapshot,
  writeDashboardFeedSnapshot,
  type DashboardFeedSnapshot,
} from './dashboard-feed-store'

const log = {
  info: (...a: unknown[]) => console.log('[NewsStore]', ...a),
  warn: (...a: unknown[]) => console.warn('[NewsStore]', ...a),
  error: (...a: unknown[]) => console.error('[NewsStore]', ...a),
}

/** 资讯源白名单（国内免费 RSS，均为 UTF-8 标准 RSS 2.0） */
const SOURCES: ReadonlyArray<{ name: string; url: string }> = [
  { name: 'IT之家', url: 'https://www.ithome.com/rss/' },
  { name: '少数派', url: 'https://sspai.com/feed' },
]

/** 每个源最多取几条，两源合并后再按时间截断到 MAX_ITEMS */
const PER_SOURCE_LIMIT = 12
const MAX_ITEMS = 20
/** 抓取超时。定时任务不该被慢源拖住 */
const FETCH_TIMEOUT_MS = 15_000
/** 摘要截断长度：卡片最多两行，再长也显示不出来 */
const EXCERPT_LEN = 110

/** 一条资讯 */
export interface NewsItem {
  /** 原文链接，同时作为去重主键 */
  id: string
  title: string
  link: string
  /** 来源站点名，如「IT之家」 */
  source: string
  /** 发布时刻（epoch ms）；解析失败时为抓取时刻 */
  pubTs: number
  /** 正文摘要（已剥 HTML 标签） */
  excerpt: string
}

/** 存盘结构 */
export interface NewsSnapshot {
  /** 抓取完成时刻（epoch ms） */
  fetchedAt: number
  items: NewsItem[]
  /** AI 对这批资讯的整体综述；未生成或生成失败时缺省 */
  digest?: string
}

function toDashboardFeedSnapshot(snapshot: NewsSnapshot): DashboardFeedSnapshot {
  return {
    feedId: 'news',
    title: '最近资讯',
    updatedAt: snapshot.fetchedAt,
    ...(snapshot.digest ? { summary: snapshot.digest } : {}),
    items: snapshot.items.map((item) => ({
      id: item.id,
      title: item.title,
      ...(item.excerpt ? { summary: item.excerpt } : {}),
      href: item.link,
      source: item.source,
      timestamp: item.pubTs,
      kind: 'news',
    })),
  }
}

function newsDir(): string {
  return path.join(resolveWindowsClientDataRoot(), 'news')
}

function snapshotPath(): string {
  return path.join(newsDir(), 'latest.json')
}

// ── RSS 解析 ──

const ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
  '&amp;': '&',
}

/** 解 XML/HTML 实体。&amp; 必须最后解，否则 &amp;lt; 会被二次解码成 < */
function decodeEntities(s: string): string {
  let out = s.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
  for (const [entity, char] of Object.entries(ENTITIES)) {
    if (entity === '&amp;') continue
    out = out.split(entity).join(char)
  }
  return out.split('&amp;').join('&')
}

/** 取出 CDATA 或纯文本内容 */
function textOf(itemXml: string, tag: string): string {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(itemXml)
  if (!m) return ''
  const raw = m[1].trim()
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(raw)
  return (cdata ? cdata[1] : raw).trim()
}

/** 剥掉所有 HTML 标签并压缩空白。资讯摘要只在 UI 里当纯文本渲染 */
function stripTags(html: string): string {
  return decodeEntities(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseRss(xml: string, source: string, now: number): NewsItem[] {
  const items: NewsItem[] = []
  for (const m of xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/g)) {
    const chunk = m[1]
    const link = decodeEntities(textOf(chunk, 'link'))
    const title = decodeEntities(textOf(chunk, 'title'))
    if (!link || !title) continue
    const pub = Date.parse(textOf(chunk, 'pubDate'))
    items.push({
      id: link,
      title,
      link,
      source,
      pubTs: Number.isNaN(pub) ? now : pub,
      excerpt: stripTags(textOf(chunk, 'description')).slice(0, EXCERPT_LEN),
    })
    if (items.length >= PER_SOURCE_LIMIT) break
  }
  return items
}

// ── 抓取 ──

async function fetchSource(
  source: { name: string; url: string },
  now: number,
): Promise<NewsItem[]> {
  try {
    const res = await fetch(source.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 Lumii/1.0' },
    })
    if (!res.ok) {
      log.warn(`${source.name} 返回 ${res.status}，跳过`)
      return []
    }
    return parseRss(await res.text(), source.name, now)
  } catch (err) {
    log.warn(`${source.name} 抓取失败，跳过:`, err)
    return []
  }
}

/**
 * 抓取全部白名单源并按发布时间倒序合并。
 * 单源失败不影响其他源；全部失败返回空数组，由调用方决定是否保留旧快照。
 */
export async function fetchLatestNews(): Promise<NewsItem[]> {
  const now = Date.now()
  const batches = await Promise.all(SOURCES.map((s) => fetchSource(s, now)))
  const seen = new Set<string>()
  return batches
    .flat()
    .filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)))
    .sort((a, b) => b.pubTs - a.pubTs)
    .slice(0, MAX_ITEMS)
}

// ── 读写快照 ──

export async function readNewsSnapshot(): Promise<NewsSnapshot | null> {
  const snapshot = await readDashboardFeedSnapshot('news')
  if (!snapshot) return null
  return {
    fetchedAt: snapshot.updatedAt,
    items: snapshot.items.map((item) => ({
      id: item.id,
      title: item.title,
      link: item.href ?? '',
      source: item.source ?? '未知来源',
      pubTs: item.timestamp ?? snapshot.updatedAt,
      excerpt: item.summary ?? '',
    })),
    ...(snapshot.summary ? { digest: snapshot.summary } : {}),
  }
}

async function writeNewsSnapshot(snap: NewsSnapshot): Promise<void> {
  // Dashboard 使用规范化 feed；旧路径继续写，兼容已有诊断脚本和旧版本客户端。
  await writeDashboardFeedSnapshot(toDashboardFeedSnapshot(snap))
  await fs.mkdir(newsDir(), { recursive: true })
  await fs.writeFile(snapshotPath(), JSON.stringify(snap, null, 2), 'utf-8')
}

// ── 流水线：抓取 → AI 综述 → 落盘 ──

/** 综述只喂标题，不喂正文：一次调用就够，也不会把整批 HTML 塞进上下文 */
function buildDigestPrompt(items: readonly NewsItem[]): string {
  const list = items
    .slice(0, 10)
    .map((it, i) => `${i + 1}. [${it.source}] ${it.title}`)
    .join('\n')
  return [
    '下面是刚抓取到的科技资讯标题，请用中文写一段不超过 120 字的综述，',
    '点出这批资讯里最值得关注的 1-2 个趋势。只输出综述正文，不要标题、不要列表、不要客套话。',
    '',
    list,
  ].join('\n')
}

export interface NewsPipelineDeps {
  /** 生成综述用的 LLM 调用；不传则跳过综述 */
  callLLM?: (prompt: string, purpose: string) => Promise<string>
}

/**
 * 跑一次资讯流水线：抓取 → 综述 → 落盘。
 * @returns 执行结果描述（定时任务会把它写进 cron_runs.summary）
 */
export async function runNewsPipeline(deps: NewsPipelineDeps = {}): Promise<string> {
  const items = await fetchLatestNews()
  if (items.length === 0) {
    // 全部源都失败时保留上一次快照，概览页不会突然空掉
    return 'skipped: 所有资讯源均抓取失败，保留上一批数据'
  }

  let digest: string | undefined
  if (deps.callLLM) {
    try {
      const text = await deps.callLLM(buildDigestPrompt(items), 'news_digest')
      digest = text.trim() || undefined
    } catch (err) {
      log.warn('生成资讯综述失败（仅缺综述，资讯照常入库）:', err)
    }
  }

  await writeNewsSnapshot({ fetchedAt: Date.now(), items, ...(digest ? { digest } : {}) })
  log.info(`资讯流水线完成：${items.length} 条，综述${digest ? '已生成' : '未生成'}`)
  return `executed: 抓取 ${items.length} 条资讯${digest ? '，已生成综述' : ''}`
}

// ── 定时任务接线 ──

/**
 * 资讯流水线的魔法指令。
 * 走 cron 的 companion 拦截通道：任务文本命中它就跑流水线，返回值落 cron_runs.summary，
 * 于是「定时任务」页面能直接看到每次抓取的结果，不需要另造一套运行记录。
 */
export const NEWS_PIPELINE_INSTRUCTION = '__lumii_workflow__:news'
/** 旧版本已经写入数据库的 task_text，升级时继续识别。 */
export const LEGACY_NEWS_PIPELINE_INSTRUCTION = '__news_pipeline__'

/** 旧版本 ensureNewsCronJobSeeded 的哨兵键，播种逻辑已并入 seed-cron-jobs.ts。 */
export const LEGACY_NEWS_CRON_SEEDED_KEY = 'workflow:news:seeded'

/** 仅供单测：解析逻辑不走网络也要能验 */
export const __testables = { parseRss, stripTags, decodeEntities }
