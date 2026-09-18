export type PluginId = 'cloak-browser'
export type PluginCategory = 'browser' | 'memory' | 'other'

export type PluginDef = {
  id: PluginId
  name: string
  description: string
  icon: string
  category: PluginCategory
  installSize?: string
  features?: string[]
}

/**
 * 插件注册表。
 *
 * 记忆宫殿曾作为 MemPalace 插件在此登记（Python + chromadb，~300MB）。
 * 2026-09-18 换成本地 SQLite 自研实现后**不再是插件**——没有安装、没有运行时、
 * 没有远端下载，数据直接落在应用自己的 `agent-runtime.db` 里。所以从这里移除，
 * 它的数据面板在「记忆」页（见 `pages/MemoriesPage/PalaceViewer.tsx`）。
 *
 * `memory` 分类保留在 `CATEGORY_LABELS` 里：将来若有真·记忆类插件仍可用。
 */
export const PLUGIN_REGISTRY: PluginDef[] = [
  {
    id: 'cloak-browser',
    name: '反检测浏览器',
    description: '基于 Chromium C++ 源码级补丁的反检测浏览器，绕过 Cloudflare、reCAPTCHA 等反爬检测，14 项测试全部通过。',
    icon: '🛡️',
    category: 'browser',
    installSize: '~200 MB',
    features: ['reCAPTCHA v3 得分 0.9', 'Cloudflare Turnstile 直接放行', '14 项反检测测试全通过'],
  },
]

export const CATEGORY_LABELS: Record<PluginCategory, string> = {
  browser: '浏览器',
  memory: '记忆',
  other: '其他',
}
