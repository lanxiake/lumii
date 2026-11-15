/**
 * 把 listary 插件的**真实模块**打包成 Electron 可直接跑的 bundle。
 *
 * 不复制实现 —— 打包的就是 apps/windows/src/plugins/builtin/listary/ 下的源码，
 * 这样探针验的是真代码，不是平行实现。
 *
 * `node:sqlite` 与 `electron` 保持 external（前者是 Electron 内建模块，后者由 Electron 注入）。
 * `@mtbot/agent-runtime` 打进 bundle（源码是 .ts，且用到它的 workspace 导出）。
 */
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')

await build({
  entryPoints: [path.join(here, 'verify-entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(here, 'bundle.cjs'),
  // electron 由运行时注入；node:sqlite 是内建模块，必须保持 external
  external: ['electron', 'node:sqlite'],
  alias: {
    '@mtbot/agent-runtime': path.join(repoRoot, 'packages', 'agent-runtime', 'src', 'index.ts'),
  },
  logLevel: 'warning',
})

console.log('built verify/listary-p1/bundle.cjs')
