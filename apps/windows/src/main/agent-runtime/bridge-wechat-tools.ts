/**
 * 本机微信工具注册（`com.lumii.pcwechat` 的原生工具）。
 *
 * **为什么不复用 MCP 那条路**：这些工具此前是 `wechat-chat` 这个 MCP Server 暴露的
 * （`mcp__wechat-chat__*`），启用/停用要用户自己去 MCP 设置里配可执行文件。现在能力
 * 归插件所有，开关就是插件的开关：插件启用 → 工具进 ToolRegistry，停用 → 按名字摘掉。
 *
 * **工具的 schema 从哪来**：Python 侧 `app.py` 里那 31 个工具的 `inputSchema` 是唯一的
 * 事实源（描述里的【何时用】【别用】是写给模型看的，改一处就够）。TS 侧不复制一份，
 * 而是 `initialize` 时把它们拉过来——`tsconfig` 没开 `resolveJsonModule`，复制一份只会
 * 变成两份要同步维护的 schema。
 *
 * **结果语义**：`content` 原样透传（`read_image` 的内联位图不能丢），`isError` 只源自
 * 侧车——侧车只有「工具内部炸了」才置它。业务性失败（`env_not_ready` /
 * `target_not_found`）是 `ok:false` 的结构化 JSON，**不是**失败信号，模型要读它。
 * 所以这里**不能**用 `jsonToolResult()`：它内嵌的 `payloadIsFailure` 见到 `ok:false`
 * 就置 isError，正好和这条约定相反。
 */
import { Type } from '@sinclair/typebox'
import {
  ToolRegistry,
  createMtBotTool,
  type ToolExecutionContext,
  type MtBotTool,
} from '@mtbot/agent-runtime'
import { agentRuntimeLog as log } from './bridge-utils'
import type { WechatSidecarClient } from './wechat-sidecar-client'

/**
 * 把侧车的工具清单注册进 registry，返回注册了哪些名字（停用时按名字摘）。
 *
 * 会拉起步车进程（首次约 0.3s）：工具清单只有跑起来才知道。
 */
export async function registerWechatTools(
  toolRegistry: ToolRegistry,
  ctx: ToolExecutionContext,
  client: WechatSidecarClient,
): Promise<string[]> {
  const tools = await client.listTools()
  const registered: string[] = []

  for (const t of tools) {
    toolRegistry.register(
      createMtBotTool(
        {
          name: t.name,
          // 原生工具名会**原样**显示在 ToolCallCard（它只特判 `mcp__` 前缀），
          // 所以 label 与 name 一致即可；白话标签在渲染层 `tool-labels.ts` 里映射。
          label: t.name,
          description: t.description,
          // 侧车交的是标准 JSON Schema；TypeBox 的 Unsafe 让 pi-agent-core 直接用它校验
          parameters: Type.Unsafe(t.inputSchema as Record<string, unknown>),
          category: 'channel' as const,
          isReadOnly: t.annotations?.readOnlyHint ?? false,
          needsPermission: t.annotations?.destructiveHint ?? false,
          execute: async (_toolCallId, rawParams, _ctx, signal, onUpdate) => {
            try {
              const res = await client.call(
                t.name,
                (rawParams ?? {}) as Record<string, unknown>,
                {
                  signal,
                  // 发送路径几十秒（切会话 + 输入 + 等落库），不给进度界面就是干等。
                  // 侧车只在发送类工具上装进度槽，其余工具这条回调永远不会被调。
                  onProgress: onUpdate
                    ? (p) =>
                        onUpdate({
                          content: [
                            {
                              type: 'text',
                              text: p.total ? `[${p.progress}/${p.total}] ${p.message}` : `[${p.progress}] ${p.message}`,
                            },
                          ],
                          details: undefined,
                        })
                    : undefined,
                },
              )
              // 契约：isError 是 ToolRunner 唯一认的失败信号，只由侧车决定。
              return { content: res.content, details: undefined, isError: res.isError }
            } catch (err) {
              // 通道层异常（侧车挂了 / 超时 / 回合被 abort）对模型而言与工具自报失败等价，
              // 转成 isError 即可，不再 rethrow 让 pi-agent-core 包一层。
              const msg = err instanceof Error ? err.message : String(err)
              return {
                content: [{ type: 'text', text: `微信工具 ${t.name} 调用失败：${msg}` }],
                details: undefined,
                isError: true,
              }
            }
          },
        },
        ctx,
      ) as MtBotTool,
    )
    registered.push(t.name)
  }

  log.info(`[wechat] 注册 ${registered.length} 个本机微信工具：${registered.join(', ')}`)
  return registered
}
