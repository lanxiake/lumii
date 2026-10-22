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
 * ## P1 vs P2
 *
 * - P1: 包装成插件,支持禁用/启用,核心逻辑不动（适配器在 `index.ts` L1633 构造,
 *   在构造函数末尾自注册到全局注册表）
 * - P2: 适配器构造与注册迁移到插件内（`ctx.provide(WEIXIN_ADAPTER)` +
 *   `ctx.on('app:ready', ...)` 启动监听），按需激活
 *
 * ## 为什么 P1 不做热插拔
 *
 * 微信适配器在 `index.ts` S8 阶段构造（L1633），依赖:
 * 1. `weixinLoginService` 在 S6 阶段初始化（L1600-1625）
 * 2. `agentRuntimeBridge` 在 S7 阶段初始化（L1490-1567）
 * 3. `weixinAcpBackendManager` / `weixinReplyContextStore` 在 S8 阶段构造（L1631-1632）
 * 4. 适配器构造后立即调用 `startListening()` 开始接收消息（隐式,通过 LoginService 的 message 事件）
 *
 * 要做真正的热插拔需要:
 * 1. 将适配器构造移到插件 `apply(ctx)`
 * 2. 将 `startListening()` 与 `stopListening()` 接入插件生命周期
 * 3. 支持运行时注销适配器（目前 `registerChannelAdapter` 无对应的 `unregister` API）
 *
 * P1 先做声明式包装,P2 再做执行期迁移。
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
      // 微信适配器实际构造在 `index.ts` L1633（S8 阶段），消息监听通过
      // `WeixinLoginService.on('message', ...)` 启动。本插件作为"声明式开关"存在:
      // - 启用时: 适配器正常构造并自注册到全局注册表
      // - 禁用时: P2 改造后在此处跳过适配器构造与注册
      //
      // P1 阶段禁用插件 = 代码不加载,但 `index.ts` 照旧执行,适配器照旧构造——
      // 所以 P1 禁用插件**不影响**微信渠道功能。
      //
      // 为什么不在这里 new WeixinChannelAdapter:
      // 1. 适配器依赖 weixinLoginService / bridge / acpBackendManager / replyContextStore,
      //    都在 index.ts 中初始化
      // 2. 适配器在构造函数末尾调用 `registerChannelAdapter(this)` 自注册,
      //    调用时机与 app:ready 时序耦合
      // 3. 移动构造点会破坏现有初始化顺序,且 registerChannelAdapter 缺 unregister API
      //
      // P1 目标: 包装 + 文档完善,不改行为; P2 才做真正的按需激活与热插拔。

      ctx.log.info('微信个人号渠道插件已加载（适配器由 index.ts 构造）')

      // P2: 禁用时注销适配器
      // ctx.effect(() => {
      //   unregisterChannelAdapter('weixin')
      //   weixinChannelAdapter?.stopListening()
      //   ctx.log.info('微信个人号渠道插件卸载,已注销适配器')
      // })
    },
  }),
}
