import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../kernel/events'

/**
 * QQ 渠道扩展。
 *
 * ## 架构定位
 *
 * 内建插件,可禁用。禁用后:
 * - QQ 机器人消息不再接收与处理
 * - QQ 渠道的斜杠命令不可用
 * - QQ 会话路由失效
 *
 * ## 依赖与时序
 *
 * - **Bridge**: 通过 bridge 驱动回合、管理会话、路由消息
 * - **QbotLoginService**: QQ 扫码登录与消息收发服务
 * - **激活时机**: 等 `app:ready`（bridge 在 S7 初始化,适配器在 S8 阶段构造）
 *
 * ## 核心逻辑
 *
 * 1. **适配器** (`qbot-channel-adapter.ts`):
 *    - 实现 `IChannelAdapter` 接口（`handleMessage` / `getContextStrategy` 等）
 *    - 在构造末尾调用 `registerChannelAdapter(this)` 自注册到全局注册表
 *    - 消息串行化处理（按 channelUserId 队列）
 *
 * 2. **消息处理流程**:
 *    - `QbotLoginService` 监听入站消息 → `qbotChannelAdapter.handleMessage`
 *    - 路由决策（路由表 > 渠道默认）→ 获取会话上下文
 *    - 斜杠命令识别（`/new` / `/clear` / `/resume` 等）→ 执行命令或驱动 Agent 回合
 *    - 回合结束 → 发送回复（调用 `QbotLoginService.sendMessage`）
 *
 * 3. **语音消息处理**:
 *    - QQ 语音消息（silk 格式）→ 解码为 PCM → 本地 ASR 转录为文本（需要语音模型 + silk-wasm）
 *    - 转录失败时静默跳过（L1726-1729 的 try-catch）
 *
 * 4. **出站提供者** (`QbotChannelProvider`):
 *    - 注册到全局 Provider 注册表（供 `channel_send` 工具使用）
 *    - 支持文本、图片、文件附件发送
 *    - 图片/文件需上传到公网或使用官方格式限制（png/jpg/mp4/silk）
 *
 * ## P1 vs P2
 *
 * - P1: 包装成插件,支持禁用/启用,核心逻辑不动（适配器在 `index.ts` L1731 构造,
 *   在构造函数末尾自注册到全局注册表）
 * - P2: 适配器构造与注册迁移到插件内（`ctx.provide(QBOT_ADAPTER)` +
 *   `ctx.on('app:ready', ...)` 启动监听），按需激活
 *
 * ## 为什么 P1 不做热插拔
 *
 * QQ 适配器在 `index.ts` S8 阶段构造（L1731），依赖:
 * 1. `qbotLoginService` 在 S8 阶段初始化（L1713-1715）
 * 2. `agentRuntimeBridge` 在 S7 阶段初始化（L1490-1567）
 * 3. 适配器构造后立即调用 `startListening()` 开始接收消息（L1732）
 * 4. LoginService 的 `statusChange` / `qrcode` 事件转发到渲染层（L1733-1741）
 * 5. 语音消息 ASR 转录依赖 silk-wasm + 语音服务（L1718-1729）
 *
 * 要做真正的热插拔需要:
 * 1. 将适配器构造移到插件 `apply(ctx)`
 * 2. 将 `startListening()` 与 `stopListening()` 接入插件生命周期
 * 3. 支持运行时注销适配器（目前 `registerChannelAdapter` 无对应的 `unregister` API）
 *
 * P1 先做声明式包装,P2 再做执行期迁移。
 */
export const channelQbotExtension = {
  manifest: {
    id: 'com.lumii.channel-qbot',
    name: 'QQ 渠道',
    version: '0.1.0',
    description: 'QQ 机器人消息收发、会话路由、语音转文本、斜杠命令（/new /clear /resume 等）',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.channel-qbot',
    provides: ['channel-qbot'],
    apply(ctx) {
      // QQ 适配器实际构造在 `index.ts` L1731（S8 阶段），消息监听通过
      // `QbotLoginService.on('message', ...)` 启动。本插件作为"声明式开关"存在:
      // - 启用时: 适配器正常构造并自注册到全局注册表
      // - 禁用时: P2 改造后在此处跳过适配器构造与注册
      //
      // P1 阶段禁用插件 = 代码不加载,但 `index.ts` 照旧执行,适配器照旧构造——
      // 所以 P1 禁用插件**不影响** QQ 渠道功能。
      //
      // 为什么不在这里 new QbotChannelAdapter:
      // 1. 适配器依赖 qbotLoginService / bridge,都在 index.ts 中初始化
      // 2. 适配器在构造函数末尾调用 `registerChannelAdapter(this)` 自注册,
      //    调用时机与 app:ready 时序耦合
      // 3. 移动构造点会破坏现有初始化顺序,且 registerChannelAdapter 缺 unregister API
      //
      // P1 目标: 包装 + 文档完善,不改行为; P2 才做真正的按需激活与热插拔。

      ctx.log.info('QQ 渠道插件已加载（适配器由 index.ts 构造）')

      // P2: 禁用时注销适配器
      // ctx.effect(() => {
      //   unregisterChannelAdapter('qbot')
      //   qbotChannelAdapter?.stopListening()
      //   ctx.log.info('QQ 渠道插件卸载,已注销适配器')
      // })
    },
  }),
}
