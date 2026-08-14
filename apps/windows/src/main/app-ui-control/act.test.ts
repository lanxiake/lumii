/**
 * @vitest-environment jsdom
 * 本文件含 eval 注入脚本的 DOM 行为断言，需在 jsdom 下运行（从仓库根目录跑 vitest 时也生效）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertClickAllowed,
  buildScrollScript,
  buildTypeScript,
  isKeyAllowed,
  KEY_WHITELIST,
} from './act'
import type { AppUiClickContext, AppUiRef } from './types'

const sampleRef: AppUiRef = {
  ref: 'e1',
  role: 'button',
  name: '设置',
  x: 10,
  y: 20,
  w: 100,
  h: 40,
}

const current: AppUiClickContext = {
  snapshotId: '42',
  refs: [sampleRef],
}

describe('assertClickAllowed', () => {
  it('缺少 ref 返回 missing_ref', () => {
    expect(
      assertClickAllowed({ ref: '', snapshotId: '42', current, blockRoles: [] }),
    ).toEqual({ ok: false, error: 'missing_ref' })
    expect(
      assertClickAllowed({ ref: undefined, snapshotId: '42', current, blockRoles: [] }),
    ).toEqual({ ok: false, error: 'missing_ref' })
  })

  it('snapshotId 不匹配返回 stale_snapshot', () => {
    expect(
      assertClickAllowed({ ref: 'e1', snapshotId: '99', current, blockRoles: [] }),
    ).toEqual({ ok: false, error: 'stale_snapshot' })
  })

  it('ref 不在当前快照返回 stale_snapshot', () => {
    expect(
      assertClickAllowed({ ref: 'e99', snapshotId: '42', current, blockRoles: [] }),
    ).toEqual({ ok: false, error: 'stale_snapshot' })
  })

  it('命中 blockRoles 返回 blocked_composer', () => {
    const composerRef: AppUiRef = { ...sampleRef, ref: 'e2', role: 'composer' }
    const cache: AppUiClickContext = {
      ...current,
      refs: [composerRef],
    }
    expect(
      assertClickAllowed({
        ref: 'e2',
        snapshotId: '42',
        current: cache,
        blockRoles: ['composer', 'runtime'],
      }),
    ).toEqual({ ok: false, error: 'blocked_composer' })
  })

  it('校验通过返回匹配 ref', () => {
    expect(
      assertClickAllowed({ ref: 'e1', snapshotId: '42', current, blockRoles: ['composer'] }),
    ).toEqual({ ok: true, ref: sampleRef })
  })

  it('未提供 snapshotId 时跳过过期校验', () => {
    expect(
      assertClickAllowed({ ref: 'e1', snapshotId: undefined, current, blockRoles: [] }),
    ).toEqual({ ok: true, ref: sampleRef })
  })
})

describe('buildTypeScript', () => {
  it('脚本包含 native value setter 与 input 事件派发', () => {
    const script = buildTypeScript(10, 20, 100, 40, 'hello')
    expect(script).toContain('getOwnPropertyDescriptor')
    expect(script).toContain('HTMLInputElement.prototype')
    expect(script).toContain('HTMLTextAreaElement.prototype')
    expect(script).toContain("new Event('input', { bubbles: true })")
    expect(script).not.toContain('el.value =')
  })

  it('clear=true 时先设空字符串', () => {
    const script = buildTypeScript(0, 0, 50, 20, '新文本', true)
    expect(script).toContain("setNativeValue(el, '')")
    expect(script).toContain('新文本')
  })

  it('中文与 emoji 正确嵌入脚本字符串', () => {
    const script = buildTypeScript(0, 0, 50, 20, '你好🎉世界')
    expect(script).toContain('"你好🎉世界"')
  })

  it('在 jsdom input 上通过 native setter 写入并触发 input 事件', () => {
    document.body.innerHTML = '<input id="t" />'
    const input = document.getElementById('t') as HTMLInputElement
    input.scrollIntoView = vi.fn()
    const dispatchSpy = vi.spyOn(input, 'dispatchEvent')
    document.elementFromPoint = vi.fn().mockReturnValue(input) as typeof document.elementFromPoint

    const script = buildTypeScript(0, 0, 100, 40, '测试🎉')
    // eslint-disable-next-line no-eval
    const result = eval(script)

    expect(result).toBe(true)
    expect(input.value).toBe('测试🎉')
    expect(dispatchSpy).toHaveBeenCalled()
    const event = dispatchSpy.mock.calls[0]?.[0] as Event
    expect(event.type).toBe('input')
    expect(event.bubbles).toBe(true)
  })
})

describe('isKeyAllowed', () => {
  it('白名单内按键允许', () => {
    for (const key of KEY_WHITELIST) {
      expect(isKeyAllowed(key)).toBe(true)
    }
  })

  it('非白名单按键拒绝', () => {
    expect(isKeyAllowed('a')).toBe(false)
    expect(isKeyAllowed('Space')).toBe(false)
    expect(isKeyAllowed('F1')).toBe(false)
  })
})

describe('buildScrollScript', () => {
  it('脚本包含 scrollBy 与 elementFromPoint 定位', () => {
    const script = buildScrollScript(10, 20, 100, 40, 0, 120)
    expect(script).toContain('elementFromPoint')
    expect(script).toContain('scrollBy(0, 120)')
    expect(script).toContain('scrollIntoView')
  })

  it('在 jsdom 元素上执行 scrollBy', () => {
    document.body.innerHTML = '<div id="scroll-target" style="overflow:auto;height:100px"></div>'
    const el = document.getElementById('scroll-target') as HTMLElement
    const scrollBySpy = vi.fn()
    el.scrollBy = scrollBySpy
    el.scrollIntoView = vi.fn()
    document.elementFromPoint = vi.fn().mockReturnValue(el) as typeof document.elementFromPoint

    const script = buildScrollScript(0, 0, 50, 50, 10, 20)
    // eslint-disable-next-line no-eval
    const result = eval(script)

    expect(result).toBe(true)
    expect(scrollBySpy).toHaveBeenCalledWith(10, 20)
  })
})
