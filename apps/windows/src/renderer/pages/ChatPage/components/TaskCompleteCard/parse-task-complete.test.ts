/**
 * task_complete 解析：真完成 vs 验证门，避免把门禁提示当成用户可见的「已完成」
 */
import { describe, expect, it } from 'vitest'
import { parseTaskCompletePart } from './parse-task-complete'

/** 构造与线上一致的工具结果包装 */
function resultJson(body: unknown) {
  return {
    content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) }],
  }
}

describe('parseTaskCompletePart', () => {
  it('真完成：展示结果里的 summary', () => {
    expect(
      parseTaskCompletePart({
        args: { summary: '参数里的旧摘要' },
        result: resultJson({ status: 'completed', summary: '已整理闲鱼上架文案并落盘' }),
        status: 'completed',
      }),
    ).toEqual({
      phase: 'completed',
      summary: '已整理闲鱼上架文案并落盘',
    })
  })

  it('真完成但结果缺 summary 时回退到参数', () => {
    expect(
      parseTaskCompletePart({
        args: { summary: '从参数补上的总结' },
        result: resultJson({ status: 'completed' }),
        status: 'completed',
      }),
    ).toEqual({
      phase: 'completed',
      summary: '从参数补上的总结',
    })
  })

  it('验证门（isError=false、非 completed）→ gate，不当成完成', () => {
    const tip = '提示：本次未检测到验证步骤。若确认无需验证，请再次调用 task_complete。'
    expect(
      parseTaskCompletePart({
        args: { summary: '我以为做完了' },
        result: resultJson(tip),
        status: 'completed',
        isError: false,
      }),
    ).toEqual({
      phase: 'gate',
      summary: '我以为做完了',
      message: tip,
    })
  })

  it('执行中只露参数摘要', () => {
    expect(
      parseTaskCompletePart({
        args: { summary: '收尾中…' },
        status: 'running',
      }),
    ).toEqual({
      phase: 'running',
      summary: '收尾中…',
    })
  })

  it('工具报错 → failed', () => {
    expect(
      parseTaskCompletePart({
        result: resultJson('boom'),
        status: 'error',
        isError: true,
      }),
    ).toEqual({
      phase: 'failed',
      message: 'boom',
    })
  })
})
