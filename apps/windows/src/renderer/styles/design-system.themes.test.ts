/**
 * 主题令牌完整性守卫
 *
 * 主题色系的可维护性前提：三个主题块（light / dark / eye-care）覆盖**同一组**变量。
 * 少写一个主题块里的某个 token，表现为"切到那个主题时该处颜色不变"，肉眼很难发现，
 * 所以用测试守住。另外守住"强调色只在全局固定区定义一处"——页面级局部覆写
 * （曾出现在 DashboardPage）会让该页面对换肤免疫，且从这里看不出来。
 *
 * 读取的是 CSS 源文件（fs）而非 CSS Modules 导入，与 vitest 的 css 配置无关。
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const STYLES_DIR = path.resolve(__dirname)
const DESIGN_SYSTEM = path.join(STYLES_DIR, 'design-system.css')
const TOKENS = path.join(STYLES_DIR, 'tokens.css')

const THEME_BLOCKS = ['light', 'dark', 'eye-care'] as const

/**
 * 收集某个选择器在整份 CSS 里声明的变量名。
 *
 * 同名选择器可能出现多个块（如 `:root` / `[data-theme="light"]` 都有重复块），
 * 必须全部合并，否则后出现的块里独有的变量会被漏掉。注释行不参与统计。
 */
function varsForSelector(css: string, selector: string): Set<string> {
  const names = new Set<string>()
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?:^|[},])\\s*${escaped}\\s*\\{`, 'gm')
  for (const match of css.matchAll(re)) {
    const start = match.index! + match[0].length
    const end = css.indexOf('}', start)
    for (const line of css.slice(start, end).split('\n')) {
      const decl = line.match(/^\s*(--[\w-]+)\s*:/)
      if (decl) names.add(decl[1]!)
    }
  }
  return names
}

const designSystem = fs.readFileSync(DESIGN_SYSTEM, 'utf8')
const tokens = fs.readFileSync(TOKENS, 'utf8')

const themeBlockVars = (css: string): Record<string, Set<string>> =>
  Object.fromEntries(THEME_BLOCKS.map((t) => [t, varsForSelector(css, `[data-theme="${t}"]`)]))

describe('design-system.css 主题块完整性', () => {
  const blocks = themeBlockVars(designSystem)

  it('三个主题块覆盖同一组变量', () => {
    const base = blocks.light!
    for (const theme of THEME_BLOCKS.slice(1)) {
      const vars = blocks[theme]!
      const missing = [...base].filter((v) => !vars.has(v))
      const extra = [...vars].filter((v) => !base.has(v))
      expect({ theme, missing, extra }, `主题块 ${theme} 与 light 变量集不一致`).toEqual({
        theme,
        missing: [],
        extra: [],
      })
    }
  })

  it('每个主题块都定义了配色主干变量', () => {
    for (const theme of THEME_BLOCKS) {
      const vars = blocks[theme]!
      for (const name of [
        '--mt-accent-500',
        '--mt-fg-1',
        '--mt-fg-on-accent',
        '--mt-bg-primary',
        '--mt-violet',
        '--mt-tone-a',
      ]) {
        expect(vars, `${theme} 缺少 ${name}`).toContain(name)
      }
    }
  })
})

describe('tokens.css 主题变体完整性', () => {
  const blocks = themeBlockVars(tokens)

  it('三个主题变体覆盖同一组变量', () => {
    const base = blocks.light!
    for (const theme of THEME_BLOCKS.slice(1)) {
      const vars = blocks[theme]!
      const missing = [...base].filter((v) => !vars.has(v))
      const extra = [...vars].filter((v) => !base.has(v))
      expect({ theme, missing, extra }, `tokens.css 变体 ${theme} 与 light 不一致`).toEqual({
        theme,
        missing: [],
        extra: [],
      })
    }
  })

  it('RGB 变体在每个主题下重新指定，避免透明变体不跟随换肤', () => {
    for (const theme of THEME_BLOCKS) {
      expect(blocks[theme], `${theme} 缺少 --mt-accent-rgb`).toContain('--mt-accent-rgb')
    }
  })

  it('三个主题变体覆盖同一组 RGB 三元组', () => {
    const rgbVars = (theme: string) =>
      [...blocks[theme]!].filter((v) => v.endsWith('-rgb')).sort()
    const base = rgbVars('light')
    for (const theme of THEME_BLOCKS.slice(1)) {
      expect(rgbVars(theme), `tokens.css 变体 ${theme} 的 rgb 三元组与 light 不一致`).toEqual(base)
    }
  })
})

describe('运行时取色的首帧兜底', () => {
  /**
   * `rgba(var(--mt-x-rgb), α)` 这类写法在令牌未定义时整条声明失效（不是回退到某个颜色，
   * 是直接消失）。CSS 的 `var()` 只在**使用处**写了 fallback 时才回退，而这类写法通常
   * 不写 fallback（写了也没法把 `r,g,b` 三元组拆开用）。所以每个被这样引用的三元组
   * 都必须在 `:root` 有定义 —— 否则首帧（ThemeContext 给 <html> 加 data-theme 之前）
   * 该处颜色直接失效。
   *
   * 实测踩过：--mt-surface-rgb 只在三个主题块里定义、:root 没有，而 Tooltip 用了它。
   */
  it('被 rgba(var(--mt-*-rgb)) 引用的三元组都在 :root 有定义', () => {
    const rendererDir = path.resolve(STYLES_DIR, '..')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'styles') continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(css|tsx?)$/.test(entry.name)) files.push(full)
      }
    }
    for (const entry of fs.readdirSync(rendererDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'styles') {
        walk(path.join(rendererDir, entry.name))
      }
    }

    const referenced = new Set<string>()
    for (const file of files) {
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/rgba\(\s*var\((--mt-[\w-]+-rgb)\)/g)) {
        referenced.add(m[1]!)
      }
    }

    const rootVars = varsForSelector(tokens, ':root')
    const missing = [...referenced].filter((name) => !rootVars.has(name)).sort()
    expect(
      { referenced: [...referenced].sort(), missing },
      '以下 RGB 三元组被 rgba() 引用但 :root 未定义，首帧会整条声明失效',
    ).toEqual({ referenced: [...referenced].sort(), missing: [] })
  })
})

describe('令牌定义点唯一性', () => {
  it('--mt-accent 色阶只在 styles/ 定义（防页面级局部覆写回归）', () => {
    const styleFiles: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.css')) styleFiles.push(full)
      }
    }
    // 只扫 renderer 下 styles/ 之外的文件：styles/ 是令牌的唯一合法来源
    const rendererDir = path.resolve(STYLES_DIR, '..')
    for (const entry of fs.readdirSync(rendererDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'styles' && entry.name !== 'node_modules') {
        walk(path.join(rendererDir, entry.name))
      }
    }

    const offenders = styleFiles.filter((file) =>
      /--mt-accent-\d+\s*:/.test(fs.readFileSync(file, 'utf8')),
    )
    expect(offenders, '以下文件局部覆写了 --mt-accent-* 色阶，换肤时不会跟随').toEqual([])
  })
})
