/**
 * SplashOverlay — 主窗口内全屏开机画面
 *
 * 视觉与音效由 `early-splash` 在 React 挂载前就已开始（HTML/Canvas 渲染，不是视频），
 * 这里只负责一件事：**在主壳真正可交互的那一刻收尾**。
 *
 * 收尾顺序：主壳就绪 → 进度冲到 100% → 音效收尾 → 淡出 → 进入首页。
 * 不再有「视频固定 10 秒」那种与真实加载脱钩的等待。
 */

import React, { useCallback, useEffect, useRef } from 'react'
import { EARLY_ID, getBootAudio, getBootVisual, releaseBootVisual } from '../../early-splash'
import { markSplashPlayedThisSession } from '../../utils/splash-preference'

export interface SplashOverlayProps {
  /** 播放结束（或跳过/出错）后回调 */
  onDone: () => void
  /**
   * 主界面已可展示时 resolve。开机画面会等它，避免揭开后几秒卡顿；
   * 但最长只等 `READY_TIMEOUT_MS`，主壳异常时不能把用户永远挡在外面。
   */
  waitForReady?: () => Promise<void>
}

/** 等主壳就绪的上限：超时直接放行，宁可略微卡一下也不卡死 */
const READY_TIMEOUT_MS = 8000
/** 主壳就绪后额外稳定一帧，再开始淡出 */
const SETTLE_MS = 120
/**
 * 最短展示时长。
 *
 * 主壳挂载其实很快（百毫秒级），不设下限时开机动画会「闪一下」就没了——
 * 既看不清，也比纯黑屏更显得像卡顿。1.6s 是「看得清这是开机画面、
 * 又不会让人等」的量级；真实加载更慢时以真实加载为准。
 */
const MIN_DISPLAY_MS = 1600

/**
 * 等两帧 rAF，确保底层 UI 已提交绘制
 */
function waitTwoFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve())
    })
  })
}

export const SplashOverlay: React.FC<SplashOverlayProps> = ({ onDone, waitForReady }) => {
  const doneRef = useRef(false)
  /** 挂载时刻：用于最短展示时长的下限 */
  const mountedAtRef = useRef(performance.now())

  const finish = useCallback(async () => {
    if (doneRef.current) return
    doneRef.current = true
    markSplashPlayedThisSession()

    try {
      if (waitForReady) {
        await Promise.race([
          waitForReady(),
          new Promise<void>((r) => window.setTimeout(r, READY_TIMEOUT_MS)),
        ])
      }
    } catch {
      // 就绪等待失败不阻塞退出 splash
    }

    // 主壳比动画快时补足最短时长，避免闪一下
    const remaining = MIN_DISPLAY_MS - (performance.now() - mountedAtRef.current)
    if (remaining > 0) {
      await new Promise<void>((r) => window.setTimeout(r, remaining))
    }

    await waitTwoFrames()
    await new Promise<void>((r) => window.setTimeout(r, SETTLE_MS))

    const audio = getBootAudio()
    const visual = getBootVisual()

    // 视觉与音效并行收尾：音效最多占 600ms，视觉淡出 420ms，取长者
    const visualDone = visual ? visual.complete() : Promise.resolve()
    const audioDone = audio ? audio.finish() : Promise.resolve()
    await Promise.all([visualDone, audioDone])

    // visual.complete() 已自行淡出并移除 DOM；这里兜底清掉早期节点与句柄
    document.getElementById(EARLY_ID)?.remove()
    releaseBootVisual()
    onDone()
  }, [onDone, waitForReady])

  useEffect(() => {
    void finish()
  }, [finish])

  // 视觉层在 early-splash 里已挂载到 body，这里不再渲染任何 DOM
  return null
}
