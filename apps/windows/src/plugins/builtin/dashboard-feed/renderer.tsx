import type { RendererPlugin } from '../../api'
import { NewsFeed } from './ui/NewsFeed'

/**
 * 首页信息流的渲染层半边：概览页顶部整宽的资讯卡。
 *
 * 卡片由插件在 setup 里注册到 `dashboard.main`（与内置卡片同一个 slot），
 * 插件停用后条目被注销 —— 概览页自然少一张卡，而不是留一张报错的空卡。
 */
export const dashboardFeedRenderer: RendererPlugin = {
  id: 'com.lumii.dashboard-feed',
  setup(api) {
    return api.registerSlot('dashboard.main', {
      id: 'builtin.news-feed',
      component: NewsFeed,
      order: 10,
      owner: 'com.lumii.dashboard-feed',
    })
  },
}
