/**
 * @vitest-environment jsdom
 * 本文件含 eval 注入脚本的 DOM 行为断言，需在 jsdom 下运行（从仓库根目录跑 vitest 时也生效）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertClickAllowed,
  buildClickPrepareScript,
  buildScrollScript,
  buildSelectScript,
  buildTypeScript,
  CLICK_BLOCK_ROLES,
  isKeyAllowed,
  KEY_WHITELIST,
} from './act'
import type { ScrollScriptResult, SelectScriptResult, TypeScriptResult } from './act'
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

  it('assertClickAllowed 拒绝 heading/label 角色，返回 not_interactive', () => {
    const result = assertClickAllowed({
      ref: 'e1',
      snapshotId: '7',
      current: {
        snapshotId: '7',
        refs: [{ ref: 'e1', role: 'heading', name: '文本对话', x: 0, y: 0, w: 10, h: 10 }],
      },
      blockRoles: CLICK_BLOCK_ROLES,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('not_interactive')
    }
  })
})

describe('buildTypeScript', () => {
  it('脚本包含 native value setter 与 input 事件派发', () => {
    const script = buildTypeScript(10, 20, 100, 40, 'hello')
    expect(script).toContain('getOwnPropertyDescriptor')
    expect(script).toContain('HTMLInputElement.prototype')
    expect(script).toContain('HTMLTextAreaElement.prototype')
    expect(script).toContain("new Event('input', { bubbles: true })")
    expect(script).toContain("new Event('change', { bubbles: true })")
  })

  it('中文与 emoji 正确嵌入脚本字符串', () => {
    const script = buildTypeScript(0, 0, 50, 20, '你好🎉世界')
    expect(script).toContain('"你好🎉世界"')
  })

  it('在 jsdom input 上通过 native setter 写入并回传实际值', () => {
    document.body.innerHTML = '<input id="t" value="旧值" />'
    const input = document.getElementById('t') as HTMLInputElement
    input.scrollIntoView = vi.fn()
    const dispatchSpy = vi.spyOn(input, 'dispatchEvent')
    document.elementFromPoint = vi.fn().mockReturnValue(input) as typeof document.elementFromPoint

    const script = buildTypeScript(0, 0, 100, 40, '测试🎉')
    // eslint-disable-next-line no-eval
    const result = eval(script) as TypeScriptResult

    expect(result.ok).toBe(true)
    expect(result.value).toBe('测试🎉')
    expect(input.value).toBe('测试🎉')
    const event = dispatchSpy.mock.calls[0]?.[0] as Event
    expect(event.type).toBe('input')
    expect(event.bubbles).toBe(true)
  })

  it('append=true 时追加到原内容末尾', () => {
    document.body.innerHTML = '<input id="t" value="https://api.openai.com" />'
    const input = document.getElementById('t') as HTMLInputElement
    input.scrollIntoView = vi.fn()
    document.elementFromPoint = vi.fn().mockReturnValue(input) as typeof document.elementFromPoint

    const script = buildTypeScript(0, 0, 100, 40, '/v1', true)
    // eslint-disable-next-line no-eval
    const result = eval(script) as TypeScriptResult

    expect(result.ok).toBe(true)
    expect(input.value).toBe('https://api.openai.com/v1')
  })

  it('命中包裹层时向内找到真实输入框，而不是抛异常', () => {
    document.body.innerHTML =
      '<div id="wrap"><input id="t" /><span class="suffix">👁</span></div>'
    const wrap = document.getElementById('wrap') as HTMLElement
    const input = document.getElementById('t') as HTMLInputElement
    wrap.scrollIntoView = vi.fn()
    input.scrollIntoView = vi.fn()
    document.elementFromPoint = vi.fn().mockReturnValue(wrap) as typeof document.elementFromPoint

    const script = buildTypeScript(0, 0, 100, 40, 'sk-demo')
    // eslint-disable-next-line no-eval
    const result = eval(script) as TypeScriptResult

    expect(result.ok).toBe(true)
    expect(input.value).toBe('sk-demo')
  })

  it('password 输入框写入成功但不回传明文', () => {
    document.body.innerHTML = '<input id="t" type="password" />'
    const input = document.getElementById('t') as HTMLInputElement
    input.scrollIntoView = vi.fn()
    document.elementFromPoint = vi.fn().mockReturnValue(input) as typeof document.elementFromPoint

    const script = buildTypeScript(0, 0, 100, 40, 'sk-secret-value')
    // eslint-disable-next-line no-eval
    const result = eval(script) as TypeScriptResult

    expect(result.ok).toBe(true)
    expect(result.masked).toBe(true)
    expect(result.value).toBe('')
    expect(result.length).toBe('sk-secret-value'.length)
    expect(input.value).toBe('sk-secret-value')
  })

  it('目标不可编辑时返回 not_editable 而不是抛异常', () => {
    document.body.innerHTML = '<button id="b">保存</button>'
    const button = document.getElementById('b') as HTMLElement
    button.scrollIntoView = vi.fn()
    document.elementFromPoint = vi.fn().mockReturnValue(button) as typeof document.elementFromPoint

    const script = buildTypeScript(0, 0, 100, 40, 'x')
    // eslint-disable-next-line no-eval
    const result = eval(script) as TypeScriptResult

    expect(result).toMatchObject({ ok: false, error: 'not_editable', tag: 'button' })
  })
})

describe('buildSelectScript', () => {
  /** 构造带选项的原生下拉框并让 elementFromPoint 命中它 */
  function mountSelect(html: string): HTMLSelectElement {
    document.body.innerHTML = html
    const select = document.querySelector('select') as HTMLSelectElement
    select.scrollIntoView = vi.fn()
    document.elementFromPoint = vi.fn().mockReturnValue(select) as typeof document.elementFromPoint
    return select
  }

  it('按 value 选中并派发 change', () => {
    const select = mountSelect(
      '<select><option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic</option></select>',
    )
    const dispatchSpy = vi.spyOn(select, 'dispatchEvent')

    const script = buildSelectScript(0, 0, 100, 40, 'anthropic')
    // eslint-disable-next-line no-eval
    const result = eval(script) as SelectScriptResult

    expect(result.ok).toBe(true)
    expect(select.value).toBe('anthropic')
    expect(dispatchSpy.mock.calls.map((c) => (c[0] as Event).type)).toContain('change')
  })

  it('按可读文案模糊匹配选中', () => {
    const select = mountSelect(
      '<select><option value="openai">OpenAI 兼容</option><option value="ollama">Ollama（本地）</option></select>',
    )

    const script = buildSelectScript(0, 0, 100, 40, undefined, 'Ollama')
    // eslint-disable-next-line no-eval
    const result = eval(script) as SelectScriptResult

    expect(result.ok).toBe(true)
    expect(result.label).toBe('Ollama（本地）')
    expect(select.value).toBe('ollama')
  })

  it('不传 value/label 时只回读选项列表，不改变选中项', () => {
    const select = mountSelect(
      '<select><option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic</option></select>',
    )

    const script = buildSelectScript(0, 0, 100, 40)
    // eslint-disable-next-line no-eval
    const result = eval(script) as SelectScriptResult

    expect(result.ok).toBe(true)
    expect(result.options?.map((o) => o.value)).toEqual(['openai', 'anthropic'])
    expect(select.value).toBe('openai')
  })

  it('选项不存在时返回 option_not_found 并附带可选项', () => {
    mountSelect('<select><option value="openai">OpenAI 兼容</option></select>')

    const script = buildSelectScript(0, 0, 100, 40, 'gemini')
    // eslint-disable-next-line no-eval
    const result = eval(script) as SelectScriptResult

    expect(result.ok).toBe(false)
    expect(result.error).toBe('option_not_found')
    expect(result.options).toHaveLength(1)
  })

  it('目标不是下拉框时返回 not_select', () => {
    document.body.innerHTML = '<button id="b">保存</button>'
    const button = document.getElementById('b') as HTMLElement
    document.elementFromPoint = vi.fn().mockReturnValue(button) as typeof document.elementFromPoint

    const script = buildSelectScript(0, 0, 100, 40, 'x')
    // eslint-disable-next-line no-eval
    const result = eval(script) as SelectScriptResult

    expect(result).toMatchObject({ ok: false, error: 'not_select' })
  })
})

describe('buildClickPrepareScript', () => {
  it('中心点命中目标自身时 hit 为 true', () => {
    document.body.innerHTML = '<button id="b">保存</button>'
    const button = document.getElementById('b') as HTMLElement
    button.scrollIntoView = vi.fn()
    document.elementFromPoint = vi.fn().mockReturnValue(button) as typeof document.elementFromPoint

    const script = buildClickPrepareScript(0, 0, 100, 40)
    // eslint-disable-next-line no-eval
    const result = eval(script) as { hit: boolean; tag: string }

    expect(result.hit).toBe(true)
    expect(result.tag).toBe('button')
  })

  it('中心点落在遮罩上时 hit 为 false', () => {
    document.body.innerHTML = '<button id="b">保存</button><div id="mask"></div>'
    const button = document.getElementById('b') as HTMLElement
    const mask = document.getElementById('mask') as HTMLElement
    button.scrollIntoView = vi.fn()
    document.elementFromPoint = vi
      .fn()
      .mockReturnValueOnce(button)
      .mockReturnValueOnce(mask) as typeof document.elementFromPoint

    const script = buildClickPrepareScript(0, 0, 100, 40)
    // eslint-disable-next-line no-eval
    const result = eval(script) as { hit: boolean }

    expect(result.hit).toBe(false)
  })
})

describe('isKeyAllowed', () => {
  it('白名单内按键允许', () => {
    for (const key of KEY_WHITELIST) {
      expect(isKeyAllowed(key)).toBe(true)
    }
  })

  it('翻页与空格等常用按键在白名单内', () => {
    expect(isKeyAllowed('PageDown')).toBe(true)
    expect(isKeyAllowed('Home')).toBe(true)
    expect(isKeyAllowed('Space')).toBe(true)
  })

  it('非白名单按键拒绝', () => {
    expect(isKeyAllowed('a')).toBe(false)
    expect(isKeyAllowed('F1')).toBe(false)
  })
})

/**
 * jsdom 不做布局，scrollTop/scrollHeight 恒为 0，需要手动模拟成一个可滚动容器。
 */
function stubScrollableContainer(
  el: HTMLElement,
  scrollHeight: number,
  clientHeight: number,
): void {
  let top = 0
  const maxTop = scrollHeight - clientHeight
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (next: number) => {
      top = Math.max(0, Math.min(next, maxTop))
    },
  })
}

describe('buildScrollScript', () => {
  it('脚本包含元素定位与滚动偏移', () => {
    const script = buildScrollScript(10, 20, 100, 40, 0, 120)
    expect(script).toContain('elementFromPoint')
    expect(script).toContain('var dy = 120;')
    expect(script).toContain('parentElement')
  })

  it('从不可滚动的 ref 元素向上找到可滚动容器', () => {
    document.body.innerHTML =
      '<div id="panel" class="settings-body" style="overflow-y:auto"><button id="btn">卸载</button></div>'
    const panel = document.getElementById('panel') as HTMLElement
    const btn = document.getElementById('btn') as HTMLElement
    stubScrollableContainer(panel, 800, 400)
    document.elementFromPoint = vi.fn().mockReturnValue(btn) as typeof document.elementFromPoint

    const script = buildScrollScript(0, 0, 50, 50, 0, 300)
    // eslint-disable-next-line no-eval
    const result = eval(script) as ScrollScriptResult

    expect(result.container).toBe('div.settings-body')
    expect(result.moved).toBe(true)
    expect(result.scrollTop).toBe(300)
    expect(result.atTop).toBe(false)
    expect(result.atBottom).toBe(false)
  })

  it('容器已到底时回读 moved=false 与 atBottom=true', () => {
    document.body.innerHTML =
      '<div id="panel" class="settings-body" style="overflow-y:auto"><button id="btn">卸载</button></div>'
    const panel = document.getElementById('panel') as HTMLElement
    const btn = document.getElementById('btn') as HTMLElement
    stubScrollableContainer(panel, 800, 400)
    panel.scrollTop = 9999
    document.elementFromPoint = vi.fn().mockReturnValue(btn) as typeof document.elementFromPoint

    const script = buildScrollScript(0, 0, 50, 50, 0, 300)
    // eslint-disable-next-line no-eval
    const result = eval(script) as ScrollScriptResult

    expect(result.moved).toBe(false)
    expect(result.atBottom).toBe(true)
    expect(result.scrollTop).toBe(400)
  })

  it('没有可滚动祖先时退化为滚动页面', () => {
    document.body.innerHTML = '<button id="btn">卸载</button>'
    const btn = document.getElementById('btn') as HTMLElement
    document.elementFromPoint = vi.fn().mockReturnValue(btn) as typeof document.elementFromPoint

    const script = buildScrollScript(0, 0, 50, 50, 0, 300)
    // eslint-disable-next-line no-eval
    const result = eval(script) as ScrollScriptResult

    expect(result.container).toBe('document')
  })
})
