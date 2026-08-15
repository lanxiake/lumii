/**
 * 混音纯函数单测
 */
import { describe, expect, it } from 'vitest'
import { pickSupportedMime, splitBlobToChunks, arrayBufferToBase64 } from './mix-audio-tracks'
import { MAX_CHUNK_BYTES_PER_IPC } from '../../shared/screen-record'

describe('pickSupportedMime', () => {
  it('无 MediaRecorder 时回退第一个候选', () => {
    const first = pickSupportedMime(['video/webm;codecs=vp8,opus', 'video/webm'])
    expect(first).toBeTruthy()
  })
})

describe('splitBlobToChunks', () => {
  it('小于上限时不拆分', async () => {
    const blob = new Blob([new Uint8Array(100)])
    const parts = await splitBlobToChunks(blob, MAX_CHUNK_BYTES_PER_IPC)
    expect(parts.length).toBe(1)
    expect(parts[0]!.byteLength).toBe(100)
  })

  it('超过上限时拆分', async () => {
    const size = 5 * 1024 * 1024
    const blob = new Blob([new Uint8Array(size)])
    const max = 2 * 1024 * 1024
    const parts = await splitBlobToChunks(blob, max)
    expect(parts.length).toBe(3)
    expect(parts.reduce((n, p) => n + p.byteLength, 0)).toBe(size)
  })
})

describe('arrayBufferToBase64', () => {
  it('可编解码往返', () => {
    const src = new Uint8Array([1, 2, 3, 250]).buffer
    const b64 = arrayBufferToBase64(src)
    expect(b64.length).toBeGreaterThan(0)
    const back = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    expect([...back]).toEqual([1, 2, 3, 250])
  })
})
