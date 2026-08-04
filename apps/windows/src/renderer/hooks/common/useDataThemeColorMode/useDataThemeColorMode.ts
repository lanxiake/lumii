import { useState, useEffect } from 'react'

/**
 * 与 `document.documentElement[data-theme]` 同步，供 @uiw/react-md-editor 的 `data-color-mode` 使用。
 * 避免应用为浅色时仍强制 `dark` 导致代码块/表格黑底与正文色冲突。
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
