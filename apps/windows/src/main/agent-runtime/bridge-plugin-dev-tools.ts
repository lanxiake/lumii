/**
 * Agent 自举开发插件：`plugin_dev`（只读）。
 *
 * 写文件走现有的 `file_write`（`~/.lumii` 已在允许根内），这里只补齐 Agent
 * 缺的两样：**契约**（guide）与**反馈**（status / check）。
 *
 * 不做写 action：多一条写通道就多一个绕过权限确认的入口，而 `file_write`
 * 已经有权限、回读校验和分段写入。
 */

import { createMtBotTool, type MtBotTool, type MtBotToolConfig } from '@mtbot/agent-runtime'
import { Type } from '@sinclair/typebox'

import { getClientPluginStateReport } from '../client-plugin-state-report'
import { resolveClientPluginsDir } from '../client-plugin-protocol'
import { checkPlugin, type PluginKind } from '../plugin-dev-check'
import { buildPluginDevGuide, resolvePluginDevRoots } from '../plugin-dev-guide'
import { getExtensionControl } from '../extension-control'
import { resolveExtensionsDir } from '../extension-loader'
import { jsonToolResult } from './bridge-utils'
import type { BridgeToolRegistrarDeps } from './bridge-tool-registrar-types'

const PluginDevParams = Type.Object({
  action: Type.Union(
    [Type.Literal('guide'), Type.Literal('status'), Type.Literal('check')],
    {
      description:
        'guide = full contract and paths; status = live load state/errors; check = static validation of one plugin directory',
    },
  ),
  kind: Type.Optional(
    Type.Union([Type.Literal('client'), Type.Literal('main')], {
      description: 'check 用：client = ~/.lumii/plugins 渲染层插件；main = ~/.lumii/extensions 主进程扩展',
    }),
  ),
  id: Type.Optional(
    Type.String({ description: 'check 用：插件目录名（不是 plugin.json 里的 id）' }),
  ),
})

export function registerPluginDevTools(deps: BridgeToolRegistrarDeps): void {
  const ctx = deps.toolContext
  if (!ctx) return

  const config: MtBotToolConfig<typeof PluginDevParams> = {
    name: 'plugin_dev',
    label: 'Plugin Dev',
    description:
      'Develop this client’s own plugins. Use guide before writing code; status to see whether it actually loaded and why; check to validate a plugin directory before handing it over.',
    parameters: PluginDevParams,
    category: 'agent' as const,
    isReadOnly: true,
    needsPermission: false,
    execute: async (_toolCallId, raw) => {
      const params = raw as { action: string; kind?: PluginKind; id?: string }

      if (params.action === 'guide') {
        return jsonToolResult({ ok: true, ...buildPluginDevGuide() })
      }

      if (params.action === 'status') {
        const control = getExtensionControl()
        if (!control) {
          return jsonToolResult({ ok: false, error: '扩展宿主尚未就绪' })
        }
        const report = getClientPluginStateReport()
        return jsonToolResult({
          ok: true,
          roots: resolvePluginDevRoots(),
          main: control.list().map((item) => ({
            id: item.id,
            name: item.name,
            kind: item.kind,
            enabled: item.enabled,
            state: item.state,
            pendingRestart: item.pendingRestart,
            ...(item.dir ? { dir: item.dir } : {}),
            ...(item.error ? { error: item.error } : {}),
          })),
          client: report.states,
          clientReportedAt: report.reportedAt ? new Date(report.reportedAt).toISOString() : null,
          clientReporting:
            report.reportedAt > 0
              ? 'ok'
              : '渲染层尚未上报（窗口未打开或宿主未启动）；此时 client 为空不代表没有插件',
        })
      }

      if (params.action === 'check') {
        if (!params.kind || !params.id) {
          return jsonToolResult({ ok: false, error: 'check 需要 kind（client|main）与 id（目录名）' })
        }
        const result = checkPlugin({
          kind: params.kind,
          id: params.id,
          clientRoot: resolveClientPluginsDir(),
          mainRoot: resolveExtensionsDir(),
        })

        // 运行时错误单独给：加载有 0.3s/1s 延迟，刚写完可能还是上一版的状态，
        // 不能据此把静态体检判成失败。以 plugin_dev status 为准。
        const runtimeError =
          params.kind === 'client'
            ? getClientPluginStateReport().states.find(
                (s) => s.id === params.id || s.dir === params.id,
              )?.error
            : getExtensionControl()
                ?.list()
                .find(
                  (item) =>
                    item.kind === 'external' &&
                    (item.id === params.id || item.dir?.endsWith(`/${params.id}`) || item.dir?.endsWith(`\\${params.id}`)),
                )?.error

        return jsonToolResult({
          ...result,
          // 显式带 ok：失败语义守卫只认字面量里的 ok/status，不展开 spread
          ok: result.ok,
          runtimeError: runtimeError ?? null,
          runtimeNote:
            'runtimeError 可能来自上一版本（加载有约 0.3–1 秒延迟）；最终以 plugin_dev status 为准。',
        })
      }

      return jsonToolResult({ ok: false, error: `未知 action：${params.action}` })
    },
  }

  deps.toolRegistry.register(createMtBotTool(config, ctx) as unknown as MtBotTool)
}
