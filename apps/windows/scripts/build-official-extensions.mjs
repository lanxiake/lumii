/**
 * 构建「官方扩展」：把可选的主进程功能从主 bundle 拆出去，成为独立的外部扩展。
 *
 * 产物：`resources/extensions/<id>/main.js` + `build-info.json`。
 * 启动时由 `official-extensions.ts` 按 sha256 同步到 `~/.lumii/extensions/<id>/`，
 * 再由现有的外部扩展加载器加载——代码不再进主进程 bundle，禁用/删除/热更新都走同一套。
 *
 * 目前有 perf / cloud-sync 两个试点。新增官方扩展时在 ENTRIES 里加一行。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const OUT_ROOT = path.join(ROOT, 'resources', 'extensions')

/** id 必须与 extension 源码里的 manifest.id 一致 */
const ENTRIES = [
  {
    id: 'com.lumii.perf',
    version: '0.1.0',
    entry: 'src/main/extensions/perf.ts',
  },
  {
    id: 'com.lumii.cloud-sync',
    version: '0.1.0',
    entry: 'src/main/extensions/cloud-sync.ts',
  },
]

async function main() {
  mkdirSync(OUT_ROOT, { recursive: true })
  for (const item of ENTRIES) {
    const outDir = path.join(OUT_ROOT, item.id)
    mkdirSync(outDir, { recursive: true })
    const outfile = path.join(outDir, 'main.js')
    await build({
      entryPoints: [path.join(ROOT, item.entry)],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      // electron 由主进程提供；node 内置模块 esbuild 在 platform=node 下自动外置
      external: ['electron'],
      // esbuild 的 ESM 输出没有 `require`，而 CJS 依赖（isomorphic-git → sha.js →
      // safe-buffer → require('buffer')）会在打包后的 `__require` 里炸
      // 「Dynamic require of "buffer" is not supported」。banner 里的 createRequire
      // 让 `__require` 的 `typeof require` 分支拿到可用实现（实测 2026-10-21）。
      banner: {
        js: "import { createRequire as __lumiiCreateRequire } from 'node:module'; const require = __lumiiCreateRequire(import.meta.url);",
      },
      legalComments: 'none',
      logLevel: 'warning',
    })
    const sha256 = createHash('sha256').update(readFileSync(outfile)).digest('hex')
    writeFileSync(
      path.join(outDir, 'build-info.json'),
      `${JSON.stringify({ id: item.id, version: item.version, sha256 }, null, 2)}\n`,
      'utf8',
    )
    console.log(`[official-ext] ${item.id} v${item.version} → ${path.relative(ROOT, outfile)} (${sha256.slice(0, 12)})`)
  }
}

main().catch((err) => {
  console.error('[official-ext] 构建失败', err)
  process.exitCode = 1
})
