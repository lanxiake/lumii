/**
 * gc 触发判据。
 *
 * **这条测试的核心是防死循环**：2026-11-04 实测，`git repack --max-pack-size=64m`
 * 产出的包会略超 64MiB（69,755,753 字节 ≈ 66.5MiB）。原先用 `bytes > 64MiB` 判定，
 * 于是拆包后自检仍判超限 → 每轮同步都跑一次 5-10 分钟的全量 gc，而 gc 又拆不出更小的包。
 *
 * 判据藏在 4000 行的类里时没人测得动它，所以提成了纯函数。
 */
import { describe, expect, it } from 'vitest'
import { shouldRunObjectStoreGc } from './sync-manager'

const MiB = 1024 * 1024

/** 12 个 64MiB 包：总体积 768MiB → 稳态 ≈ 12 + 4 = 16，12 不该触发 */
const quiet = { packCount: 12, looseCount: 10, looseSizeKib: 1024, packBytes: Array(12).fill(64 * MiB) }

describe('shouldRunObjectStoreGc', () => {
  it('稳态：包数与松散对象都在阈值内 → 不 gc', () => {
    expect(shouldRunObjectStoreGc(quiet)).toBe(false)
  })

  /**
   * **关键回归**：略超 64MiB 的包不算超限。
   *
   * 现场数值：69,755,753 字节。改成 `bytes > 64MiB` 会让这条恒为 true，
   * 于是每轮同步都 gc——修之前就是这么耗着。
   */
  it('略超 64MiB 的包（repack 的正常溢出）不触发 gc', () => {
    expect(
      shouldRunObjectStoreGc({ ...quiet, packBytes: [...Array(11).fill(64 * MiB), 69_755_753] }),
    ).toBe(false)
  })

  it('真·GB 级单包仍要 gc（isomorphic-git 整包读内存会废）', () => {
    expect(shouldRunObjectStoreGc({ ...quiet, packBytes: [...Array(11).fill(64 * MiB), 1024 * MiB] })).toBe(
      true,
    )
  })

  it('包数远超稳态 → gc（有东西可并）', () => {
    // 40 个 1MiB 的小包：总 40MiB → 稳态 max(8, 1)+… 远小于 40
    expect(
      shouldRunObjectStoreGc({ ...quiet, packCount: 40, packBytes: Array(40).fill(1 * MiB) }),
    ).toBe(true)
  })

  /**
   * **真实场景回归**（2026-11-04）：4.5GB / 78 包 / 稳态按固定余量算是 75。
   * 只差 3 个就触发一次 10 分钟 gc，而 gc 根本合并不出更少的包——包数在 75~147 震荡。
   * 改成 25% 比例余量后，78 落在稳态内，不再触发。
   */
  it('4.5GB 仓库的 78 包不再触发（固定余量 4 时会）', () => {
    const totalMiB = 4510
    const byVolume = Math.ceil(totalMiB / 64) // ≈ 71
    const packs = Array(78).fill(0).map((_, i) => Math.floor((totalMiB / 78) * MiB) + (i === 0 ? 1 : 0))
    expect(shouldRunObjectStoreGc({ packCount: 78, looseCount: 0, looseSizeKib: 0, packBytes: packs })).toBe(
      false,
    )
    // 顺带确认「固定余量 4」会判超限——这条测试确实覆盖了那次回归
    expect(78 > byVolume + 4).toBe(true)
  })

  it('松散对象过多 / 过大 → gc（iso 提交只写松散对象，不会自动打包）', () => {
    expect(shouldRunObjectStoreGc({ ...quiet, looseCount: 5000 })).toBe(true)
    // 阈值 200MiB = 204800 KiB
    expect(shouldRunObjectStoreGc({ ...quiet, looseSizeKib: 300 * 1024 })).toBe(true)
  })

  it('空仓库不 gc（0 个包、0 个松散对象）', () => {
    expect(shouldRunObjectStoreGc({ packCount: 0, looseCount: 0, looseSizeKib: 0, packBytes: [] })).toBe(
      false,
    )
  })
})
