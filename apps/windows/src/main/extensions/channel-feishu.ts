import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../kernel/events'

/**
 * 飞书渠道扩展。
 *
 * ## 架构定位
 *
 * 内建插件,可禁用。禁用后:
 * - 飞书机器人消息不再接收与处理
 * - 飞书渠道的斜杠命令不可用
 * - 飞书会话路由失效
 *
 * ## 依赖与时序
 *
 * - **Bridge**: 通过 bridge 驱动回合、管理会话、路由消息
 * - **FeishuLoginService**: 飞书扫码登录与消息收发服务
 * - **激活时机**: 等 `app:ready`（bridge 在 S7 初始化,适配器在 S8 阶段构造）
 *
 * ## 核心逻辑
 *
 * 1. **适配器** (`feishu-channel-adapter.ts`):
 *    - 实现 `IChannelAdapter` 接口（`handleMessage` / `getContextStrategy` 等）
 *    - 在构造末尾调用 `registerChannelAdapter(this)` 自注册到全局注册表
 *    - 消息串行化处理（按 channelUserId 队列）
 *
 * 2. **消息处理流程**:
 *    - `FeishuLoginService` 监听入站消息 → `feishuChannelAdapter.handleMessage`
 *    - 路由决策（路由表 > 渠道默认）→ 获取会话上下文
 *    - 斜杠命令识别（`/new` / `/clear` / `/resume` 等）→ 执行命令或驱动 Agent 回合
 *    - 回合结束 → 发送回复（调用 `FeishuLoginService.sendMessage`）
 *
 * 3. **语音消息处理**:
 *    - 飞书语音消息（opus 格式）→ 本地 ASR 转录为文本（需要语音模型）
 *    - 转录失败时静默跳过（L1692-1695 的 try-catch）
 *
 * 4. **出站提供者** (`FeishuChannelProvider`):
 *    - 注册到全局 Provider 注册表（供 `channel_send` 工具使用）
 *    - 支持文本、图片、文件附件发送
 *
 * ## P1 vs P2
 *
 * - P1: 包装成插件,支持禁用/启用,核心逻辑不动（适配器在 `index.ts` L1697 构造,
 *   在构造函数末尾自注册到全局注册表）
 * - P2: 适配器构造与注册迁移到插件内（`ctx.provide(FEISHU_ADAPTER)` +
 *   `ctx.on('app:ready', ...)` 启动监听），按需激活
 *
 * ## 为什么 P1 不做热插拔
 *
 * 飞书适配器在 `index.ts` S8 阶段构造（L1697），依赖:
 * 1. `feishuLoginService` 在 S8 阶段初始化（L1679-1681）
 * 2. `agentRuntimeBridge` 在 S7 阶段初始化（L1490-1567）
 * 3. 适配器构造后立即调用 `startListening()` 开始接收消息（L1698）
 * 4. LoginService 的 `statusChange` / `qrcode` 事件转发到渲染层（L1699-1707）
 * 5. 语音消息 ASR 转录依赖语音服务（L1684-1695）
 *
 * 要做真正的热插拔需要:
 * 1. 将适配器构造移到插件 `apply(ctx)`
 * 2. 将 `startListening()` 与 `stopListening()` 接入插件生命周期
 * 3. 支持运行时注销适配器（目前 `registerChannelAdapter` 无对应的 `unregister` API）
 *
 * P1 先做声明式包装,P2 再做执行期迁移。
 */
export const channelFeishuExtension = {
  manifest: {
    id: 'com.lumii.channel-feishu',
    name: '飞书渠道',
    version: '0.1.0',
    description: '飞书机器人消息收发、会话路由、语音转文本、斜杠命令（/new /clear /resume 等）',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.channel-feishu',
    provides: ['channel-feishu'],
    apply(ctx) {
      // 飞书适配器实际构造在 `index.ts` L1697（S8 阶段），消息监听通过
      // `FeishuLoginService.on('message', ...)` 启动。本插件作为"声明式开关"存在:
      // - 启用时: 适配器正常构造并自注册到全局注册表
      // - 禁用时: P2 改造后在此处跳过适配器构造与注册
      //
      // P1 阶段禁用插件 = 代码不加载,但 `index.ts` 照旧执行,适配器照旧构造——
      // 所以 P1 禁用插件**不影响**飞书渠道功能。
      //
      // 为什么不在这里 new FeishuChannelAdapter:
      // 1. 适配器依赖 feishuLoginService / bridge,都在 index.ts 中初始化
      // 2. 适配器在构造函数末尾调用 `registerChannelAdapter(this)` 自注册,
      //    调用时机与 app:ready 时序耦合
      // 3. 移动构造点会破坏现有初始化顺序,且 registerChannelAdapter 缺 unregister API
      //
      // P1 目标: 包装 + 文档完善,不改行为; P2 才做真正的按需激活与热插拔。

      ctx.log.info('飞书渠道插件已加载（适配器由 index.ts 构造）')

      // P2: 禁用时注销适配器
      // ctx.effect(() => {
      //   unregisterChannelAdapter('feishu')
      //   feishuChannelAdapter?.stopListening()
      //   ctx.log.info('飞书渠道插件卸载,已注销适配器')
      // })
    },
  }),
}
