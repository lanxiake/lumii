import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../../../main/kernel/events'
import { S } from '../../../main/kernel/services'
import { startPcwechat } from '../../../main/channel/channel-runtime'

/**
 * 本机微信扩展（设置 › 扩展 › 本机微信）。
 *
 * ## 它管什么
 *
 * - **原生工具**：读会话/读记录/搜消息/发送/导出/画像/知识库/自动回复规则，共 31 个
 *   （`wechat-chat` MCP 那套的后端能力）。工具是**原生注册**进 ToolRegistry 的，名字不带
 *   `mcp__` 前缀——开关就是这个插件的开关，不需要用户再去 MCP 设置里配可执行文件。
 * - 出站 Provider：Agent 的 `channel_send` 走它，把消息发给用户微信里的好友/群。
 * - 渠道卡片：回复名单与策略、环境自检、就绪状态的提示。
 *
 * ## 它不管什么
 *
 * - **盯梢与自动回复**是另一个扩展 `com.lumii.relay`：关掉那个只是不回消息，
 *   关掉本扩展才会让 `channel_send` 报 `CHANNEL_NOT_CONNECTED`、工具从列表里消失。
 * - **前端控制台/安装器**（原 `wechat-chat-mcp.exe` 的 pywebview 面板与 `--install`）：
 *   不随包分发，也不需要——扩展已随应用发布。
 *
 * ## 能力从哪来
 *
 * `assets/wechat/` 下的 Python 源码（`sidecar.py` + `app.py` 那套业务模块），用应用
 * 托管的 Python 跑一个 JSONL 侧车进程。首次启用时才拉起（约 0.3s），进程内常驻。
 *
 * ## 禁用的实现
 *
 * Provider 注册在作用域里；工具按名字摘掉并刷新实例工具集（运行中的会话下一轮就看不到）；
 * **侧车进程也一并停掉**——它持有微信密钥扫描缓存与明文镜像，关掉扩展就该真的停下。
 * 重新启用会重新拉起（依赖已装好约 0.3s），这个代价换「关了就是关了」的语义值得。
 */
export const pcwechatExtension = {
  manifest: {
    id: 'com.lumii.pcwechat',
    name: '本机微信',
    version: '0.2.0',
    description:
      '以你本人身份使用这台电脑上登录的微信：读会话与聊天记录、搜消息、导出、按名单代回、主动发消息',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
    /**
     * 默认关闭：打开它等于把用户本人的微信身份与私聊交给模型（发送不可撤回），
     * 必须用户自己进设置页打开——不是「还没做完」，所以不用 `disabled`。
     */
    defaultEnabled: false,
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.pcwechat',
    provides: ['pcwechat'],
    apply(ctx) {
      /**
       * 装工具。侧车是异步拉的，而 **Agent Runtime 到 S7.4 才建**——两条都得等，
       * 所以这里不放在 `wire()` 的同步路径里：
       *
       * - 拿不到 bridge：挂 `agent:runtime-ready` 等它建好（**不能只 return**——
       *   `wire()` 成功不代表 bridge 就绪，Hub 在插件启动前就有了）。
       * - `effect` 要等 await 回来才登记：若期间插件已被停用，作用域会拒绝登记，
       *   此时直接调 disposer 把刚注册的工具摘掉，别留在 registry 里。
       */
      const installTools = async (): Promise<void> => {
        const dispose: (() => void) | null = await (async () => {
          const bridge = ctx.get(S.agentRuntime)?.get()
          if (!bridge) return null
          try {
            return await bridge.installWechatTools()
          } catch (err) {
            // 侧车拉不起来（Python 环境缺依赖等）：能力缺失要显式，别静默
            ctx.log.warn(`本机微信工具注册失败（侧车或 Python 环境问题）：${(err as Error).message}`)
            return null
          }
        })()

        if (!dispose) {
          // 还没就绪：等 runtime 起来再试一次（一次性，避免成环）
          ctx.on('agent:runtime-ready', () => {
            void installToolsSafely()
          })
          return
        }
        try {
          ctx.effect(dispose)
        } catch {
          // 作用域已销毁 = 侧车拉起期间插件被停用了，工具得当场还回去。
          // **不往外抛**：这条路径本来就没有可用的东西了，抛出去只会变成
          // unhandled rejection（调用方是 `void`），而主进程对它可以 `process.exit(1)`。
          dispose()
        }
      }

      /** `installTools` 的调用壳：所有退出路径都不许留下 unhandled rejection */
      const installToolsSafely = (): Promise<void> =>
        installTools().catch((err: unknown) => {
          ctx.log.warn(`本机微信工具装载失败：${err instanceof Error ? err.message : String(err)}`)
        })

      const wire = (): boolean => {
        const hub = ctx.get(S.channelHub)?.get()
        if (!hub) return false
        ctx.effect(startPcwechat(hub, () => ctx.get(S.agentRuntime)?.get() ?? null))
        return true
      }

      if (!wire()) {
        ctx.on('agent:runtime-ready', () => {
          wire()
        })
      }
      void installToolsSafely()
      ctx.log.info('本机微信扩展已加载（工具与出站 Provider 随扩展启停）')
    },
  }),
}
