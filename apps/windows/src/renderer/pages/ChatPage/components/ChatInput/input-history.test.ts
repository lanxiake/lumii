/**
 * 输入历史的存取契约：去重顶到最前、上限、空白不记、坏数据不炸。
 * 这些是「按 ↑ 翻出来的东西对不对」的全部判据。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readInputHistory, recordInputHistory } from './input-history'

function installLocalStorage(): Map<string, string> {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  })
  return store
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('输入历史', () => {
  it('最新的一条在最前', () => {
    installLocalStorage()
    recordInputHistory('第一句')
    recordInputHistory('第二句')
    expect(readInputHistory()).toEqual(['第二句', '第一句'])
  })

  it('重复输入去重并顶到最前', () => {
    installLocalStorage()
    recordInputHistory('A')
    recordInputHistory('B')
    recordInputHistory('A')
    expect(readInputHistory()).toEqual(['A', 'B'])
  })

  it('空白与纯空格不记', () => {
    installLocalStorage()
    recordInputHistory('   ')
    recordInputHistory('\n\n')
    expect(readInputHistory()).toEqual([])
  })

  it('超出上限时丢最旧的', () => {
    installLocalStorage()
    for (let i = 0; i < 60; i += 1) recordInputHistory(`第${i}句`)
    const history = readInputHistory()
    expect(history).toHaveLength(50)
    expect(history[0]).toBe('第59句')
  })

  it('坏数据当作空历史，不让输入框炸掉', () => {
    const store = installLocalStorage()
    store.set('mtbot:input-history', '{不是 JSON')
    expect(readInputHistory()).toEqual([])
    store.set('mtbot:input-history', '{"a":1}')
    expect(readInputHistory()).toEqual([])
  })
})
