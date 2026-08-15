/**
 * 定时任务推送内容的渠道适配格式化（策略模式）。
 *
 * Agent 的回复是 Markdown，但下游渠道没有一个能原样渲染它：
 * - Windows 通知：纯文本，行数极有限，Markdown 记号会原样显示成噪声
 * - 飞书 text 消息：纯文本，不解析 Markdown，但保留换行
 * - 概览页资讯卡片：标题 + 摘要两个纯文本槽位，卡片高度固定
 * - 记忆条目：单行陈述句，越短越可复用
 *
 * 每个渠道一个策略对象，派发时按 notify_targets 从注册表里取对应策略 ——
 * 只加载命中的那一个，不把全部渠道的格式规则堆到一处。
 * 新增渠道只需往 NOTIFY_STRATEGIES 里加一项，dispatchNotifications 不用改。
 *
 * ponytail: 正则降级，不上完整 Markdown AST —— 推送正文只需可读，不需要保真。
 */

/** 策略产出。资讯卡片需要标题 + 摘要两个槽位，其余渠道只用 body。 */
export interface FormattedPayload {
  /** 渠道正文 */
  body: string
  /** 卡片类渠道的标题槽位 */
  title?: string
}

/** 渠道格式化策略。label 是任务名，用作来源标签。 */
export interface NotifyFormatStrategy {
  /** 正文长度上限，超出截断 */
  readonly limit: number
  format(label: string, output: string): FormattedPayload
}

/**
 * Markdown 降级为纯文本。
 * 保留段落换行（渠道里换行是可读性的主要来源），去掉所有装饰记号。
 */
export function markdownToPlainText(md: string): string {
  return md
    // 代码块：留内容去围栏，围栏行本身是噪声
    .replace(/```[a-zA-Z0-9]*\n?/g, '')
    .replace(/`([^`]+)`/g, '$1')
    // 图片先于链接处理，否则 ![alt](url) 会剩一个孤立的 !
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 链接保留文字：URL 在通知里点不了，只占地方
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 行首记号统一用 [ \t]* 而非 \s* —— \s 含换行，会把上一个空行一起吃掉，
    // 段落间距是纯文本渠道唯一的结构信息，不能丢
    // 标题记号
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    // 引用记号
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    // 无序列表 → 顿点，保留「这是一条」的视觉信息
    .replace(/^[ \t]*[-*+][ \t]+/gm, '· ')
    // 有序列表保留编号
    .replace(/^[ \t]*(\d+)[.)][ \t]+/gm, '$1. ')
    // 粗体/斜体/删除线
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    // 表格分隔行（|---|---|）与水平分隔线：连着换行一起删，
    // 只把行内容清空会留下一个空行，读起来像段落断开了
    .replace(/^[ \t]*\|?[ \t:|-]*-{3,}[ \t:|-]*\|?[ \t]*\n?/gm, '')
    // 表格竖线转分隔符，表格在纯文本里没法对齐，至少让单元格可读
    .replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_m, row: string) =>
      row.split('|').map((c) => c.trim()).filter(Boolean).join(' | '),
    )
    // 行尾空白 + 三个以上连续换行压成两个
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 按 max 截断，尽量断在句末标点上，避免话说半句。 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  const head = text.slice(0, max)
  // 在后 1/3 区间里找最后一个句末标点，找不到就硬截
  const cut = Math.max(
    head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'),
    head.lastIndexOf('\n'), head.lastIndexOf('. '),
  )
  return cut > max * 0.6 ? head.slice(0, cut + 1) : `${head.trimEnd()}…`
}

/** 压成单行：通知气泡与记忆条目里换行只会浪费可见长度。 */
function toSingleLine(text: string): string {
  return text.replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

/** 资讯卡片标题槽位上限，单行 */
const NEWS_TITLE_LIMIT = 40

/**
 * 渠道 → 格式化策略。键与 local_cron_jobs.notify_targets 的取值一致。
 */
export const NOTIFY_STRATEGIES: Record<string, NotifyFormatStrategy> = {
  /** Windows 通知气泡再长也不会完整显示，压单行并短截 */
  system: {
    limit: 180,
    format(label, output) {
      return {
        title: `灵栖 · ${label}`,
        body: truncate(toSingleLine(markdownToPlainText(output)), this.limit),
      }
    },
  },

  /** 飞书 text 消息：纯文本、保留换行，带任务名前缀便于区分来源 */
  feishu: {
    limit: 1500,
    format(label, output) {
      return { body: `【${label}】\n${truncate(markdownToPlainText(output), this.limit)}` }
    },
  },

  /** 微信主动推送：与飞书同级纯文本（经 ChannelOutboundRouter） */
  weixin: {
    limit: 1500,
    format(label, output) {
      return { body: `【${label}】\n${truncate(markdownToPlainText(output), this.limit)}` }
    },
  },

  /** 概览页资讯卡片：标题取任务名，摘要取正文，均为单行纯文本 */
  news: {
    limit: 200,
    format(label, output) {
      return {
        title: truncate(toSingleLine(label), NEWS_TITLE_LIMIT),
        body: truncate(toSingleLine(markdownToPlainText(output)), this.limit),
      }
    },
  },

  /** 记忆条目：单行陈述句，前缀任务名以便日后追溯来源 */
  focus: {
    limit: 300,
    format(label, output) {
      const body = toSingleLine(markdownToPlainText(output))
      return { body: truncate(`${label}：${body}`, this.limit) }
    },
  },
}

/**
 * 取渠道策略并格式化。支持 `weixin:<peerId>` 前缀语法（策略键取冒号前）。
 * 未注册的渠道回落纯文本单行。
 */
export function formatForTarget(target: string, label: string, output: string): FormattedPayload {
  const base = target.includes(':') ? target.slice(0, target.indexOf(':')) : target
  const strategy = NOTIFY_STRATEGIES[base]
  if (strategy) return strategy.format(label, output)
  return { body: truncate(toSingleLine(markdownToPlainText(output)), 500) }
}
