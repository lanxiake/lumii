import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../kernel/events'

/**
 * 微信个人号渠道扩展。
 *
 * ## 架构定位
 *
 * 内建插件,可禁用。禁用后:
 * - 微信个人号消息不再接收与处理
 * - 微信渠道的斜杠命令不可用
 * - 微信会话绑定与路由失效
 *
 * ## 依赖与时序
 *
 * - **Bridge**: 通过 bridge 驱动回合、管理会话、路由消息
 * - **WeixinLoginService**: 微信扫码登录与消息收发服务
 * - **AcpBackendManager**: ACP 后端路由（微信独有,用于 /backend 命令切换后端）
 * - **WeixinReplyContextStore**: 入站消息上下文缓存（供 channel_send 伪 Push）
 * - **激活时机**: 等 `app:ready`（bridge 在 S7 初始化,适配器在 S8 阶段构造）
 *
 * ## 核心逻辑
 *
 * 1. **适配器** (`weixin-channel-adapter.ts`):
 *    - 实现 `IChannelAdapter` 接口（`handleMessage` / `getContextStrategy` 等）
 *    - 在构造末尾调用 `registerChannelAdapter(this)` 自注册到全局注册表
 *    - 消息串行化处理（按 channelUserId 队列）
 *
 * 2. **消息处理流程**:
 *    - `WeixinLoginService` 监听入站消息 → `weixinChannelAdapter.handleMessage`
 *    - 路由决策（路由表 > /link 绑定 > 渠道默认）→ 获取会话上下文
 *    - 斜杠命令识别（`/new` / `/clear` / `/backend` 等）→ 执行命令或驱动 Agent 回合
 *    - 回合结束 → 发送回复（调用 `WeixinLoginService.sendMessage`）
 *
 * 3. **会话绑定** (`WeixinSessionBindingManager`):
 *    - `/link` 命令：将微信会话绑定到 Agent 会话
 *    - `/unlink` 命令：解除绑定
 *    - 绑定持久化在 `~/.lumii/channel/weixin-session-bindings.json`
 *
 * 4. **ACP 后端路由** (`AcpBackendManager`):
 *    - `/backend` 命令：切换后端（仅微信渠道支持）
 *    - `/lumii` 命令：切回默认后端
 *
 * ## 禁用的实现（启动期状态门）
 *
 * 适配器构造留在 `index.ts`（S8），但整段包在
 * `isExtensionActive('com.lumii.channel-weixin')` 里：插件被禁用时**登录服务也不建**，
 * 于是既没有连接、也没有适配器。Hub 侧传 `weixin: undefined`，该渠道不进 registry，
 * 出站得到稳定的 `CHANNEL_NOT_CONNECTED`。
 *
 * 仍是启动期判定：设置里改开关要重启才生效。
 *
 * **运行期启停做不到**：适配器在构造函数末尾自注册到全局注册表，
 * 而 `registerChannelAdapter` 没有对应的 `unregister`；且 `startListening()`
 * 与 LoginService 的 `message` 事件是建连时挂上的。
 */
export const channelWeixinExtension = {
  manifest: {
    id: 'com.lumii.channel-weixin',
    name: '微信个人号渠道',
    version: '0.1.0',
    description: '微信个人号消息收发、会话路由、斜杠命令（/new /clear /link /backend 等）',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.channel-weixin',
    provides: ['channel-weixin'],
    apply(ctx) {
      // 构造点在 `index.ts`（依赖登录服务、bridge、ACP 管理器，都在那里初始化），
      // 那边按 `isExtensionActive('com.lumii.channel-weixin')` 决定装不装。

      ctx.log.info('微信个人号渠道插件已加载（适配器由 index.ts 按插件状态装配）')
    },
  }),
}
