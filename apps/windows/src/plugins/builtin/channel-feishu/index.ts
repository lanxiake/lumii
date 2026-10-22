import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../../../main/kernel/events'
import { S } from '../../../main/kernel/services'
import { startChannel } from '../../../main/channel/channel-runtime'
import { hasHeadlessFlag } from '../../../main/platform/feature-probe'

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
 * ## 禁用的实现（启动期状态门）
 *
 * 适配器构造留在 `index.ts`（S8），但整段包在
 * `isExtensionActive('com.lumii.channel-feishu')` 里：插件被禁用时**登录服务也不建**，
 * 于是既没有连接、也没有适配器。Hub 侧传 `feishu: undefined`，该渠道不进 registry，
 * 出站得到稳定的 `CHANNEL_NOT_CONNECTED`。
 *
 * 仍是启动期判定：设置里改开关要重启才生效。
 *
 * **运行期启停做不到**：适配器在构造函数末尾自注册到全局注册表，
 * 而 `registerChannelAdapter` 没有对应的 `unregister`；语音 ASR 回调也挂在登录服务上。
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
      // 装配在 channel-runtime 里做：登录服务 + 适配器 + 出站 Provider。
      // 要 bridge（S7.4 才有）与 Hub（S1 就建好），所以先等 agent:runtime-ready。
      const wire = (): boolean => {
        const bridge = ctx.get(S.agentRuntime)?.get()
        const hub = ctx.get(S.channelHub)?.get()
        if (!bridge || !hub) return false
        const pending = startChannel('feishu', {
          getBridge: () => ctx.get(S.agentRuntime)?.get() ?? null,
          getMainWindow: () => ctx.get(S.mainWindow)?.get() ?? null,
          getVoice: () => ctx.get(S.voice) ?? null,
          isHeadless: hasHeadlessFlag(),
        })
        // 停用：等装配完再拆（异步装配中就被关掉的窗口不能漏）
        ctx.effect(async () => {
          const dispose = await pending
          dispose()
        })
        return true
      }
      if (!wire()) {
        ctx.on('agent:runtime-ready', () => {
          wire()
        })
      }
      ctx.log.info('飞书渠道插件已加载（随插件启停装配）')
    },
  }),
}
