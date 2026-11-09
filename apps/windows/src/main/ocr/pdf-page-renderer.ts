/**
 * 用 pdfjs-dist 将 PDF 页渲染为 PNG（依赖 @napi-rs/canvas，按需动态加载）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createLogger } from '../logger.js'
import type { PdfPageRenderer, RenderedPdfPage } from './ocr-scanned-document.js'

const log = createLogger('PdfPageRenderer')

/**
 * 创建默认 PDF 页渲染器；缺少 canvas 依赖时返回 null。
 */
export function tryCreatePdfPageRenderer(): PdfPageRenderer | null {
  try {
    // 动态探测，避免未安装时拖垮主进程启动
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require.resolve('@napi-rs/canvas')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require.resolve('pdfjs-dist')
  } catch {
    log.warn('PDF 页渲染不可用：缺少 @napi-rs/canvas 或 pdfjs-dist')
    return null
  }
  return renderPdfPagesWithPdfJs
}

/**
 * 将 PDF 前 N 页渲染为 PNG 文件。
 */
export async function renderPdfPagesWithPdfJs(input: {
  pdfPath: string
  outputDir: string
  maxPages?: number
}): Promise<RenderedPdfPage[]> {
  // pdfjs 5 在 Node 下走 legacy 构建更稳；类型宽松处理避免版本路径漂移
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as {
    getDocument: (src: Record<string, unknown>) => { promise: Promise<PdfDocumentLike> }
  }
  const { createCanvas } = await import('@napi-rs/canvas')

  const data = new Uint8Array(fs.readFileSync(input.pdfPath))
  const loadingTask = pdfjs.getDocument({
    data,
    disableWorker: true,
    useSystemFonts: true,
  })
  const pdf = await loadingTask.promise
  const maxPages = Math.min(pdf.numPages, input.maxPages ?? 30)
  fs.mkdirSync(input.outputDir, { recursive: true })

  const pages: RenderedPdfPage[] = []
  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum)
    const viewport = page.getViewport({ scale: 1.5 })
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    const context = canvas.getContext('2d')
    await page.render({
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise
    const outPath = path.join(input.outputDir, `page-${pageNum}.png`)
    fs.writeFileSync(outPath, canvas.toBuffer('image/png'))
    pages.push({ pageIndex: pageNum - 1, imagePath: outPath })
    page.cleanup()
  }
  await pdf.destroy()
  return pages
}

type PdfDocumentLike = {
  numPages: number
  getPage: (n: number) => Promise<{
    getViewport: (opts: { scale: number }) => { width: number; height: number }
    render: (opts: {
      canvasContext: CanvasRenderingContext2D
      viewport: { width: number; height: number }
    }) => { promise: Promise<void> }
    cleanup: () => void
  }>
  destroy: () => Promise<void>
}
