/**
 * 把 CLI 打成单文件 ESM。
 *
 * 为什么要打包而不是直接跑 TS：pet-core 的源码用 `./x.js` 指代 `./x.ts`
 * （TypeScript NodeNext 的标准写法），而 Node 的类型擦除不做这个改写，
 * 直接 `node src/cli.ts` 会在 import 阶段就 ERR_MODULE_NOT_FOUND。
 * 打包顺带把 pet-core 源码并进来，产物只剩一个文件，分发也简单。
 *
 * sharp 保持 external：它是 native 模块，打包会破坏 .node 的加载。
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

await build({
  entryPoints: [join(root, 'src/cli.ts')],
  outfile: join(root, 'dist/cli.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: false,
  external: ['sharp'],
  // package.json 里的 bin 需要可执行；Windows 不看这一位，Linux/macOS 看
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
})

console.log('[pet-asset] 构建完成 → dist/cli.mjs')
