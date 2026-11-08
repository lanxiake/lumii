/**
 * 插件按**功能**分组。
 *
 * 插件页原先只分「内置 / 外部」——那是按**来源**分的，用户找「语音相关的插件」
 * 时仍要从二十多张卡片里翻。这里补一层功能维度。
 *
 * 用 id 前缀推导而不是让每个插件在 manifest 里声明：几十个插件都要改一遍 manifest
 * 才能生效，而分类纯属展示，改错了只是分组难看。外部插件（id 由作者定）匹配不到
 * 时归入「其他」，不会消失。
 */

export type PluginCategoryId =
  | 'voice'
  | 'channel'
  | 'assistant'
  | 'media'
  | 'system'
  | 'develop'
  | 'other'

export interface PluginCategory {
  id: PluginCategoryId
  label: string
  /** 组的展示顺序 */
  order: number
}

export const PLUGIN_CATEGORIES: readonly PluginCategory[] = [
  { id: 'voice', label: '语音', order: 10 },
  { id: 'channel', label: '消息渠道', order: 20 },
  { id: 'assistant', label: '助手能力', order: 30 },
  { id: 'media', label: '媒体与文件', order: 40 },
  { id: 'develop', label: '开发工具', order: 50 },
  { id: 'system', label: '系统与维护', order: 60 },
  { id: 'other', label: '其他', order: 90 },
]

/**
 * 前缀规则。**顺序有讲究**：`com.lumii.tts.*` 必须先于更宽泛的 `com.lumii.*` 命中，
 * 所以用精确前缀数组而不是正则 split。
 */
const RULES: ReadonlyArray<{ prefix: string; category: PluginCategoryId }> = [
  // 语音：合成引擎（tts.*）与语音服务本体
  { prefix: 'com.lumii.tts.', category: 'voice' },
  { prefix: 'com.lumii.voice', category: 'voice' },
  // 消息渠道
  { prefix: 'com.lumii.channel-', category: 'channel' },
  { prefix: 'com.lumii.pcwechat', category: 'channel' },
  { prefix: 'com.lumii.relay', category: 'channel' },
  // 助手能力：自主进化、技能、提示词、桌宠、概览
  { prefix: 'com.lumii.autonomous', category: 'assistant' },
  { prefix: 'com.lumii.skill-evolution', category: 'assistant' },
  { prefix: 'com.lumii.prompt-style', category: 'assistant' },
  { prefix: 'com.lumii.pet', category: 'assistant' },
  { prefix: 'com.lumii.dashboard-feed', category: 'assistant' },
  { prefix: 'com.lumii.pipeline', category: 'assistant' },
  // 媒体与文件
  { prefix: 'com.lumii.code2video', category: 'media' },
  { prefix: 'com.lumii.screen-record', category: 'media' },
  { prefix: 'com.lumii.file-preview', category: 'media' },
  { prefix: 'com.lumii.selection', category: 'media' },
  // 开发工具
  { prefix: 'com.lumii.reverse', category: 'develop' },
  { prefix: 'com.lumii.browser', category: 'develop' },
  { prefix: 'com.lumii.vcs', category: 'develop' },
  // 系统与维护
  { prefix: 'com.lumii.updater', category: 'system' },
  { prefix: 'com.lumii.usage', category: 'system' },
  { prefix: 'com.lumii.perf', category: 'system' },
  { prefix: 'com.lumii.cloud-sync', category: 'system' },
  { prefix: 'com.lumii.event-logger', category: 'system' },
  { prefix: 'com.lumii.hello', category: 'system' },
]

/** 依插件 id 判定功能分类；匹配不到归「其他」 */
export function categoryOfPlugin(id: string): PluginCategoryId {
  for (const rule of RULES) {
    if (id.startsWith(rule.prefix)) return rule.category
  }
  return 'other'
}

export function categoryLabel(id: PluginCategoryId): string {
  return PLUGIN_CATEGORIES.find((c) => c.id === id)?.label ?? '其他'
}
