/**
 * Markdown 外链统一走系统浏览器，避免在 Electron 内嵌页或 webview 中导航导致无法退出。
 */
import React from 'react'

/** 判断是否为 http(s) 外链 */
export function isHttpUrl(url: string | null | undefined): boolean {
  return !!url && /^https?:\/\//i.test(url.trim())
}

/**
 * 在系统默认浏览器中打开 URL（非 http(s) 时静默忽略）。
 */
export function openExternalUrl(url: string): void {
  const trimmed = url.trim()
  if (!isHttpUrl(trimmed)) return
  void window.electronAPI?.app?.openExternal(trimmed)
}

export interface MarkdownExternalLinkProps
  extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  readonly href?: string
}

/**
 * Markdown 渲染用的 `<a>`：http(s) 链接拦截默认导航，改由系统浏览器打开。
 */
export function MarkdownExternalLink({
  href,
  children,
  onClick,
  ...rest
}: MarkdownExternalLinkProps): React.ReactElement {
  return (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented || !href) return
        if (isHttpUrl(href)) {
          event.preventDefault()
          openExternalUrl(href)
        }
      }}
    >
      {children}
    </a>
  )
}
