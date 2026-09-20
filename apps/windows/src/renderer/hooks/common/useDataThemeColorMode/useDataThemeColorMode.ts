import { useState, useEffect } from 'react'

/**
 * 与 `document.documentElement[data-theme]` 同步，供 @uiw/react-md-editor 的 `data-color-mode` 使用。
 * 避免应用为浅色时仍强制 `dark` 导致代码块/表格黑底与正文色冲突。
 *
 * 只分明暗：护眼（eye-care）等浅色系主题一律归 `light`。
 *
 * @returns `'light' | 'dark'` — 与 MDEditor 约定一致
 */
export function useDataThemeColorMode(): 'light' | 'dark' {
  const [mode, setMode] = useState<'light' | 'dark'>(() =>
    typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'dark'
      ? 'dark'
      : 'light',
  )

  useEffect(() => {
    const sync = () => {
      setMode(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light')
    }
    sync()
    const mo = new MutationObserver(sync)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => mo.disconnect()
  }, [])

  return mode
}

/**
 * `data-theme` 原样值（`'light' | 'dark' | 'eye-care' | null`）。
 *
 * 供"按主题重算取色"的绘制代码使用：明暗二分不够——浅色与护眼都算 light，
 * 但取到的 token 颜色不同，只看明暗会漏掉护眼主题下的重绘。
 */
export function useThemeAttr(): string | null {
  const [attr, setAttr] = useState<string | null>(() =>
    typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : null,
  )

  useEffect(() => {
    const sync = () => setAttr(document.documentElement.getAttribute('data-theme'))
    sync()
    const mo = new MutationObserver(sync)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => mo.disconnect()
  }, [])

  return attr
}
