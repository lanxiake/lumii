import { defineConfig } from 'vite'
import { resolve, join, normalize, extname } from 'path'
import { readFile } from 'fs'
import type { Plugin } from 'vite'

/**
 * 口型/表情/动作可视化 lab —— 独立 vite 页面，浏览器直接跑，无需 electron/gateway/agent。
 *
 * 复用 apps/windows/resources 下的真实 Live2D 模型与 cubismcore，
 * 通过中间件把 /live2d /pet-models 映射到 resources 目录（与 electron.vite.config 的 dev 插件一致）。
 *
 * 启动：pnpm lab（见 package.json），默认 http://127.0.0.1:5175
 */

const WINDOWS_ROOT = resolve(__dirname, '..')
const RESOURCES = resolve(WINDOWS_ROOT, 'resources')
/**
 * 三方案变体夹具：**测试夹具，不是随包资源**（2026-09-24 从
 * `resources/pet-models/_variants/` 搬到 `sprite-assets.test.ts` 旁边）。
 * lab 里仍然要看它们，所以单开一条前缀映射——别把它塞回 resources。
 */
const FIXTURES = resolve(WINDOWS_ROOT, 'src/renderer/pet/renderer/sprite/fixtures')

/** URL 前缀 → 磁盘根。顺序即匹配顺序。 */
const MOUNTS: ReadonlyArray<readonly [string, string]> = [
  ['/live2d/', RESOURCES],
  ['/pet-models/', RESOURCES],
  ['/pet-fixtures/', FIXTURES],
]

function petResourcesPlugin(): Plugin {
  return {
    name: 'pet-lab-resources',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ? decodeURIComponent(req.url.split('?')[0]) : ''
        const mount = MOUNTS.find(([prefix]) => url.startsWith(prefix))
        if (!mount) {
          return next()
        }
        const [prefix, root] = mount
        const safeRel = normalize(url.slice(prefix.length)).replace(/^(\.\.[/\\])+/, '')
        const filePath = join(root, safeRel)
        if (!filePath.startsWith(root)) {
          res.statusCode = 403
          return res.end('Forbidden')
        }
        readFile(filePath, (err, data) => {
          if (err) {
            res.statusCode = 404
            return res.end('Not found')
          }
          const ext = extname(filePath).toLowerCase()
          const mime: Record<string, string> = {
            '.js': 'text/javascript',
            '.json': 'application/json',
            '.moc3': 'application/octet-stream',
            '.png': 'image/png',
            '.wasm': 'application/wasm',
          }
          res.setHeader('Content-Type', mime[ext] ?? 'application/octet-stream')
          res.end(data)
        })
      })
    },
  }
}

export default defineConfig({
  root: __dirname,
  server: {
    port: 5175,
    host: '127.0.0.1',
  },
  resolve: {
    alias: {
      '@shared': resolve(WINDOWS_ROOT, 'src/shared'),
    },
  },
  optimizeDeps: {
    include: ['pixi.js', 'pixi-live2d-display/cubism4'],
  },
  plugins: [petResourcesPlugin()],
})
