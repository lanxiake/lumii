#!/usr/bin/env node
/**
 * build-ipc.mjs — 把主进程的宠物工具链入口打成单文件，供离线脚本直接 import
 *
 * ## 为什么要这个
 *
 * `verify/pet-sprite/` 下那些离线脚本要用工具链（slice / normalize / pack / hitAreas /
 * idlePin …），而这些算子住在 `apps/windows/src/main/pet/pet-asset-ipc.ts` 里，
 * 是 TS 且依赖 electron 与 sharp。
 *
 * 原先有两条路，都不好：
 *   · 起 `local-toolchain-server.mjs` 走 HTTP —— 多一个进程，还要跟**运行中的 App**
 *     抢 `~/.lumii/runtime/app-ui.json`（App 一起来就把端口覆盖掉，脚本就指到 App 去了）
 *   · 直接 import TS —— Node 不认
 *
 * 所以打成 bundle 让脚本 `import { runPetAssetOp }` 直接用。产物是
 * `_ipc.built.mjs`，**被 gitignore**（`verify/.gitignore` 的 `*.built.mjs`），
 * 不进仓库，跑之前先构建。
 *
 * ⚠ 之前这个构建命令**在仓库里没有任何记录**，产物却是 gitignore 的——
 * 等于「有个必须存在的文件，但没人知道怎么造」。这个脚本就是为了补上这一环。
 *
 * 用法：node verify/pet-sprite/characters/build-ipc.mjs
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../..')
const require = createRequire(path.join(REPO, 'package.json'))
const esbuild = require('esbuild')

const entry = path.join(REPO, 'apps/windows/src/main/pet/pet-asset-ipc.ts')
const outfile = path.join(HERE, '_ipc.built.mjs')

// 入口用 stdin 合成，而不是直接指向 pet-asset-ipc.ts：
// 验证脚本还要用 pet-core 的几何函数（`pointInPolygon` / `hitTestPolygons`）来**独立**
// 检验命中区（比如镜像之后多边形还盖不盖得住轮廓）。让它们在同一个 bundle 里导出，
// 脚本就只用 import 一次，也不必自己抄一份点在多边形内的实现——抄一份的话，
// 那份实现与被测的那份会各错各的，测出来的差异说明不了任何事。
const virtualEntry = `
export * from ${JSON.stringify(entry.replace(/\\/g, '/'))}
export { pointInPolygon, hitTestPolygons } from ${JSON.stringify(
  path.join(REPO, 'packages/pet-core/src/render/hit-polygon.ts').replace(/\\/g, '/'),
)}
`

const result = await esbuild.build({
  stdin: { contents: virtualEntry, resolveDir: REPO, loader: 'ts', sourcefile: 'verify-entry.ts' },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // sharp 是原生模块、electron 只有运行期才有——两者都不能打进来。
  // 打进来会在 import 期就炸（原生 .node 文件没法内联）。
  external: ['sharp', 'electron'],
  logLevel: 'warning',
  metafile: true,
})

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0
console.log(`✓ ${path.relative(REPO, outfile)}  ${(bytes / 1024).toFixed(0)} KB`)

// 立刻验一下导出都在——产物是给别的脚本 import 的，缺了要到运行时才发现
const mod = await import(`file://${outfile.replace(/\\/g, '/')}`)
const missing = ['runPetAssetOp', 'isPetAssetOp', 'describeRoots', 'pointInPolygon'].filter(
  (k) => typeof mod[k] !== 'function',
)
if (missing.length) {
  console.error(`✗ 产物缺少导出：${missing.join(', ')}`)
  process.exit(1)
}
console.log('✓ 导出检查通过：runPetAssetOp / isPetAssetOp / describeRoots / pointInPolygon')
console.log('  roots =', JSON.stringify(mod.describeRoots()))
