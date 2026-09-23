/**
 * webview / iframe 划词桥接测试
 *
 * 这一层的价值全在「坐标翻译」与「形状校验」上，正好是纯函数能测的部分：
 * guest 给的是它自己视口里的坐标，宿主必须加上 webview 元素的位置，
 * 否则浮条会整体漂移（预览不在左上角时尤其明显）。
 */
import { describe, expect, it } from 'vitest'
import { buildIframeSelectionInjection, toHostPoint, toSelectionSnapshot } from './webview-bridge'

const FRAME = { left: 300, top: 120 }
const GUEST_RECT = { top: 40, left: 25, width: 200, height: 18 }

describe('toSelectionSnapshot', () => {
  it('坐标加上 webview 在宿主里的位置，并给出 markdown-preview 出处', () => {
    const snapshot = toSelectionSnapshot(
      {
        type: 'show',
        text: '预览里的一段文字',
        rect: GUEST_RECT,
        anchorRect: { top: 50, left: 25, width: 120, height: 18 },
      },
      FRAME,
      1000,
    )

    expect(snapshot).not.toBeNull()
    expect(snapshot!.rect).toEqual({ top: 160, left: 325, width: 200, height: 18 })
    expect(snapshot!.anchorRect).toEqual({ top: 170, left: 325, width: 120, height: 18 })
    expect(snapshot!.source.kind).toBe('markdown-preview')
    expect(snapshot!.text).toBe('预览里的一段文字')
    expect(snapshot!.createdAt).toBe(1000)
  })

  it('缺 anchorRect 时退回 rect（浮条不能没有锚点）', () => {
    const snapshot = toSelectionSnapshot(
      { type: 'show', text: '文字', rect: GUEST_RECT },
      FRAME,
    )
    expect(snapshot!.anchorRect).toEqual(snapshot!.rect)
  })

  it('close 事件不产生快照', () => {
    expect(toSelectionSnapshot({ type: 'close' }, FRAME)).toBeNull()
  })

  it('空文本不产生快照（与宿主侧 buildSnapshot 的口径一致）', () => {
    expect(toSelectionSnapshot({ type: 'show', text: '   ', rect: GUEST_RECT }, FRAME)).toBeNull()
  })

  it('矩形字段不合法时不产生快照（跨进程消息不做形状假设）', () => {
    expect(toSelectionSnapshot({ type: 'show', text: 'x' }, FRAME)).toBeNull()
    expect(
      toSelectionSnapshot(
        { type: 'show', text: 'x', rect: { top: NaN, left: 0, width: 1, height: 1 } },
        FRAME,
      ),
    ).toBeNull()
    expect(
      toSelectionSnapshot(
        { type: 'show', text: 'x', rect: { top: 0, left: 0, width: '2' as never, height: 1 } },
        FRAME,
      ),
    ).toBeNull()
  })
})

describe('toHostPoint', () => {
  it('指针位置同样平移（菜单要弹在指针处）', () => {
    expect(toHostPoint({ x: 10, y: 20 }, FRAME)).toEqual({ x: 310, y: 140 })
  })

  it('没有指针位置时返回 undefined（bar 不靠它）', () => {
    expect(toHostPoint(undefined, FRAME)).toBeUndefined()
  })
})

describe('buildIframeSelectionInjection', () => {
  const NONCE = 'abc123'
  const injection = buildIframeSelectionInjection(NONCE)

  it('自带标记与两种 surface，且不得包含裸的 </script> 造成 srcDoc 截断', () => {
    expect(injection).toContain('lumii-selection')
    expect(injection).toContain("surface: 'bar'")
    expect(injection).toContain("surface: 'menu'")
    // 脚本自身只能有一个收尾标签
    expect(injection.match(/<\/script>/g)).toHaveLength(1)
  })

  it('CSP 排在脚本之前，且只授权本次 nonce', () => {
    // meta 形式的 CSP 只对出现在它之后的内容生效，顺序错了等于没写
    expect(injection.indexOf('Content-Security-Policy')).toBeLessThan(
      injection.indexOf('<script'),
    )
    expect(injection).toContain(`script-src 'nonce-${NONCE}'`)
    expect(injection).toContain(`<script nonce="${NONCE}">`)
  })
})
