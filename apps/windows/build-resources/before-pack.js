/**
 * electron-builder beforePack 钩子：打包前删掉「运行时绝不可能加载」的死重。
 *
 * ## 为什么必须在钩子里删、而不是写 `files` 排除项
 *
 * 实测 `files` 的排除对某些路径**不生效** —— 只要同一目录下有文件命中 `asarUnpack`
 * 白名单，该目录下的内容就会被强制收进包（`asarUnpack` 是独立白名单，与 `files` 的排除
 * 是两套规则）。两类死重都验证过这一现象：写 `files` 排除 → 仍在包里；在 `asarUnpack`
 * 里加 `!` 取反 → 只是从「解包」变成「打进 asar」，安装包大小一模一样。
 * **删源文件是唯一确定生效的做法**（`pnpm install` 会按 store 恢复）。
 *
 * ## 删什么
 *
 * 1. `@xenova/transformers/dist/**`（~43 MB）
 *    = 4 个 `ort-wasm*.wasm`（36.6 MB，onnxruntime-web 的运行时） + webpack 产物与
 *    两个 sourcemap（6.5 MB）。该包的 `main` 是 **`./src/transformers.js`** —— Node/Electron
 *    加载的是 `src/`，`dist/` 只服务浏览器打包器。更强的证据：打包时 onnxruntime-web 本身
 *    已被 2 KB 占位包顶替，嵌入实测仍返回 `backend:"transformers"`（真 ONNX）。
 *    本仓库渲染层也不引用 transformers（embedding 全在主进程）。
 *
 * 2. `onnxruntime-node/bin/napi-v3/<平台>/arm64/`（8.9 MB）
 *    异构架原生库。本仓只出 x64（`package-app.js` 的 `--arch` 默认 x64），arm64 的 DLL
 *    在 x64 进程里加载不到，属纯死重。
 *
 * ## 可逆性与安全边界
 *
 * 只删上面两类；目录不存在就跳过，不让打包失败。若哪天桌面端真的要跑 onnxruntime-web、
 * 出 arm64 产物，或让浏览器侧用 transformers，删掉对应段落即可。
 *
 * @param {import('electron-builder').BeforePackContext} context
 */
const fs = require('node:fs')
const path = require('node:path')

/** transformers 里只服务浏览器打包器的目录（Node 侧入口是 src/transformers.js） */
const TRANSFORMERS_DIST_REL = path.join('node_modules', '@xenova', 'transformers', 'dist')

/** 异构架原生库根目录（其下按平台分目录，再按 arch 分目录） */
const ONNXRUNTIME_BIN_REL = path.join('node_modules', 'onnxruntime-node', 'bin', 'napi-v3')

function dirSize(dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size
  }
  return total
}

/** 删掉 transformers 的 `dist/`（浏览器产物 + ort-wasm），Node 侧走 `src/` */
function removeTransformersBrowserDist(appDir) {
  const distDir = path.join(appDir, TRANSFORMERS_DIST_REL)
  if (!fs.existsSync(distDir)) {
    console.log(`[before-pack] 跳过 transformers dist 清理（未找到 ${distDir}）`)
    return
  }
  const mb = (dirSize(distDir) / 1024 / 1024).toFixed(1)
  const entries = fs.readdirSync(distDir).length
  fs.rmSync(distDir, { recursive: true, force: true })
  console.log(`[before-pack] 已移除 transformers 的浏览器打包产物 dist/（${mb} MB / ${entries} 项，Node 侧走 src/）`)
}

/** 删掉 onnxruntime-node 里非 x64 的原生库目录 */
function removeForeignArchRuntime(appDir) {
  const binDir = path.join(appDir, ONNXRUNTIME_BIN_REL)
  if (!fs.existsSync(binDir)) {
    console.log(`[before-pack] 跳过异构架运行时清理（未找到 ${binDir}）`)
    return
  }
  const removed = []
  for (const platform of fs.readdirSync(binDir)) {
    const platformDir = path.join(binDir, platform)
    if (!fs.statSync(platformDir).isDirectory()) continue
    for (const arch of fs.readdirSync(platformDir)) {
      if (arch === 'x64') continue // 本仓只出 x64
      const archDir = path.join(platformDir, arch)
      if (!fs.statSync(archDir).isDirectory()) continue
      const mb = (dirSize(archDir) / 1024 / 1024).toFixed(1)
      fs.rmSync(archDir, { recursive: true, force: true })
      removed.push(`${platform}/${arch} (${mb} MB)`)
    }
  }
  if (removed.length > 0) {
    console.log(`[before-pack] 已移除异构架原生库（本仓只出 x64）: ${removed.join(', ')}`)
  }
}

exports.default = async function beforePack(context) {
  // PackContext 上没有 appDir（只有 appOutDir/outDir/packager），应用根要从 packager 取
  const appDir = context.packager?.info?.appDir ?? context.packager?.projectDir ?? process.cwd()
  removeTransformersBrowserDist(appDir)
  removeForeignArchRuntime(appDir)
}
