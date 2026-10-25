/**
 * `app_panel` —— Agent 声明"在右栏打开哪个面板、什么模式"。
 *
 * 为什么由 Agent 选而不是 UI 猜：判定"该用哪种呈现"的信息全在对话里
 * （用户说的是"通读一遍"还是"改第三段"），UI 只看得见文件扩展名。
 * 这条原则的同款先例是 `app_goto` / `a2ui_guide` 的 selection_guide。
 *
 * 失败**一律显式返回**，不静默回落 —— 回落会让模型以为面板开了。
 */

import fs from 'node:fs'
import path from 'node:path'
import { Type } from '@sinclair/typebox'
import { createMtBotTool, type ToolExecutionContext, type ToolRegistry, type MtBotTool } from '@mtbot/agent-runtime'
import type { AppUiController } from '../app-ui-control'
import { isAppUiControlEnabled } from '../app-ui-control/enabled'
import { resolveActiveWorkspaceDir } from '../workspace-paths'
import {
  APP_PANEL_MODES,
  APP_PANEL_MODE_HINTS,
  isAppPanelMode,
  type AppPanelMode,
} from '../../shared/app-panel-modes'
import { agentRuntimeLog as log, jsonToolResult } from './bridge-utils'

const APP_PANEL_DESCRIPTION = `在右侧面板打开内容给用户持续看或改（当前只有 doc 模式）。
- doc：${APP_PANEL_MODE_HINTS.doc}需给 path（工作区相对路径或绝对路径）。

只在用户需要**持续看或改**时用。只是想让用户"看一眼结果"，用 a2ui（图表/表格/图片在对话里就行），不要开面板。
打开二进制文件（图片/视频/PDF）也不要用它。
失败码：unknown_mode（附可用模式）/ file_not_found / disabled / app_not_running。`

export interface RegisterAppPanelToolsDeps {
  controller: Pick<AppUiController, 'panel'>
  /** 读取渲染进程 localStorage 设置 JSON（与 app_* 同一条总开关） */
  readSettingsJson?: () => Promise<string | null>
  /** 工作区根目录（相对路径的基准）；默认当前生效工作区 */
  resolveWorkspaceDir?: () => string
  /** 测试注入：文件是否存在 */
  fileExists?: (absolutePath: string) => boolean
}

/**
 * 把工具收到的 path 解析为绝对路径（相对路径以工作区为基准）。
 * 统一成正斜杠：渲染层（FilePreviewModal / FileTree）都按 '/' 处理路径。
 */
function resolvePanelPath(raw: string, workspaceDir: string): string {
  const absolute = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(workspaceDir, raw)
  return absolute.replace(/\\/g, '/')
}

/**
 * 注册 `app_panel`。
 */
export function registerAppPanelTools(
  toolRegistry: ToolRegistry,
  ctx: ToolExecutionContext,
  deps: RegisterAppPanelToolsDeps,
): void {
  const readSettingsJson = deps.readSettingsJson ?? (async () => null)
  const resolveWorkspaceDir = deps.resolveWorkspaceDir ?? resolveActiveWorkspaceDir
  const fileExists =
    deps.fileExists ??
    ((absolutePath: string) => {
      try {
        return fs.statSync(absolutePath).isFile()
      } catch {
        return false
      }
    })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reg = (tool: any) => toolRegistry.register(tool as MtBotTool)

  reg(
    createMtBotTool(
      {
        name: 'app_panel',
        label: 'App Panel',
        category: 'channel' as const,
        description: APP_PANEL_DESCRIPTION,
        parameters: Type.Object({
          mode: Type.String({ description: `呈现模式：${APP_PANEL_MODES.join(' | ')}` }),
          path: Type.Optional(
            Type.String({ description: '工作区相对路径或绝对路径（doc 模式必填）' }),
          ),
        }),
        isReadOnly: false,
        needsPermission: false,
        execute: async (_id, rawParams) => {
          if (!(await isAppUiControlEnabled(readSettingsJson))) {
            return jsonToolResult({ ok: false, error: 'disabled' })
          }

          const params = (rawParams ?? {}) as Record<string, unknown>
          const mode = params.mode
          if (!isAppPanelMode(mode)) {
            return jsonToolResult({
              ok: false,
              error: 'unknown_mode',
              available: APP_PANEL_MODES,
            })
          }

          const rawPath = typeof params.path === 'string' ? params.path.trim() : ''
          if (!rawPath) {
            return jsonToolResult({ ok: false, error: 'file_not_found', hint: 'doc 模式必填 path' })
          }

          const absolutePath = resolvePanelPath(rawPath, resolveWorkspaceDir())
          if (!fileExists(absolutePath)) {
            return jsonToolResult({
              ok: false,
              error: 'file_not_found',
              path: absolutePath,
              hint: '文件不存在；相对路径以工作空间根目录为基准',
            })
          }

          const sent = deps.controller.panel({ mode: mode as AppPanelMode, path: absolutePath })
          if (!sent.ok) {
            return jsonToolResult({ ok: false, error: sent.error })
          }

          log.info(`[app_panel] 已请求打开面板 mode=${mode} path=${absolutePath}`)
          return jsonToolResult({ ok: true, mode, path: absolutePath })
        },
      },
      ctx,
    ),
  )

  log.info('[registerAppPanelTools] app_panel registered')
}
