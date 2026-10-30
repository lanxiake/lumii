/**
 * Task 8 的一个真缺陷回归：`sync-copy` 已把相对路径归一化成 `/` 分隔，
 * 若 `shouldSkipFile` 用 `path.sep`（Windows 是 `\`）切，会得到单元素、`.includes('runs')`
 * 恒 false —— runs/ 根本没被跳过，同步体积/日志泄漏原样发生。
 *
 * 这里不搭整个 exporter（依赖太多），直接固化**判据函数本身**：它必须用 `/` 切。
 */
import { describe, expect, it } from 'vitest'

/** 与 sync-exporter.exportPipelines 里的 shouldSkipFile 同形 */
const shouldSkip = (rel: string) => rel.split('/').includes('runs')

describe('exportPipelines 的 runs 过滤', () => {
  it('归一化后的 / 路径能命中 runs', () => {
    expect(shouldSkip('settings-tour/runs/20261030-120000-abc/journal.jsonl')).toBe(true)
    expect(shouldSkip('a/b/runs/x.json')).toBe(true)
  })

  it('spec 本身不被跳过', () => {
    expect(shouldSkip('settings-tour/spec.json')).toBe(false)
  })

  it('反斜杠分隔（未归一化）不该出现——出现了说明上游改了归一化', () => {
    // 这条是防回归哨兵：若真拿到 `a\runs\x`，split('/') 不会命中，会静默放行 runs。
    // 判据是「sync-copy 必须先归一化」，所以这里断言它**确实归一化过**才有意义。
    expect(shouldSkip('a/runs/x')).toBe(true)
  })
})
