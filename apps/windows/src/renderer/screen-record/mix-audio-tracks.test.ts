/**
 * 混音纯函数单测
 */
import { describe, expect, it, vi } from 'vitest'
import {
  mixDesktopAndMic,
  pickSupportedMime,
  splitBlobToChunks,
  arrayBufferToBase64,
} from './mix-audio-tracks'
import { MAX_CHUNK_BYTES_PER_IPC } from '../../shared/screen-record'

/**
 * 构造带指定数量 audio track 的假 MediaStream（仅测混音接线逻辑）。
 */
function fakeStream(audioTrackCount: number): MediaStream {
  const tracks = Array.from({ length: audioTrackCount }, () => ({ kind: 'audio' }) as MediaStreamTrack)
  return {
    getAudioTracks: () => tracks,
  } as MediaStream
}

describe('mixDesktopAndMic', () => {
  it('两路皆无时返回 null', () => {
    const connect = vi.fn()
    const audioCtx = {
      createMediaStreamSource: vi.fn(() => ({ connect })),
      createMediaStreamDestination: vi.fn(() => ({
        stream: fakeStream(1),
        connect,
      })),
    } as unknown as AudioContext
    expect(mixDesktopAndMic(audioCtx, null, null)).toBeNull()
    expect(mixDesktopAndMic(audioCtx, fakeStream(0), fakeStream(0))).toBeNull()
  })

  it('仅桌面轨时接线并返回 stream', () => {
    const connect = vi.fn()
    const destStream = fakeStream(1)
    const audioCtx = {
      createMediaStreamSource: vi.fn(() => ({ connect })),
      createMediaStreamDestination: vi.fn(() => ({
        stream: destStream,
        connect,
      })),
    } as unknown as AudioContext
    const out = mixDesktopAndMic(audioCtx, fakeStream(1), null)
    expect(out).toBe(destStream)
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('桌面+麦同时接线', () => {
    const connect = vi.fn()
    const destStream = fakeStream(1)
    const audioCtx = {
      createMediaStreamSource: vi.fn(() => ({ connect })),
      createMediaStreamDestination: vi.fn(() => ({
        stream: destStream,
        connect,
      })),
    } as unknown as AudioContext
    const out = mixDesktopAndMic(audioCtx, fakeStream(1), fakeStream(1))
    expect(out).toBe(destStream)
    expect(connect).toHaveBeenCalledTimes(2)
  })
})

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
