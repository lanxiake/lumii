export type PluginId = 'cloak-browser' | 'ffmpeg' | 'wechat-mcp'
export type PluginCategory = 'browser' | 'comm' | 'media' | 'memory' | 'other'

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
  {
    id: 'ffmpeg',
    name: '本地媒体处理',
    description:
      '本地音视频处理引擎：录制屏幕导出 MP4、旁白混流、烧字幕等。按需下载（约 62 MB，走国内镜像），装完重启后生效。',
    icon: '🎬',
    category: 'media',
    installSize: '~62 MB',
    features: ['录屏导出 MP4', '旁白混流 / 烧字幕'],
  },
  {
    id: 'wechat-mcp',
    name: '微信本机助手',
    description:
      '以你本人身份读写本机微信：会话 / 历史 / 检索，发消息·文件·引用·群发，以及画像蒸馏。按需下载（约 37 MB），装完自动接入 MCP。',
    icon: '💬',
    category: 'comm',
    installSize: '~37 MB',
    features: ['读取本机微信会话与历史', '以本人身份发送消息 / 文件 / 引用', '本地画像蒸馏'],
  },
]

export const CATEGORY_LABELS: Record<PluginCategory, string> = {
  browser: '浏览器',
  comm: '通讯',
  media: '媒体',
  memory: '记忆',
  other: '其他',
}
