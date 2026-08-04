export type PluginId = 'cloak-browser' | 'mempalace'
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
  {
    id: 'mempalace',
    name: 'MemPalace 长期记忆',
    description: '基于语义搜索的结构化长期记忆系统，将对话和知识存入结构化记忆宫殿，支持 BM25 + 向量混合检索。',
    icon: '🧠',
    category: 'memory',
    installSize: '~300 MB',
    features: ['语义向量检索', 'BM25 关键字检索', '结构化 Wing/Room/Drawer 组织'],
  },
]

export const CATEGORY_LABELS: Record<PluginCategory, string> = {
  browser: '浏览器',
  memory: '记忆',
  other: '其他',
}
