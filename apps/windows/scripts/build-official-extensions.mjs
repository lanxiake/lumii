/**
 * 构建「官方扩展」：把可选的主进程功能从主 bundle 拆出去，成为独立的外部扩展。
 *
 * 产物：`resources/extensions/<id>/main.js` + `build-info.json`，以及一份 `catalog.json`
 * （id / 名称 / 版本 / 资产名 / sha256）。
 *
 * 分发有两条路：
 * - 开发（`pnpm dev`）：resources 里有完整目录，启动时由 `syncOfficialExtensions` 拷到用户目录；
 * - 安装包：只带 `catalog.json`（electron-builder filter），设置页显示「可安装」，
 *   点安装后从 GitHub Release 下载 `ext-<id>.js`（复用 `plugin:install` 骨架）。
 *
 * 目前有 perf / cloud-sync / screen-record 三个试点。新增官方扩展时在 ENTRIES 里加一行。
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
    name: '性能监控',
    description: 'IPC 耗时、慢调用、启动阶段与内存快照',
    version: '0.1.0',
    entry: 'src/plugins/external-src/perf/index.ts',
  },
  {
    id: 'com.lumii.cloud-sync',
    name: '云同步',
    description: '把用户文件与记忆同步到自建 Git 仓库',
    version: '0.1.0',
    entry: 'src/plugins/external-src/cloud-sync/index.ts',
  },
  {
    id: 'com.lumii.screen-record',
    name: '录屏',
    description: '窗口/屏幕录制、旁白配音与字幕烧录',
    version: '0.1.0',
    entry: 'src/plugins/external-src/screen-record/index.ts',
  },
]

/** GitHub Release 上的资产名；安装时按它拼 URL */
const assetName = (id) => `ext-${id}.js`

async function main() {
  mkdirSync(OUT_ROOT, { recursive: true })
  const catalog = []
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
    catalog.push({
      id: item.id,
      name: item.name,
      description: item.description,
      version: item.version,
      asset: assetName(item.id),
      sha256,
    })
    console.log(`[official-ext] ${item.id} v${item.version} → ${path.relative(ROOT, outfile)} (${sha256.slice(0, 12)})`)
  }

  writeFileSync(
    path.join(OUT_ROOT, 'catalog.json'),
    `${JSON.stringify({ version: 1, extensions: catalog }, null, 2)}\n`,
    'utf8',
  )
  console.log(`[official-ext] catalog.json（${catalog.length} 项）`)
}

main().catch((err) => {
  console.error('[official-ext] 构建失败', err)
  process.exitCode = 1
})
