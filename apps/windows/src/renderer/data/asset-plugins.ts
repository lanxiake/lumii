import type { SettingsHubTab } from '../components/SettingsHub/types'

/**
 * 运行时组件（资产插件）注册表。
 *
 * 判据：**有下载、有运行时、可卸载 = 运行时组件**。它们不是代码扩展：
 * 这里登记的是二进制/模型/外部服务，装完由对应功能使用。
 *
 * 与「代码扩展」（设置 › 代码扩展）的关系用 `usedBy` 表达：卡片上显示
 * 「用于：…」，能定位到某个页签时可直接跳过去。
 *
 * 记忆宫殿曾作为 MemPalace 插件在此登记（Python + chromadb，~300MB）。
 * 2026-09-18 换成本地 SQLite 自研实现后**不再是组件**——没有安装、没有运行时、
 * 没有远端下载，数据直接落在应用自己的 `agent-runtime.db` 里。
 */

export type PluginId =
  | 'cloak-browser'
  | 'ffmpeg'
  | 'wechat-mcp'
  | 'pet:demo_cartoon_cat'
  | 'pet:ug_official'
  | 'pet:xiaomai'
export type PluginCategory = 'browser' | 'comm' | 'media' | 'pet' | 'memory' | 'other'

export interface AssetUsedBy {
  label: string
  /** 能直接定位到某个 Hub 页签时才给；否则只显示文字 */
  tab?: SettingsHubTab
}

export type PluginDef = {
  id: PluginId
  name: string
  description: string
  icon: string
  category: PluginCategory
  installSize?: string
  features?: string[]
  /** 哪些功能在用这个组件（设置页展示，可选跳转） */
  usedBy?: AssetUsedBy[]
}

export const PLUGIN_REGISTRY: PluginDef[] = [
  {
    id: 'cloak-browser',
    name: '反检测浏览器',
    description:
      '基于 Chromium C++ 源码级补丁的反检测浏览器，绕过 Cloudflare、reCAPTCHA 等反爬检测，14 项测试全部通过。',
    icon: '🛡️',
    category: 'browser',
    installSize: '~200 MB',
    features: ['reCAPTCHA v3 得分 0.9', 'Cloudflare Turnstile 直接放行', '14 项反检测测试全通过'],
    usedBy: [{ label: '浏览器控制工具', tab: 'tools' }],
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
    // 未安装时扩展会回退到包内/系统 PATH 的 ffmpeg，所以是可选依赖
    usedBy: [{ label: '录屏扩展', tab: 'extensions' }],
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
    usedBy: [{ label: '微信渠道与 MCP 工具' }],
  },
  {
    id: 'pet:demo_cartoon_cat',
    name: '宠物 · 团子（卡通猫）',
    description: '像素风卡通猫宠物，含待机 / 跳跃 / 点击等动作与表情。按需下载（约 35 MB）。',
    icon: '🐱',
    category: 'pet',
    installSize: '~35 MB',
    features: ['像素卡通猫形象', '完整动作与表情'],
    usedBy: [{ label: '桌宠形象' }],
  },
  {
    id: 'pet:ug_official',
    name: '宠物 · UG',
    description: 'Live2D 官方示例角色。按需下载（约 3 MB）。',
    icon: '🐾',
    category: 'pet',
    installSize: '~3 MB',
    usedBy: [{ label: '桌宠形象' }],
  },
  {
    id: 'pet:xiaomai',
    name: '宠物 · 小麦',
    description: 'Live2D 角色「小麦」。按需下载（约 3 MB）。',
    icon: '🌾',
    category: 'pet',
    installSize: '~3 MB',
    usedBy: [{ label: '桌宠形象' }],
  },
]

export const CATEGORY_LABELS: Record<PluginCategory, string> = {
  browser: '浏览器',
  comm: '通讯',
  media: '媒体',
  pet: '宠物',
  memory: '记忆',
  other: '其他',
}
