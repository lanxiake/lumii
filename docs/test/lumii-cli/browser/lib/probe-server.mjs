/**
 * probe-server — 给浏览器套件提供确定性页面
 *
 * 为什么不用外网：外网的可用性、内容、加载时长都不可控，任何断言都只能是软断言；
 * 而「浏览器操作准不准」必须靠硬断言回答。所以页面自己发，每个交互的结果都写进
 * `window.__probe`，由 CDP 观测器读回来比对。
 *
 * 端口固定高位（避开 Lumii 自己的 18790/18791/18793/18795 与 5174）。
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, '../fixtures')

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }

/**
 * 起一个只服务 fixtures/ 的静态服务器。
 * @param {number} port
 * @returns {Promise<{origin:string, port:number, close:()=>Promise<void>}>}
 */
export async function startProbeServer(port = 18799) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
    const rel = urlPath === '/' ? 'interact.html' : urlPath.replace(/^\/+/, '')
    const full = path.resolve(FIXTURES, rel)

    // 目录穿越防护：解析后必须仍在 fixtures 内
    if (!full.startsWith(FIXTURES)) {
      res.writeHead(403).end('forbidden')
      return
    }
    fs.readFile(full, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`not found: ${rel}`)
        return
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(full)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      }).end(data)
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })

  const actual = server.address().port
  return {
    origin: `http://127.0.0.1:${actual}`,
    port: actual,
    close: () =>
      new Promise((resolve) => {
        // 必须先断开已建立的连接：Chrome 会对探针页保持 keep-alive，
        // 只调 close() 会一直等这些连接自己结束 → 子进程不退出 → 端口不释放，
        // 下一次运行就报「探针服务器未能就绪」（2026-09-21 实测踩到）。
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}
