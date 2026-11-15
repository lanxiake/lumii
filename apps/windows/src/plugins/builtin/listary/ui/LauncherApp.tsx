/**
 * LauncherApp — 启动器悬浮窗的界面。
 *
 * 由 `?mode=listary-launcher` 加载（见 `renderer/main.tsx`）。
 *
 * 交互：
 * - 唤起即聚焦输入框（**双重保障**：React `autoFocus` 不覆盖窗口二次显示的场景，
 *   故 `onShown` 与一个短时轮询都调 `focus()`）
 * - 输入防抖后检索；↑↓ 选择、Enter 打开、Esc 收起
 * - 结果显示**真实文件图标**（`app.getFileIcon` 经 IPC 批量取，按扩展名缓存）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import styles from './LauncherApp.module.css'

interface SearchHit {
  id: number
  path: string
  name: string
  ext: string | null
  kind: 'file' | 'dir' | 'app' | 'lnk'
  root: string
  isStart: boolean
  rank: number | null
}

interface HotkeyStatus {
  mode: 'double-ctrl' | 'accelerator' | 'none'
  reason?: string
  acceleratorOk: boolean
}

interface ListaryApi {
  search: (q: string, n?: number) => Promise<SearchHit[]>
  open: (a: string, p: string, k?: string) => Promise<{ ok: boolean; error?: string }>
  hide: () => Promise<unknown>
  hotkey: () => Promise<HotkeyStatus>
  icons: (paths: string[]) => Promise<Record<string, string>>
  onShown: (cb: () => void) => () => void
}

function api(): ListaryApi | undefined {
  return (window as unknown as { electronAPI?: { listary?: ListaryApi } }).electronAPI?.listary
}

/** 输入到检索之间的防抖；太小会打爆 IPC，太大会觉得卡 */
const DEBOUNCE_MS = 90

/** 取不到真实图标时的类型回退（emoji 只是兜底，正常情况下显示的是真图标） */
const KIND_FALLBACK: Record<SearchHit['kind'], string> = {
  dir: '📁',
  app: '⚙️',
  lnk: '🔗',
  file: '📄',
}

/** 取父目录，结果列表里显示它比显示完整路径有用（末尾太长会被截断） */
function parentDir(p: string): string {
  const i = p.lastIndexOf('\\')
  return i > 2 ? p.slice(0, i) : p
}

export function LauncherApp(): JSX.Element {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [icons, setIcons] = useState<Record<string, string>>({})
  const [active, setActive] = useState(0)
  const [loading, setLoading] = useState(false)
  const [hotkey, setHotkey] = useState<HotkeyStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  /** 防"慢响应覆盖快响应"：只认最后一次请求的结果 */
  const seqRef = useRef(0)

  const focusInput = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    if (document.activeElement !== el) el.focus({ preventScroll: true })
    el.select()
  }, [])

  // 唤起时：聚焦 + 清空上次查询（每次唤起都是新的一次查找）
  useEffect(() => {
    const a = api()
    if (!a) {
      setError('启动器插件未启用')
      return
    }
    focusInput()

    /**
     * 抢输入框焦点要"打到真为止"。
     *
     * 实测（2026-11-15，用户反馈「光标在别的输入框时双击后没进来」）：
     * 窗口 `show()+focus()` 拿到系统焦点后，WebContents 的 `document.activeElement`
     * 未必是输入框 —— 首次打开时 body 可能先吃焦点。所以判据不是 `document.hasFocus()`，
     * 而是 **activeElement 到底是不是那个 input**。
     *
     * 每 40ms 试一次，最多 1.5 秒（38 次）。一旦到位立刻停 —— 不做无谓轮询。
     */
    let tries = 0
    const ensure = (): void => {
      if (inputRef.current && document.activeElement === inputRef.current) {
        clearInterval(timer)
        return
      }
      focusInput()
      if (++tries >= 38) clearInterval(timer)
    }
    const timer = setInterval(ensure, 40)

    // 窗口层面重新获得焦点时（用户点了窗口边框、从别的窗口切回来）也要落到输入框
    window.addEventListener('focus', focusInput)

    void a.hotkey().then(setHotkey).catch(() => setHotkey(null))
    const off = a.onShown(() => {
      setQuery('')
      setActive(0)
      tries = 0
      focusInput()
    })
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', focusInput)
      off()
    }
  }, [focusInput])

  // 检索（防抖）
  useEffect(() => {
    const a = api()
    if (!a) return

    const q = query.trim()
    if (!q) {
      setHits([])
      setActive(0)
      return
    }

    setLoading(true)
    const seq = ++seqRef.current
    const t = setTimeout(() => {
      a.search(q, 50)
        .then((rows) => {
          if (seq !== seqRef.current) return // 有更新的请求了，丢弃
          setHits(rows)
          setActive(0)
          setError(null)
        })
        .catch((e: unknown) => {
          if (seq !== seqRef.current) return
          setHits([])
          setError(e instanceof Error ? e.message : '检索失败')
        })
        .finally(() => {
          if (seq === seqRef.current) setLoading(false)
        })
    }, DEBOUNCE_MS)

    return () => clearTimeout(t)
  }, [query])

  // 取真实图标：结果变了才拉，且只在**没缓存过的**路径上花时间
  useEffect(() => {
    const a = api()
    if (!a || hits.length === 0) return
    const missing = hits.map((h) => h.path).filter((p) => !(p in icons))
    if (missing.length === 0) return
    void a
      .icons(missing)
      .then((got) => {
        if (Object.keys(got).length > 0) setIcons((prev) => ({ ...prev, ...got }))
      })
      .catch(() => {
        /* 图标取不到无所谓，有类型回退 */
      })
    // icons 故意不进依赖：它只增不改，放进去会让这个 effect 自激
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hits])

  // 选中的项滚进视野
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const open = useCallback(
    async (hit: SearchHit | undefined, action: 'open' | 'reveal' | 'copy-path' = 'open') => {
      if (!hit) return
      const a = api()
      if (!a) return
      setError(null)
      const r = await a.open(action, hit.path, query.trim())
      if (!r.ok) setError(r.error ?? '打开失败')
    },
    [query],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        void api()?.hide()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((i) => Math.min(i + 1, hits.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        void open(hits[active], e.ctrlKey || e.shiftKey ? 'reveal' : 'open')
      }
    },
    [hits, active, open],
  )

  const hint = useMemo(() => {
    if (error) return error
    if (hotkey?.mode === 'accelerator') return '唤起方式：Ctrl+Shift+Space（双击 Ctrl 不可用）'
    if (hotkey?.mode === 'none') return '无法唤起：键盘钩子与组合键都不可用'
    if (hits.length === 0 && query.trim() && !loading) return '没有匹配的条目'
    if (hits.length === 0) return '输入以搜索本机文件与应用（支持拼音：豆包 / doubao / db）'
    return null
  }, [error, hotkey, hits.length, query, loading])

  return (
    <div className={styles.root} onKeyDown={onKeyDown} onMouseDown={focusInput}>
      <div className={styles.searchRow}>
        <span className={styles.searchIcon} aria-hidden>
          ⚲
        </span>
        <input
          ref={inputRef}
          className={styles.input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索文件、应用…"
          autoFocus
          spellCheck={false}
          role="combobox"
          aria-expanded={hits.length > 0}
          aria-controls="listary-results"
          aria-activedescendant={hits[active] ? `listary-hit-${hits[active].id}` : undefined}
        />
        {loading && <span className={styles.spinner} aria-label="检索中" />}
      </div>

      {hint && <div className={styles.hint}>{hint}</div>}

      <div className={styles.list} ref={listRef} id="listary-results" role="listbox">
        {hits.map((h, i) => {
          const icon = icons[h.path] ?? icons[`__ext__${h.ext ?? ''}`]
          return (
            <div
              key={`${h.id}-${h.path}`}
              id={`listary-hit-${h.id}`}
              data-index={i}
              role="option"
              aria-selected={i === active}
              className={i === active ? styles.rowActive : styles.row}
              onMouseEnter={() => setActive(i)}
              onDoubleClick={() => void open(h)}
              onClick={() => void open(h)}
            >
              {icon ? (
                <img className={styles.iconImg} src={icon} alt="" draggable={false} />
              ) : (
                <span className={styles.icon} aria-hidden>
                  {KIND_FALLBACK[h.kind]}
                </span>
              )}
              <span className={styles.name}>{h.name}</span>
              <span className={styles.path}>{parentDir(h.path)}</span>
            </div>
          )
        })}
      </div>

      <div className={styles.footer}>
        <span>↑↓ 选择</span>
        <span>Enter 打开</span>
        <span>Ctrl+Enter 定位</span>
        <span>Esc 收起</span>
      </div>
    </div>
  )
}
