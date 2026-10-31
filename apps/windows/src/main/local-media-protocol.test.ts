/**
 * lumii-local 协议的 Range 分片。
 * 播放卡死的根因是这里回整段 200，所以断言 206 + Content-Range 是本测重点。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs, { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let handler: ((request: Request) => Response | Promise<Response>) | null = null

vi.mock('electron', () => ({
  protocol: {
    handle: (_scheme: string, cb: (request: Request) => Response | Promise<Response>) => {
      handler = cb
    },
  },
}))

import {
  parseByteRange,
  mimeForLocalMedia,
  registerLocalMediaProtocolHandler,
  buildLocalMediaUrl,
  buildLocalMediaFileUrl,
  buildLocalMediaDirUrl,
  resolveLocalMediaFilePath,
  allowLocalMediaPreviewPath,
} from './local-media-protocol'

const root = mkdtempSync(path.join(tmpdir(), 'lumii-local-media-'))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('parseByteRange', () => {
  it('解析闭区间、开区间与后缀区间', () => {
    expect(parseByteRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseByteRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseByteRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
  })

  it('end 越界收窄到末字节', () => {
    expect(parseByteRange('bytes=0-99999', 1000)).toEqual({ start: 0, end: 999 })
  })

  it('非法或不可满足的区间返回 null', () => {
    expect(parseByteRange('bytes=1000-', 1000)).toBeNull()
    expect(parseByteRange('bytes=500-100', 1000)).toBeNull()
    expect(parseByteRange('items=0-1', 1000)).toBeNull()
    expect(parseByteRange('bytes=-', 1000)).toBeNull()
  })
})

describe('mimeForLocalMedia', () => {
  it('按扩展名给出可解码类型', () => {
    expect(mimeForLocalMedia('/a/b.mp4')).toBe('video/mp4')
    expect(mimeForLocalMedia('/a/b.MOV')).toBe('video/quicktime')
    expect(mimeForLocalMedia('/a/b.mp3')).toBe('audio/mpeg')
    expect(mimeForLocalMedia('/a/b.unknown')).toBe('application/octet-stream')
  })
})

describe('路径式 URL（HTML 相对资源用）', () => {
  beforeEach(() => {
    registerLocalMediaProtocolHandler()
  })

  it('目录 URL 带末尾斜杠，文件 URL 可还原成磁盘路径', () => {
    expect(buildLocalMediaDirUrl('E:\\ws\\preview')).toBe('lumii-local://local/E:/ws/preview/')
    expect(buildLocalMediaFileUrl('E:\\ws\\preview\\a.html')).toBe(
      'lumii-local://local/E:/ws/preview/a.html',
    )
    expect(resolveLocalMediaFilePath('lumii-local://local/E:/ws/preview/images/a.png')).toBe(
      'E:/ws/preview/images/a.png',
    )
    expect(resolveLocalMediaFilePath('lumii-local://media/?path=E%3A%5Cws%5Ca.png')).toBeNull()
  })

  it('路径式请求能取到文件，目录登记后其子文件也放行', async () => {
    const dir = path.join(root, 'preview')
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'page.html'), '<html></html>')
    fs.writeFileSync(path.join(dir, 'images', 'a.png'), Buffer.alloc(8, 1))
    allowLocalMediaPreviewPath(dir)

    const pageRes = await handler!(new Request(buildLocalMediaFileUrl(path.join(dir, 'page.html'))))
    expect(pageRes.status).toBe(200)
    await pageRes.body?.cancel()

    const imgRes = await handler!(
      new Request(buildLocalMediaFileUrl(path.join(dir, 'images', 'a.png'))),
    )
    expect(imgRes.status).toBe(200)
    expect(imgRes.headers.get('content-type')).toBe('image/png')
    await imgRes.body?.cancel()
  })
})

describe('registerLocalMediaProtocolHandler', () => {
  beforeEach(() => {
    registerLocalMediaProtocolHandler()
  })

  it('无 Range 返回 200 全量并声明 Accept-Ranges', async () => {
    const file = path.join(root, 'a.mp4')
    writeFileSync(file, Buffer.alloc(1000, 7))
    allowLocalMediaPreviewPath(file)

    const res = await handler!(new Request(buildLocalMediaUrl(file)))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('1000')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-type')).toBe('video/mp4')
    await res.body?.cancel()
  })

  it('带 Range 返回 206 与 Content-Range（seek/续缓冲的前提）', async () => {
    const file = path.join(root, 'b.mp4')
    writeFileSync(file, Buffer.alloc(1000, 7))
    allowLocalMediaPreviewPath(file)

    const res = await handler!(
      new Request(buildLocalMediaUrl(file), { headers: { range: 'bytes=200-299' } }),
    )
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 200-299/1000')
    expect(res.headers.get('content-length')).toBe('100')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(bytes.length).toBe(100)
  })

  it('越界 Range 返回 416', async () => {
    const file = path.join(root, 'c.mp4')
    writeFileSync(file, Buffer.alloc(10))
    allowLocalMediaPreviewPath(file)

    const res = await handler!(
      new Request(buildLocalMediaUrl(file), { headers: { range: 'bytes=100-200' } }),
    )
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */10')
  })

  it('未登记路径返回 403', async () => {
    const res = await handler!(new Request(buildLocalMediaUrl(path.join(root, 'nope.mp4'))))
    expect(res.status).toBe(403)
  })
})
