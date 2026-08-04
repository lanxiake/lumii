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

function petResourcesPlugin(): Plugin {
  return {
    name: 'pet-lab-resources',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ? decodeURIComponent(req.url.split('?')[0]) : ''
        if (!url.startsWith('/live2d/') && !url.startsWith('/pet-models/')) {
          return next()
        }
        const safeRel = normalize(url).replace(/^(\.\.[/\\])+/, '')
        const filePath = join(RESOURCES, safeRel)
        if (!filePath.startsWith(RESOURCES)) {
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
