/**
 * Agent App UI 控制工具注册（Part A：app_screenshot）
 *
 * 从 BridgeToolRegistrar.registerAppUiTools() 提取。
 * 通过 createAppUiController 截取主窗口，注册 app_screenshot 工具。
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

/**
 * 注册 Agent 操作本客户端界面的工具（MVP：仅 app_screenshot）。
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

  log.info('[registerAppUiTools] app_screenshot registered')
}
