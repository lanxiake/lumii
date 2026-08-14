import { describe, expect, it } from 'vitest'
import { assertClickAllowed } from './act'
import type { AppUiClickContext, AppUiRef } from './types'

const sampleRef: AppUiRef = {
  ref: 'e1',
  role: 'button',
  name: '设置',
  x: 10,
  y: 20,
  w: 100,
  h: 40,
}

const current: AppUiClickContext = {
  snapshotId: '42',
  refs: [sampleRef],
}

describe('assertClickAllowed', () => {
  it('缺少 ref 返回 missing_ref', () => {
    expect(
      assertClickAllowed({ ref: '', snapshotId: '42', current, blockRoles: [] }),
    ).toEqual({ ok: false, error: 'missing_ref' })
    expect(
      assertClickAllowed({ ref: undefined, snapshotId: '42', current, blockRoles: [] }),
    ).toEqual({ ok: false, error: 'missing_ref' })
  })

  it('snapshotId 不匹配返回 stale_snapshot', () => {
    expect(
      assertClickAllowed({ ref: 'e1', snapshotId: '99', current, blockRoles: [] }),
    ).toEqual({ ok: false, error: 'stale_snapshot' })
  })

  it('ref 不在当前快照返回 stale_snapshot', () => {
    expect(
      assertClickAllowed({ ref: 'e99', snapshotId: '42', current, blockRoles: [] }),
    ).toEqual({ ok: false, error: 'stale_snapshot' })
  })

  it('命中 blockRoles 返回 blocked_composer', () => {
    const composerRef: AppUiRef = { ...sampleRef, ref: 'e2', role: 'composer' }
    const cache: AppUiClickContext = {
      ...current,
      refs: [composerRef],
    }
    expect(
      assertClickAllowed({
        ref: 'e2',
        snapshotId: '42',
        current: cache,
        blockRoles: ['composer', 'runtime'],
      }),
    ).toEqual({ ok: false, error: 'blocked_composer' })
  })

  it('校验通过返回匹配 ref', () => {
    expect(
      assertClickAllowed({ ref: 'e1', snapshotId: '42', current, blockRoles: ['composer'] }),
    ).toEqual({ ok: true, ref: sampleRef })
  })

  it('未提供 snapshotId 时跳过过期校验', () => {
    expect(
      assertClickAllowed({ ref: 'e1', snapshotId: undefined, current, blockRoles: [] }),
    ).toEqual({ ok: true, ref: sampleRef })
  })
})
