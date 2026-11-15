/**
 * 打包 P2 评测探针（真实模块，非复制实现）。
 * 用法：node verify/listary-p2/build.mjs
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
  external: ['electron', 'node:sqlite'],
  alias: {
    '@mtbot/agent-runtime': path.join(repoRoot, 'packages', 'agent-runtime', 'src', 'index.ts'),
  },
  logLevel: 'warning',
})

console.log('built verify/listary-p2/bundle.cjs')
