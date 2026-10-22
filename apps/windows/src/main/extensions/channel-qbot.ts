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
 * ## 禁用的实现（启动期状态门）
 *
 * 适配器构造留在 `index.ts`（S8），但整段包在
 * `isExtensionActive('com.lumii.channel-qbot')` 里：插件被禁用时**登录服务也不建**，
 * 于是既没有连接、也没有适配器。Hub 侧传 `qbot: undefined`，该渠道不进 registry，
 * 出站得到稳定的 `CHANNEL_NOT_CONNECTED`。
 *
 * 仍是启动期判定：设置里改开关要重启才生效。
 *
 * **运行期启停做不到**：适配器在构造函数末尾自注册到全局注册表，
 * 而 `registerChannelAdapter` 没有对应的 `unregister`；silk/ASR 回调也挂在登录服务上。
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
      // 构造点在 `index.ts`（依赖登录服务、bridge、silk/ASR，都在那里初始化），
      // 那边按 `isExtensionActive('com.lumii.channel-qbot')` 决定装不装。

      ctx.log.info('QQ 渠道插件已加载（适配器由 index.ts 按插件状态装配）')
    },
  }),
}
