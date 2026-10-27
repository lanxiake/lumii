/**
 * 「自上次查看以来新增了几份成品」：去重、只算成品、时间严格大于边界。
 */
import { describe, it, expect } from 'vitest'
import { countDeliverablesSince, type CountableMessage } from './artifact-count'

function msg(timestamp: number, paths: Array<[string, string?]>): CountableMessage {
  return {
    timestamp,
    fileChanges: paths.map(([path, status]) => ({
      path,
      status: status ?? 'added',
      confidence: 'exact',
    })),
  }
}

describe('countDeliverablesSince', () => {
  it('只算比 since 新的成品；同一路径多轮改写只算一条', () => {
    const messages: CountableMessage[] = [
      msg(100, [['outputs/x/final.png']]),
      msg(200, [['outputs/x/final.png', 'modified'], ['outputs/x/cover.png']]),
    ]
    // since=150：只有 msg(200) 命中 → final.png 与 cover.png 两份
    expect(countDeliverablesSince(messages, 150)).toBe(2)
    // since=0：final.png 出现两次，按路径去重后仍是两份
    expect(countDeliverablesSince(messages, 0)).toBe(2)
    // since=250：全都在上次查看之前
    expect(countDeliverablesSince(messages, 250)).toBe(0)
  })

  it('严格大于边界：恰好等于 since 的那条不算', () => {
    const messages: CountableMessage[] = [msg(100, [['outputs/x/a.md']])]
    expect(countDeliverablesSince(messages, 100)).toBe(0)
    expect(countDeliverablesSince(messages, 99)).toBe(1)
  })

  it('过程文件、临时文件、删除与未归属都不计', () => {
    const messages: CountableMessage[] = [
      msg(200, [
        ['outputs/x/parts/cut-1.png'], // intermediate
        ['temp/github3/a.txt'], // ephemeral
        ['outputs/x/gone.md', 'deleted'], // 删除
      ]),
      {
        timestamp: 210,
        fileChanges: [{ path: 'outputs/x/guess.png', status: 'added', confidence: 'unattributed' }],
      },
    ]
    expect(countDeliverablesSince(messages, 0)).toBe(0)
  })

  it('大小写与反斜杠路径按分类器同一口径', () => {
    const messages: CountableMessage[] = [
      { timestamp: 300, fileChanges: [{ path: 'OUTPUTS\\X\\A.MD', status: 'added' }] },
    ]
    expect(countDeliverablesSince(messages, 0)).toBe(1)
  })
})
