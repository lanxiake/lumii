/**
 * 打包 icons 验收探针（走真实的 plugins/builtin/listary/ipc.ts，非复制实现）。
 * 用法：node verify/listary-p3/build-icons.mjs
 */
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')

await build({
  entryPoints: [path.join(here, 'icons-entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(here, 'icons-bundle.cjs'),
  external: ['electron', 'node:sqlite'],
  alias: {
    '@mtbot/agent-runtime': path.join(repoRoot, 'packages', 'agent-runtime', 'src', 'index.ts'),
    '@mtbot/plugin-core': path.join(repoRoot, 'packages', 'plugin-core', 'src', 'index.ts'),
  },
  logLevel: 'warning',
})

console.log('built verify/listary-p3/icons-bundle.cjs')
