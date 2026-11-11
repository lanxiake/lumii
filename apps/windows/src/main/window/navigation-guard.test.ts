/**
 * 主窗口导航白名单测试
 *
 * 纯函数，不碰 Electron —— 判据是「哪些 URL 算换了界面」，
 * 不是「Electron 的事件长什么样」。
 */
import { describe, expect, it } from 'vitest'
import { shouldBlockMainFrameNavigation } from './navigation-guard'

const DEV = 'http://localhost:5173'

describe('shouldBlockMainFrameNavigation', () => {
  it('dev 下渲染层自己的 origin 放行', () => {
    expect(shouldBlockMainFrameNavigation(`${DEV}/?foo=1`, DEV)).toBe(false)
  })

  it('dev 下外部站点拦下（2026-11-11 小红书那次）', () => {
    expect(shouldBlockMainFrameNavigation('https://creator.xiaohongshu.com/login', DEV)).toBe(true)
  })

  it('生产模式（无 dev server）任何 http(s) 都拦', () => {
    expect(shouldBlockMainFrameNavigation('https://creator.xiaohongshu.com', undefined)).toBe(true)
    expect(shouldBlockMainFrameNavigation('http://127.0.0.1:54345/', undefined)).toBe(true)
  })

  it('非 http(s) 一律放行（初始页 / 本地文件 / 自定义协议）', () => {
    expect(shouldBlockMainFrameNavigation('about:blank', DEV)).toBe(false)
    expect(shouldBlockMainFrameNavigation('file:///C:/app/renderer/index.html', undefined)).toBe(false)
    expect(shouldBlockMainFrameNavigation('lumii-local://media/?path=x', undefined)).toBe(false)
  })

  it('端口不同视为不同 origin', () => {
    expect(shouldBlockMainFrameNavigation('http://localhost:5174/', DEV)).toBe(true)
  })

  it('URL 解析失败时默认拦（默认拒绝，不默认放行）', () => {
    expect(shouldBlockMainFrameNavigation('http://[bad', DEV)).toBe(true)
  })
})
