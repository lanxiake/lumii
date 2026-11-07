/**
 * 用 **Electron 自己的隐藏窗口**渲染 HTML 并录成 MP4。
 *
 * 为什么不用 playwright-core：外部扩展的 `main.js` 是独立打包后落到
 * `~/.lumii/extensions/<id>/` 的，那里的模块解析看不到应用的 node_modules。
 * 把 playwright-core 打进去要多背几 MB，还得自己维护一套 Chrome 探测链。
 * 而应用**本身就是 Chromium**——`BrowserWindow` + `capturePage()` 就是现成的。
 *
 * 录制方式：**逐帧 seek + capturePage**，而不是 `recordVideo`/真实播放时钟。
 * 页面动画由 `__seek(ms)` 驱动，逐帧截图能保证时间轴精确可复现；
 * 依赖墙钟会让无头/隐藏窗口的节流把帧率打乱（实测过 CSS transition 被降频）。
 */

import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'

import type { BrowserLike } from './render-backend'
import { FRAME } from './render-backend'
import { analyzeFrame, type FrameStats } from './gates/frame-check'

export interface ElectronRenderDeps {
  /** 主进程的 BrowserWindow 构造器（由插件入口从 electron 取，避免本文件直接 import electron） */
  createWindow: (options: {
    width: number
    height: number
    show: boolean
    webPreferences: Record<string, unknown>
  }) => ElectronWindowLike
  ffmpeg: {
    resolve: () => Promise<string | null>
    run: (args: readonly string[], opts?: { timeoutMs?: number }) => Promise<{ ok: boolean; stderr: string }>
  }
  /** 背景色（RGB），抽帧自检用它判断「哪些像素算有内容」；缺省黑 */
  backgroundRgb?: readonly [number, number, number]
  log: (msg: string) => void
}

/** BrowserWindow 的最小面（只声明本文件用到的部分，便于单测造假对象） */
export interface ElectronWindowLike {
  loadURL: (url: string) => Promise<void>
  webContents: {
    executeJavaScript: (code: string) => Promise<unknown>
    capturePage: () => Promise<{
      toPNG: () => Buffer
      /** 原始 BGRA 像素，抽帧自检直接用它统计，不用先编码成 PNG 再解码 */
      toBitmap: () => Buffer
      getSize: () => { width: number; height: number }
    }>
    setBackgroundThrottling?: (enabled: boolean) => void
    on?: (event: string, cb: (...args: unknown[]) => void) => void
    destroy?: () => void
  }
  destroy: () => void
  isDestroyed: () => boolean
}

/** 录制帧率：12fps 足够表现"逐步出现 + 高亮" */
const FPS = 12

/**
 * 创建一个可复用的渲染窗口。
 *
 * 单例复用：每节都新建 BrowserWindow 会让总耗时翻倍（窗口创建 + GPU 进程初始化）。
 */
export function createElectronRenderer(deps: ElectronRenderDeps): () => Promise<BrowserLike> {
  return async () => {
    /** 上次 renderSection 抽检的帧统计 */
    let lastSamples: FrameStats[] = []
    const win = deps.createWindow({
      width: FRAME.width,
      height: FRAME.height,
      show: false,
      webPreferences: {
        // 渲染的是模型产出的 HTML：必须隔离，不允许碰 Node
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        // 隐藏窗口默认会被降频，动画帧会跳变
        backgroundThrottling: false,
        offscreen: false,
      },
    })
    win.webContents.setBackgroundThrottling?.(false)

    const binder: BrowserLike = {
      lastFrameSamples: () => lastSamples,
      async renderSection(html: string, outMp4: string, totalMs: number, fps: number): Promise<void> {
        const framesDir = outMp4.replace(/\.mp4$/, '.frames')
        rmSync(framesDir, { recursive: true, force: true })
        mkdirSync(framesDir, { recursive: true })
        lastSamples = []
        try {
          // data: URL 避免落临时文件；体积上限内没问题（单节 HTML 一般 < 100KB）
          const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
          await win.loadURL(dataUrl)

          const effectiveFps = Math.max(1, Math.min(fps || FPS, 30))
          const stepMs = 1000 / effectiveFps
          const captures = Math.max(1, Math.ceil(totalMs / stepMs))
          // 抽检三帧：首、中、末。连通域是 O(像素) 的，每帧都算会让渲染时间翻倍；
          // 三帧足够判断「有没有画出来 / 是不是碎屑」
          const sampleAt = new Set([0, Math.floor(captures / 2), Math.max(0, captures - 1)])
          const bg = deps.backgroundRgb ?? ([0, 0, 0] as const)

          for (let i = 0; i < captures; i++) {
            const ms = Math.min(totalMs, Math.round(i * stepMs))
            await win.webContents.executeJavaScript(
              `window.__seek && window.__seek(${ms})`,
            )
            // 等一帧：让 CSS transition 落到布局后再截
            await win.webContents.executeJavaScript(
              'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))',
            )
            const img = await win.webContents.capturePage()
            if (sampleAt.has(i)) {
              const size = img.getSize()
              lastSamples.push(analyzeFrame(img.toBitmap(), size.width, size.height, bg))
            }
            writeFileSync(`${framesDir}/${String(i).padStart(5, '0')}.png`, img.toPNG())
          }

          const bin = await deps.ffmpeg.resolve()
          if (!bin) throw new Error('ffmpeg 不可用，无法合成视频')
          const r = await deps.ffmpeg.run(
            [
              '-y',
              '-framerate', String(effectiveFps),
              '-i', `${framesDir}/%05d.png`,
              // capturePage 拿的是**窗口内容区**，会比 BrowserWindow 的 width/height
              // 略小（有边框/缩放），实测 1280×720 的窗口截出来是 1264×655——而
              // libx264 要求宽高都是偶数，否则直接 "height not divisible by 2" 失败。
              // 所以这里统一按目标尺寸缩放并补齐到偶数。
              '-vf', `scale=${FRAME.width}:${FRAME.height}:force_original_aspect_ratio=decrease,pad=${FRAME.width}:${FRAME.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
              '-c:v', 'libx264',
              '-pix_fmt', 'yuv420p',
              '-preset', 'veryfast',
              '-crf', '23',
              outMp4,
            ],
            { timeoutMs: 180_000 },
          )
          if (!r.ok) throw new Error(`ffmpeg 编码失败: ${r.stderr.slice(-300)}`)
          deps.log(`[electron-render] ${path.basename(outMp4)} (${captures} 帧)`)
        } finally {
          rmSync(framesDir, { recursive: true, force: true })
        }
      },
      async close(): Promise<void> {
        if (!win.isDestroyed()) win.destroy()
      },
    }
    return binder
  }
}
