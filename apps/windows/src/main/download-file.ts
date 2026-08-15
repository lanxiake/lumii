/**
 * 带重定向与进度回调的文件下载（主进程用）
 *
 * 从 index.ts 抽出，供 Python 运行时自动安装与 MemPalace 插件共用。
 * 不依赖 electron，可在纯 Node 环境下使用。
 */

import { createWriteStream, promises as fsp } from 'node:fs'
import http from 'node:http'
import https from 'node:https'

const MAX_REDIRECTS = 5

/**
 * 下载文件到 dest。
 *
 * 写入流延迟到拿到最终 200 响应（重定向解析完）后再创建，
 * 避免重定向时关闭旧流却仍向其 pipe，导致目标文件为空。
 */
export async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (pct: number) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false

    const fail = (err: Error) => {
      if (settled) return
      settled = true
      reject(err)
    }

    const request = (targetUrl: string, redirectsLeft: number) => {
      const client = targetUrl.startsWith('https') ? https : http
      client
        .get(targetUrl, (res) => {
          const status = res.statusCode ?? 0
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume() // 丢弃重定向响应体，释放 socket
            if (redirectsLeft <= 0) {
              fail(new Error(`重定向次数过多: ${targetUrl}`))
              return
            }
            const next = new URL(res.headers.location, targetUrl).toString()
            request(next, redirectsLeft - 1)
            return
          }
          if (status !== 200) {
            res.resume()
            fail(new Error(`HTTP ${status}: ${targetUrl}`))
            return
          }

          const total = parseInt(res.headers['content-length'] ?? '0', 10)
          let received = 0
          const file = createWriteStream(dest)
          file.on('error', fail)
          res.on('error', fail)
          res.on('data', (chunk: Buffer) => {
            received += chunk.length
            if (total > 0 && onProgress) {
              onProgress(Math.round((received / total) * 100))
            }
          })
          res.pipe(file)
          file.on('finish', () => {
            file.close(() => {
              if (settled) return
              settled = true
              resolve()
            })
          })
        })
        .on('error', fail)
    }

    request(url, MAX_REDIRECTS)
  })

  // 下载成功校验：文件必须存在且非空，否则后续解压会报"找不到文件"
  let size = 0
  try {
    size = (await fsp.stat(dest)).size
  } catch {
    throw new Error(`下载失败：文件未生成（${dest}）`)
  }
  if (size === 0) {
    await fsp.rm(dest, { force: true }).catch(() => {})
    throw new Error(`下载失败：文件为空（${dest}）`)
  }
}
