/**
 * 浏览器工具产物落盘（@mtbot/browser-control 的 BrowserMediaStore 实现）。
 *
 * `/screenshot`、`/pdf`、labels 快照路由在内存里产出 Buffer，这里写入
 * `{workspace}/temp/screenshots` —— 与 app_screenshot 同目录，渲染层可经
 * lumii-local 协议预览（ACL 见 preview-path-acl.ts）。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { BrowserMediaStore } from '@mtbot/browser-control'
import { createLogger } from './logger'
import { resolveScreenshotTempDir } from './workspace-paths'

const log = createLogger('BrowserMediaStore')

/** MIME → 扩展名；未知类型回退 .bin */
const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'application/pdf': '.pdf',
}

/**
 * 清洗文件名前缀：只保留字母数字与连字符（防路径穿越），空串回退 "browser"。
 */
export function sanitizeMediaPrefix(prefix: string): string {
  const cleaned = prefix.replace(/[^a-zA-Z0-9-]/g, '')
  return cleaned || 'browser'
}

/**
 * 生成落盘文件名：`<prefix>-<timestamp>-<sequence><ext>`。
 * 序号保证同一毫秒内多次落盘不互相覆盖。
 */
export function buildBrowserMediaFileName(
  prefix: string,
  mime: string,
  timestamp: number,
  sequence: number,
): string {
  const ext = MIME_EXTENSIONS[mime] ?? '.bin'
  return `${sanitizeMediaPrefix(prefix)}-${timestamp}-${sequence}${ext}`
}

/**
 * 创建写入工作区截图目录的 media store（进程内单例注入给 browser-control）。
 */
export function createBrowserMediaStore(): BrowserMediaStore {
  let sequence = 0
  return {
    async ensureMediaDir(): Promise<void> {
      resolveScreenshotTempDir()
    },
    async saveMediaBuffer(buffer, mime, prefix, maxBytes): Promise<{ path: string }> {
      const dir = resolveScreenshotTempDir()
      const fileName = buildBrowserMediaFileName(prefix, mime, Date.now(), ++sequence)
      const filePath = path.join(dir, fileName)
      if (maxBytes > 0 && buffer.byteLength > maxBytes) {
        log.warn(
          `[saveMediaBuffer] 产物超过体积上限仍落盘: ${buffer.byteLength}B > ${maxBytes}B, file=${fileName}`,
        )
      }
      await fs.promises.writeFile(filePath, buffer)
      log.info(`[saveMediaBuffer] 已保存浏览器产物 ${fileName} (${buffer.byteLength}B, ${mime})`)
      return { path: filePath }
    },
  }
}
