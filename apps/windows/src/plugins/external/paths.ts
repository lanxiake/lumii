import path from 'node:path'

import { resolveClientStateDir } from '../../main/paths'

/**
 * 插件目录的**中立**路径定义。
 *
 * 放在这里而不是 `client-plugin-protocol.ts`：那个模块 import 了 electron
 * （`app` / `protocol`），而扩展控制面与单测只需要路径，不该被 electron 拖下水。
 */
export function resolveClientPluginsDir(): string {
  return path.join(resolveClientStateDir(), 'plugins')
}

/** 外部扩展目录：主进程半边 `main.js` + 可选的渲染层半边 `client.js` */
export function resolveExtensionsDir(): string {
  return path.join(resolveClientStateDir(), 'extensions')
}
