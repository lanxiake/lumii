/**
 * electron-builder beforePack 钩子。
 *
 * ## 为什么删这 4 个文件（2026-09-21）
 *
 * `@xenova/transformers/dist/ort-wasm*.wasm`（4 个，合计 36.6 MB）是 **onnxruntime-web 的
 * wasm** —— 只在浏览器分支加载。桌面端走 Node 分支（`transformers/src/backends/onnx.js` 里
 * `process.release.name === 'node'` → 用 `onnxruntime-node`），这 4 个文件**永不加载**。
 * 更强的证据：打包时 onnxruntime-web 本身就是用占位包顶替的，嵌入实测仍返回
 * `backend:"transformers"`（真 ONNX）——web 运行时整条链在桌面端都不参与。
 *
 * 为什么非得在钩子里删：`files` 的排除项对这几个文件**不生效**（实测两种配置都不掉：
 * 有 `asarUnpack: node_modules/@xenova/transformers/**\/*` 时被解包到 app.asar.unpacked、
 * 没有它时被塞进 app.asar，安装包大小一模一样）。`asarUnpack` 的白名单语义与 `files` 的排除
 * 是两套，压不到一起去，只能从源上删。
 *
 * 安全性与可逆性：
 * - 删的是**仓库 node_modules 里的文件**，不是用户数据；`pnpm install` 会按 store 恢复。
 * - 只删 `dist/` 下这 4 个后缀为 `.wasm` 的文件，且逐个校验文件名前缀，避免误删。
 * - 若哪天桌面端真的要跑 onnxruntime-web，删掉本钩子（或改文件名判断）即可恢复。
 *
 * @param {import('electron-builder').BeforePackContext} context
 */
const fs = require('node:fs')
const path = require('node:path')

/** 待删除的浏览器专用 wasm（onnxruntime-web 的运行时） */
const WEB_ONLY_WASM_PREFIX = 'ort-wasm'
const TRANSFORMERS_DIST_REL = path.join('node_modules', '@xenova', 'transformers', 'dist')

exports.default = async function beforePack(context) {
  // PackContext 上没有 appDir（只有 appOutDir/outDir/packager），应用根要从 packager 取
  const appDir = context.packager?.info?.appDir ?? context.packager?.projectDir ?? process.cwd()
  const distDir = path.join(appDir, TRANSFORMERS_DIST_REL)
  if (!fs.existsSync(distDir)) {
    // 包没装或布局变了都不该让打包失败——这只是省体积的优化
    console.log(`[before-pack] 跳过 web-only wasm 清理（未找到 ${distDir}）`)
    return
  }

  const removed = []
  for (const name of fs.readdirSync(distDir)) {
    if (!name.startsWith(WEB_ONLY_WASM_PREFIX) || !name.endsWith('.wasm')) continue
    fs.rmSync(path.join(distDir, name), { force: true })
    removed.push(name)
  }

  if (removed.length > 0) {
    console.log(`[before-pack] 已移除 ${removed.length} 个浏览器专用 wasm（桌面端不加载）: ${removed.join(', ')}`)
  } else {
    console.log('[before-pack] 浏览器专用 wasm 已不存在（可能已清理或被 pnpm 更新布局）')
  }
}
