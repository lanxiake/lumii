import type { RendererPlugin } from '../api/renderer'
import { dashboardFeedRenderer } from '../builtin/dashboard-feed/renderer'
import { usageRenderer } from '../builtin/usage/renderer'
import { channelWeixinRenderer } from '../builtin/channel-weixin/renderer'
import { channelWecomRenderer } from '../builtin/channel-wecom/renderer'
import { channelFeishuRenderer } from '../builtin/channel-feishu/renderer'
import { channelQbotRenderer } from '../builtin/channel-qbot/renderer'
import { voiceRenderer } from '../builtin/voice/renderer'

/**
 * 有渲染层半边的内置插件。
 *
 * **新增一个带 UI 的插件 = 建 `builtin/<name>/renderer.tsx`，在下面加一行。**
 * 主进程清单在 `plugins/registry.ts`，两处按 `id` 对齐；少了这边，开关一切
 * 只有后端生效、页面入口不消失（正是这次要修的毛病）。
 */
export const RENDERER_PLUGINS: readonly RendererPlugin[] = [
  usageRenderer,
  dashboardFeedRenderer,
  voiceRenderer,
  channelWeixinRenderer,
  channelWecomRenderer,
  channelFeishuRenderer,
  channelQbotRenderer,
]
