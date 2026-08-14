/**
 * Agent App UI 控制工具注册（Part A/B：app_screenshot / app_goto / app_act）
 *
 * 从 BridgeToolRegistrar.registerAppUiTools() 提取。
 * 通过 createAppUiController 截取主窗口并操作界面，注册三工具。
 */

import { Type } from '@sinclair/typebox'
import { ToolRegistry, createMtBotTool, type ToolExecutionContext, type MtBotTool } from '@mtbot/agent-runtime'
import {
  createAppUiController,
  type AppUiController,
  type ResizeImageFn,
} from '../app-ui-control'
import type { BrowserWindow } from 'electron'
import { agentRuntimeLog as log, jsonToolResult } from './bridge-utils'

/** registerAppUiTools 依赖（controller 可选，供单测注入 mock） */
export interface RegisterAppUiToolsDeps {
  getMainWindow: () => BrowserWindow | null
  resizeImageIfNeeded: ResizeImageFn
  /** 测试注入：跳过 createAppUiController */
  controller?: AppUiController
}

/** app_goto 工具 description（设计 §13.2 分工原文，goto 相关行） */
const APP_GOTO_DESCRIPTION = `打开页面：app_goto（设置/技能/定时等用这个，不要点侧栏）
改思考级别/会话/技能执行/定时：用已有 settings_think、session_*、skill_*、cron_*
外部网页：browser_*
做完写操作后必须再截图或查询确认`

/** app_act 工具 description（设计 §13.2 分工原文，click 相关行 + 始终允许提示） */
const APP_ACT_DESCRIPTION = `点控件：app_act click（先截图拿 ref，ref 不跨 snapshotId 复用）
做完写操作后必须再截图或查询确认
禁止点聊天输入框和发送键
app_act click "始终允许"仅本次运行有效，重启后重置`

/**
 * 注册 Agent 操作本客户端界面的工具（MVP：app_screenshot / app_goto / app_act）。
 */
export function registerAppUiTools(
  toolRegistry: ToolRegistry,
  ctx: ToolExecutionContext,
  deps: RegisterAppUiToolsDeps,
): void {
  const controller =
    deps.controller ??
    createAppUiController({
      getMainWindow: deps.getMainWindow,
      resizeImageIfNeeded: deps.resizeImageIfNeeded,
    })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reg = (tool: any) => toolRegistry.register(tool as MtBotTool)

  reg(
    createMtBotTool(
      {
        name: 'app_screenshot',
        label: 'App Screenshot',
        category: 'channel' as const,
        description:
          '截取 Lumii 主窗口当前界面，返回 JPEG 图片与可交互元素 refs。只截图，不操作界面。',
        parameters: Type.Object({
          annotate: Type.Optional(
            Type.Boolean({ description: '是否在截图上标注元素编号（MVP 暂未实现）' }),
          ),
        }),
        isReadOnly: true,
        needsPermission: false,
        execute: async (_id, _rawParams) => {
          try {
            const result = await controller.screenshot()
            if (!result.ok) {
              return jsonToolResult({ ok: false, error: result.error })
            }

            const payload = {
              ok: true as const,
              snapshotId: result.snapshotId,
              view: result.viewState.view,
              hub: result.viewState.hub,
              width: result.width,
              height: result.height,
              refs: result.refs,
              truncated: result.truncated,
            }

            return {
              content: [
                { type: 'text', text: JSON.stringify(payload) },
                { type: 'image', data: result.imageBase64, mimeType: 'image/jpeg' },
              ],
              details: { previewPath: result.previewPath },
            }
          } catch {
            return jsonToolResult({ ok: false, error: 'capture_failed' })
          }
        },
      },
      ctx,
    ),
  )

  reg(
    createMtBotTool(
      {
        name: 'app_goto',
        label: 'App Goto',
        category: 'channel' as const,
        description: APP_GOTO_DESCRIPTION,
        parameters: Type.Object({
          view: Type.String({
            description:
              '目标视图：dashboard | chat | skills | settings | memories | agents | cron | plugins | mcp',
          }),
          category: Type.Optional(
            Type.String({
              description:
                'Settings Hub 分类（可选）：general | workspace | modelConfig | voice | channels | codingDev | pet | usage | privacy | aboutAndUpdate',
            }),
          ),
        }),
        isReadOnly: false,
        needsPermission: false,
        execute: async (_id, rawParams) => {
          try {
            const result = await controller.goto(rawParams)
            return jsonToolResult(result)
          } catch {
            return jsonToolResult({ ok: false, error: 'goto_failed' })
          }
        },
      },
      ctx,
    ),
  )

  reg(
    createMtBotTool(
      {
        name: 'app_act',
        label: 'App Act',
        category: 'channel' as const,
        description: APP_ACT_DESCRIPTION,
        parameters: Type.Object({
          action: Type.String({ description: '操作类型；MVP 仅支持 click' }),
          ref: Type.String({ description: '来自 app_screenshot 的元素 ref（如 e1）' }),
          snapshotId: Type.Optional(
            Type.String({ description: '截图返回的 snapshotId，用于校验 ref 未过期' }),
          ),
        }),
        isReadOnly: false,
        needsPermission: true,
        execute: async (_id, rawParams) => {
          const params = rawParams as Record<string, unknown>
          if (params.action !== 'click') {
            return jsonToolResult({ ok: false, error: 'usage' })
          }
          try {
            const result = await controller.click(rawParams)
            return jsonToolResult(result)
          } catch {
            return jsonToolResult({ ok: false, error: 'act_failed' })
          }
        },
      },
      ctx,
    ),
  )

  log.info('[registerAppUiTools] app_screenshot, app_goto, app_act registered')
}
