import type { RendererPlugin } from '../api/renderer'
import { dashboardFeedRenderer } from '../builtin/dashboard-feed/renderer'
import { usageRenderer } from '../builtin/usage/renderer'
import { channelWeixinRenderer } from '../builtin/channel-weixin/renderer'
import { channelWecomRenderer } from '../builtin/channel-wecom/renderer'
import { channelFeishuRenderer } from '../builtin/channel-feishu/renderer'
import { channelQbotRenderer } from '../builtin/channel-qbot/renderer'
import { pcwechatRenderer } from '../builtin/pcwechat/renderer'
import { autonomousRenderer } from '../builtin/autonomous/renderer'
import { screenRecordRenderer } from '../external-src/screen-record/renderer'
import { cloudSyncRenderer } from '../external-src/cloud-sync/renderer'
import { perfRenderer } from '../external-src/perf/renderer'
import { selectionRenderer } from '../builtin/selection/renderer'
import { updaterRenderer } from '../builtin/updater/renderer'
import { vcsRenderer } from '../builtin/vcs/renderer'
import { petRenderer } from '../builtin/pet/renderer'
import { voiceRenderer } from '../builtin/voice/renderer'

/**
 * 有渲染层半边的插件：内置 + 官方外部扩展（external-src）。
 *
 * **新增一个带 UI 的插件 = 建 `renderer.tsx`，在下面加一行。**
 * 主进程清单在 `plugins/registry.ts`，两处按 `id` 对齐；少了这边，开关一切
 * 只有后端生效、页面入口不消失。
 *
 * 官方外部扩展的 UI 目前**随主包打进 renderer bundle**（`external-src/<id>/renderer.tsx`），
 * 而不是通过 `client.js` 分发——外部扩展的 client 半边还不支持 TSX / 核心组件 / CSS Modules。
 * 运行时仍按插件启停挂载，未安装/禁用时条目不存在。
 */
export const RENDERER_PLUGINS: readonly RendererPlugin[] = [
  usageRenderer,
  dashboardFeedRenderer,
  voiceRenderer,
  channelWeixinRenderer,
  channelWecomRenderer,
  channelFeishuRenderer,
  channelQbotRenderer,
  pcwechatRenderer,
  vcsRenderer,
  petRenderer,
  autonomousRenderer,
  screenRecordRenderer,
  cloudSyncRenderer,
  perfRenderer,
  selectionRenderer,
  updaterRenderer,
]
