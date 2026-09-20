/**
 * 路径推断 —— CLI 不依赖 Electron，自行算出用户宠物目录。
 *
 * **必须与客户端一致**：客户端侧的实现是
 * `apps/windows/src/main/client-data-root.ts` 的 `resolveClientStateDir()`
 * （`~/.lumii`，可用 `LUMII_CLIENT_DATA_DIR` 覆盖）。
 *
 * 为什么不能用 `app.getPath('userData')`：`app.setName('Lumii')` 在 `whenReady()`
 * 之后才调用，而 userData 在更早的启动阶段就按 `app.getName()` 算好并缓存 ——
 * dev 下是 `%APPDATA%/lumii-windows`（package.json 的 name），打包才是
 * `%APPDATA%/Lumii`（productName）。CLI 无从得知当前是哪种模式，两边必然对不上。
 * 数据根没有这个问题：dev 与打包都落在 `~/.lumii`。
 *
 * 这段两行规则在客户端侧有一份实现（用的是 os/path 内置模块，无法提到零依赖的
 * pet-core 里——那会被渲染层打包时牵连进 node 内置模块）。**改动须两边同步**，
 * `paths.test.ts` 锁住了本侧的取值。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** 客户端数据根目录名（与 client-data-root.ts 的 WINDOWS_CLIENT_DATA_DIRNAME 同值） */
export const CLIENT_DATA_DIRNAME = '.lumii'

/** 用户宠物目录在数据根下的子目录名（与 pet-asset-protocol.ts 的 PET_MODELS_SUBDIR 同值） */
export const PET_MODELS_SUBDIR = 'pet-models'

/** 客户端数据根：`LUMII_CLIENT_DATA_DIR` 优先，否则 `~/.lumii` */
export function resolveClientDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LUMII_CLIENT_DATA_DIR?.trim()
  if (override) {
    return override.startsWith('~')
      ? join(homedir(), override.replace(/^~(?=$|[/\\])/, ''))
      : override
  }
  return join(homedir(), CLIENT_DATA_DIRNAME)
}

/**
 * 用户宠物目录。
 *
 * 优先级：`--target` 显式指定 > `PET_MODELS_DIR` 环境变量 > 数据根默认。
 * 环境变量在前是给 Agent 侧用的——宿主可以把它指到别处而不必改命令。
 */
export function resolveUserPetDir(override?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (override) return override
  if (env.PET_MODELS_DIR) return env.PET_MODELS_DIR
  return join(resolveClientDataRoot(env), PET_MODELS_SUBDIR)
}
