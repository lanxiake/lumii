import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  OPEN_WIKI_LIBRARY_EVENT,
  WIKI_INIT_NAV_KEY,
  openWikiLibrary,
} from './open-wiki-library'

describe('openWikiLibrary', () => {
  const storage = new Map<string, string>()

  beforeEach(() => {
    storage.clear()
    vi.stubGlobal('sessionStorage', {
      setItem: (k: string, v: string) => storage.set(k, v),
      getItem: (k: string) => storage.get(k) ?? null,
      removeItem: (k: string) => storage.delete(k),
    })
    vi.stubGlobal('window', {
      dispatchEvent: vi.fn(),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('写入 sessionStorage 并派发导航到资料库 Tab', () => {
    openWikiLibrary()

    expect(storage.get(WIKI_INIT_NAV_KEY)).toBe('inbox')
    expect(window.dispatchEvent).toHaveBeenCalledTimes(2)

    const navigateCall = vi.mocked(window.dispatchEvent).mock.calls[0][0] as CustomEvent
    expect(navigateCall.type).toBe('mtbot:navigate-request')
    expect(navigateCall.detail).toEqual({ view: 'wiki' })

    const wikiOpenCall = vi.mocked(window.dispatchEvent).mock.calls[1][0] as CustomEvent
    expect(wikiOpenCall.type).toBe(OPEN_WIKI_LIBRARY_EVENT)
  })
})
