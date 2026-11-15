/**
 * 打包焦点接线探针。
 * 用法：node verify/listary-p3/build-focus.mjs
 */
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')

await build({
  entryPoints: [path.join(here, 'focus-entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(here, 'focus-bundle.cjs'),
  external: ['electron', 'node:sqlite'],
  alias: {
    '@mtbot/agent-runtime': path.join(repoRoot, 'packages', 'agent-runtime', 'src', 'index.ts'),
  },
  logLevel: 'warning',
})

console.log('built verify/listary-p3/focus-bundle.cjs')
