import { resolve } from 'node:path'

/** apps/windows 绝对路径 */
export const APP_ROOT = __dirname
/** monorepo 根绝对路径 */
export const REPO_ROOT = resolve(__dirname, '../..')

/**
 * 路径别名的单一来源。
 *
 * electron.vite.config.ts（main / renderer 两块）、vitest.config.ts、vite.test.config.ts
 * 都从这里取绝对路径，避免各处 resolve(__dirname, ...) 手工同步后产生解析分歧。
 *
 * 历史上确实分歧过：`@` 在 electron.vite 指向 `src/renderer`，而在 tsconfig 与 vitest 指向 `src`。
 * 当时只有 `import type` 用到 `@/`（构建期被擦除）才没有暴露；任何值导入都会构建失败。
 * 现已统一为 `@` → `src`，renderer 目录由 `@renderer` 表达。
 *
 * 本文件只提供路径，别名键仍由各配置按自身作用域声明（main 不需要 renderer 的键，反之亦然）。
 */
export const appPath = {
  src: resolve(APP_ROOT, 'src'),
  main: resolve(APP_ROOT, 'src/main'),
  renderer: resolve(APP_ROOT, 'src/renderer'),
  shared: resolve(APP_ROOT, 'src/shared'),
  assets: resolve(APP_ROOT, 'assets'),
  rendererUtilStub: resolve(APP_ROOT, 'src/renderer/stubs/util.ts'),
  qrcodeTerminalStub: resolve(APP_ROOT, 'src/main/stubs/qrcode-terminal.ts'),
} as const

export const workspacePath = {
  agentRuntimeBrowser: resolve(REPO_ROOT, 'packages/agent-runtime/src/browser.ts'),
  agentRuntime: resolve(REPO_ROOT, 'packages/agent-runtime/src/index.ts'),
  browserControl: resolve(REPO_ROOT, 'packages/browser-control/src/index.ts'),
} as const
