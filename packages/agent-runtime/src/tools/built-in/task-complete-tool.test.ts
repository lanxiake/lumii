import { describe, it, expect } from 'vitest'
import { taskCompleteToolConfig } from './task-complete-tool.js'
import type { ToolExecutionContext } from '../../types/tool.js'

// 这几个字段这个工具用不到；只为满足签名。用不到的上下文传 `{} as` 会在真跑时炸，
// 所以给全（`execute` 现在不看它，但改动一旦开始看，这里要跟着改）。
const ctx = {} as ToolExecutionContext

describe('task_complete · terminate', () => {
  /**
   * 这条断言是防回归的**唯一**理由：`terminate: true` 少一行不会被任何类型、
   * 任何别的测试发现，而代价是模型调完 task_complete 回合作罢不了、反复再调——
   * 2026-10-12 微信代聊实测一个回合 109 次模型往返 / 60 次 task_complete /
   * 1089 万 inputTokens / 3 分 20 秒。删这一行请连带删掉这条测试并想清楚。
   */
  it('必须带 terminate:true（pi 的 shouldTerminateToolBatch 靠它收尾）', async () => {
    const res = await taskCompleteToolConfig.execute('call-1', { summary: '干完了' }, ctx)
    expect(res.terminate).toBe(true)
    expect(JSON.parse(res.content[0]!.text as string)).toEqual({
      status: 'completed',
      summary: '干完了',
    })
  })
})
