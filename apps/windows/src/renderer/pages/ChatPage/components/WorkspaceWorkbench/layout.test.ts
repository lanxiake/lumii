import { describe, expect, it } from 'vitest'
import {
  CHAT_MIN_REMAIN,
  WORKBENCH_ENTRIES,
  WORKBENCH_WIDTH_MIN,
  closeTab,
  entryFor,
  hashWorkspaceDir,
  isCompactWidth,
  isSplitTab,
  openTab,
  railWidthFor,
  isInspectorInline,
  INSPECTOR_WIDTH,
  resolveWidth,
  tabTitle,
  type WorkbenchTabKind,
} from './layout'

describe('resolveWidth', () => {
  it('三档：半 480 / 宽 860 / 满 = 可用宽度', () => {
    expect(resolveWidth('half', undefined, 1200)).toBe(480)
    expect(resolveWidth('wide', undefined, 1200)).toBe(860)
    expect(resolveWidth('full', undefined, 1200)).toBe(1200)
  })

  it('可用宽度不够时夹到 min，不会挤出对话区下限', () => {
    expect(resolveWidth('wide', undefined, 700)).toBe(700)
    expect(resolveWidth('full', undefined, 300)).toBe(300)
    expect(resolveWidth('half', undefined, 100)).toBe(WORKBENCH_WIDTH_MIN)
    expect(resolveWidth('custom', 100, 1200)).toBe(WORKBENCH_WIDTH_MIN)
    expect(resolveWidth('custom', 9999, 1000)).toBe(1000)
  })

  it('custom 用拖拽宽度，缺省回落半档', () => {
    expect(resolveWidth('custom', 620, 1200)).toBe(620)
    expect(resolveWidth('custom', undefined, 1200)).toBe(480)
  })
})

describe('断点与 rail 宽度', () => {
  it('<560 单栏，rail 220；否则 260', () => {
    expect(isCompactWidth(480)).toBe(true)
    expect(isCompactWidth(560)).toBe(false)
    expect(railWidthFor(480)).toBe(220)
    expect(railWidthFor(860)).toBe(260)
  })

  it('inspector 只在 ≥900 时并排（更窄退浮层）', () => {
    expect(isInspectorInline(899)).toBe(false)
    expect(isInspectorInline(900)).toBe(true)
    expect(INSPECTOR_WIDTH).toBe(240)
  })

  it('对话区残留常量保持 280', () => {
    expect(CHAT_MIN_REMAIN).toBe(280)
  })
})

describe('hashWorkspaceDir', () => {
  it('不同工作区不同 key；大小写与分隔符归一', () => {
    expect(hashWorkspaceDir('E:/ws')).not.toBe(hashWorkspaceDir('E:/other'))
    expect(hashWorkspaceDir('E:\\WS')).toBe(hashWorkspaceDir('e:/ws'))
  })
})

describe('openTab / closeTab', () => {
  it('openTab 已存在时只返回团一份新数组，不换顺序', () => {
    const before: WorkbenchTabKind[] = ['files', 'artifacts']
    const result = openTab(before, 'files')
    expect(result.tabs).toEqual(['files', 'artifacts'])
    expect(result.active).toBe('files')
    // 不改入参
    expect(before).toEqual(['files', 'artifacts'])
  })

  it('openTab 新页按 TAB_ORDER 插入', () => {
    expect(openTab(['terminal'], 'artifacts').tabs).toEqual(['artifacts', 'terminal'])
    expect(openTab(['artifacts', 'vcs'], 'terminal').tabs).toEqual([
      'artifacts',
      'terminal',
      'vcs',
    ])
  })

  it('closeTab 关非当前页：当前页不变', () => {
    const result = closeTab(['artifacts', 'files'], 'files', 'artifacts')
    expect(result).toMatchObject({ tabs: ['artifacts'], active: 'artifacts' })
  })

  it('closeTab 关当前页：优先接右边，没有就接左边', () => {
    expect(closeTab(['artifacts', 'files', 'terminal'], 'files', 'files')).toMatchObject({
      tabs: ['artifacts', 'terminal'],
      active: 'terminal',
    })
    expect(closeTab(['artifacts', 'files'], 'files', 'files')).toMatchObject({
      tabs: ['artifacts'],
      active: 'artifacts',
    })
  })

  it('closeTab 关最后一个返回 null（调用方收起整列）', () => {
    expect(closeTab(['artifacts'], 'artifacts', 'artifacts')).toBeNull()
  })

  it('closeTab 关不存在的页是 no-op', () => {
    expect(closeTab(['artifacts'], 'files', 'artifacts')).toMatchObject({
      tabs: ['artifacts'],
      active: 'artifacts',
    })
  })
})

describe('tab 元数据', () => {
  it('双栏 tab 只有产物与文件', () => {
    expect(isSplitTab('artifacts')).toBe(true)
    expect(isSplitTab('files')).toBe(true)
    expect(isSplitTab('terminal')).toBe(false)
    expect(isSplitTab(null)).toBe(false)
  })

  it('开始页每颗胶囊都有描述与数字快捷键，且 kind 不重复', () => {
    const kinds = WORKBENCH_ENTRIES.map((entry) => entry.kind)
    expect(new Set(kinds).size).toBe(kinds.length)
    for (const entry of WORKBENCH_ENTRIES) {
      expect(entry.description.length).toBeGreaterThan(0)
      expect(entry.shortcut).toMatch(/^[1-9]$/)
    }
  })

  it('tab 标题去掉「新建」前缀（chip 里不放动词）', () => {
    expect(entryFor('terminal').title).toBe('新建终端')
    expect(tabTitle('terminal')).toBe('终端')
    expect(tabTitle('artifacts')).toBe('只看产出')
  })
})
