/**
 * 「这个设置分区归哪个插件」——分区内容由插件通过槽位注册，入口由这里按启停过滤。
 *
 * 只登记**整块归插件**的分区。混合分区（如「渠道」里既有核心的模型配置、又有渠道插件的
 * 连接卡片）不在此列，那些用分区内部的子槽位处理。
 *
 * 新增：插件注册 `settings.category.<id>` 槽位，并在下面加一行。
 */
export const PLUGIN_SETTINGS_CATEGORIES: Readonly<Record<string, string>> = {
  usage: 'com.lumii.usage',
  voice: 'com.lumii.voice',
}

/**
 * 按插件启停过滤设置分类（整页导航与 Hub 导航共用同一判据）。
 *
 * 抽成纯函数是为了能测：两处导航各写一遍「哪些分类归插件」迟早分叉，
 * 症状是「整页里看不见、Hub 里还点得进去」。
 */
export function filterPluginCategories<T extends { id: string }>(
  items: readonly T[],
  isPluginEnabled: (pluginId: string) => boolean,
): T[] {
  return items.filter((item) => {
    const owner = PLUGIN_SETTINGS_CATEGORIES[item.id]
    return !owner || isPluginEnabled(owner)
  })
}
