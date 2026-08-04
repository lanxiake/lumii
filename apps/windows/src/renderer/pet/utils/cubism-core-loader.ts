/**
 * Cubism Core 动态加载
 *
 * live2dcubismcore.min.js 是 Live2D 官方专有文件（免费可分发），不在 npm。
 * pixi-live2d-display/cubism4 运行时依赖全局 window.Live2DCubismCore。
 *
 * 加载策略：
 *  - 优先检测是否已存在（index.html 静态注入或之前已加载）
 *  - 否则从约定路径动态注入 <script>
 *  - dev：/live2d/live2dcubismcore.min.js（renderer public 或 resources 经 dev server 暴露）
 *  - 打包：通过 file:// 相对路径加载（与 index.html 同级的 live2d 目录）
 *
 * 文件缺失时 reject，由调用方降级提示（不崩溃）。
 */

const CORE_GLOBAL = 'Live2DCubismCore'
/** dev 模式下 Vite 中间件暴露的 Core 脚本路径 */
const DEV_CORE_SCRIPT_PATH = '/live2d/live2dcubismcore.min.js'

let loadPromise: Promise<void> | null = null

/**
 * 解析 Cubism Core 脚本 URL。
 * 优先向主进程索取（生产 file:// / dev file:// 均可用），
 * dev + Vite http 时主进程返回 /live2d/... 走中间件。
 */
async function resolveCoreScriptUrl(): Promise<string> {
  const fromMain = await window.electronAPI?.pet?.getCubismCoreUrl?.()
  if (fromMain) return fromMain
  // 兜底：dev server 中间件
  return DEV_CORE_SCRIPT_PATH
}

function isCoreLoaded(): boolean {
  return typeof (window as unknown as Record<string, unknown>)[CORE_GLOBAL] !== 'undefined'
}

/**
 * 确保 Cubism Core 已加载。幂等：多次调用共享同一 Promise。
 * @throws 加载失败（文件缺失/网络错误）时 reject
 */
export function ensureCubismCore(): Promise<void> {
  if (isCoreLoaded()) return Promise.resolve()
  if (loadPromise) return loadPromise

  loadPromise = (async () => {
    const scriptUrl = await resolveCoreScriptUrl()
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = scriptUrl
      script.async = true
      script.onload = () => {
        if (isCoreLoaded()) {
          resolve()
        } else {
          reject(new Error('live2dcubismcore.min.js 已加载但未暴露 Live2DCubismCore 全局对象'))
        }
      }
      script.onerror = () => {
        reject(
          new Error(
            `无法加载 Cubism Core：${scriptUrl}。请将 live2dcubismcore.min.js 放入 resources/live2d/ 目录`,
          ),
        )
      }
      document.head.appendChild(script)
    })
  })().catch((err) => {
    loadPromise = null
    throw err
  })

  return loadPromise
}

export { isCoreLoaded }
