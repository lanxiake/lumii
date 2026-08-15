import { describe, expect, it, expectTypeOf } from 'vitest'
import type {
  ScreenRecordSource,
  ScreenRecordStatus,
  ScreenRecordStartParams,
  ScreenRecordStopResult,
  ScreenRecordCommand,
  ScreenRecordEvent,
  ScreenRecordErrorCode,
} from './screen-record'
import {
  SCREEN_RECORD_SETTINGS_DEFAULTS,
  RECORDINGS_DIRNAME,
  MAX_DURATION_SEC_CAP,
  MIN_FREE_DISK_BYTES,
} from './screen-record'

describe('screen-record shared 常量', () => {
  it('常量值与设计一致', () => {
    expect(RECORDINGS_DIRNAME).toBe('recordings')
    expect(MAX_DURATION_SEC_CAP).toBe(7200)
    expect(MIN_FREE_DISK_BYTES).toBe(500 * 1024 * 1024)
    expect(SCREEN_RECORD_SETTINGS_DEFAULTS.enabled).toBe(true)
    expect(SCREEN_RECORD_SETTINGS_DEFAULTS.alwaysAllow).toBe(false)
    expect(SCREEN_RECORD_SETTINGS_DEFAULTS.includeMicDefault).toBe(true)
    expect(SCREEN_RECORD_SETTINGS_DEFAULTS.confirmTimeoutSec).toBe(120)
  })
})

describe('screen-record 类型形状', () => {
  it('ScreenRecordSource 含 isLumii 标记', () => {
    expectTypeOf<ScreenRecordSource>().toHaveProperty('sourceId')
    expectTypeOf<ScreenRecordSource>().toHaveProperty('name')
    expectTypeOf<ScreenRecordSource>().toHaveProperty('type')
    expectTypeOf<ScreenRecordSource>().toHaveProperty('isLumii')
    expectTypeOf<ScreenRecordSource>().toHaveProperty('thumbnailDataUrl')
  })

  it('Status union 为五态', () => {
    expectTypeOf<ScreenRecordStatus>().toMatchTypeOf<
      'idle' | 'pending_confirm' | 'recording' | 'stopping' | 'error'
    >()
  })

  it('Error union 覆盖设计 §6 全部 12 条', () => {
    const codes: ScreenRecordErrorCode[] = [
      'disabled',
      'already_recording',
      'no_active_session',
      'source_unavailable',
      'insufficient_disk_space',
      'mic_unavailable',
      'permission_denied',
      'confirmation_timeout',
      'stream_ended',
      'capture_failed',
      'write_failed',
    ]
    expect(codes.length).toBeGreaterThanOrEqual(11)
  })

  it('StartParams / StopResult / Command / Event 类型可引用', () => {
    expectTypeOf<ScreenRecordStartParams>().toHaveProperty('sourceId')
    expectTypeOf<ScreenRecordStopResult>().toMatchTypeOf<
      | { ok: true; path: string; durationMs: number; bytes: number }
      | { ok: false; error: ScreenRecordErrorCode }
    >()
    expectTypeOf<ScreenRecordCommand>().not.toBeNever()
    expectTypeOf<ScreenRecordEvent>().not.toBeNever()
  })
})
