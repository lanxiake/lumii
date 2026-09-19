/**
 * tool-result-text 单元测试
 *
 * 背景：tool:end 的 result 是 `{content:[{type:'text',text}], details}` 结果对象，
 * 旧实现 `String(part.result)` 让所有失败工具卡片的「错误」都显示成 `[object Object]`。
 * 这里锁死三条判据：能拿到 content 文本、能挑出载荷里的 error 字段、兜底不丢文本。
 */
import { describe, it, expect } from 'vitest'
import { extractToolErrorText } from './tool-result-text'

/** pi-agent 抛错时的结果对象形状（agent-loop.js 重建 result） */
const toolErrorResult = (text: string) => ({
  content: [{ type: 'text', text }],
  details: {},
})

describe('extractToolErrorText', () => {
  it('宿主失败载荷：挑出 error 字段而不是整个 JSON', () => {
    const result = toolErrorResult('{"ok":false,"error":"media store not available"}')
    expect(extractToolErrorText(result)).toBe('media store not available')
  })

  it('载荷 message 字段（另一套失败约定）同样认得', () => {
    const result = toolErrorResult('{"status":"error","message":"任务不存在"}')
    expect(extractToolErrorText(result)).toBe('任务不存在')
  })

  it('error 字段是对象时序列化展示', () => {
    const result = toolErrorResult('{"ok":false,"error":{"code":"EACCES","path":"C:\\\\x"}}')
    expect(extractToolErrorText(result)).toBe('{"code":"EACCES","path":"C:\\\\x"}')
  })

  it('非 JSON 文本原文返回', () => {
    expect(extractToolErrorText(toolErrorResult('Not Found'))).toBe('Not Found')
  })

  it('JSON 数组载荷不解包，原文返回', () => {
    expect(extractToolErrorText(toolErrorResult('[{"ok":false}]'))).toBe('[{"ok":false}]')
  })

  it('字符串结果直接返回', () => {
    expect(extractToolErrorText('boom')).toBe('boom')
  })

  it('多个文本块按行拼接', () => {
    const result = { content: [{ type: 'text', text: '第一行' }, { type: 'text', text: '第二行' }] }
    expect(extractToolErrorText(result)).toBe('第一行\n第二行')
  })

  it('无内容对象序列化展示，不丢信息', () => {
    expect(extractToolErrorText({ code: 500 })).toBe('{"code":500}')
  })

  it('扁平事件载荷（image_generate 失败/中断）取 message 字段', () => {
    expect(
      extractToolErrorText({
        status: 'error',
        code: 'PROVIDER_ERROR',
        message: '绘图服务返回 500',
        retryable: false,
      }),
    ).toBe('绘图服务返回 500')
    expect(extractToolErrorText({ status: 'aborted', message: '图片生成已被用户中断' })).toBe(
      '图片生成已被用户中断',
    )
  })

  it('结果为 undefined / null 时回退默认文案', () => {
    expect(extractToolErrorText(undefined)).toBe('工具执行失败')
    expect(extractToolErrorText(null)).toBe('工具执行失败')
    expect(extractToolErrorText({ content: [] })).toBe('工具执行失败')
  })

  it('载荷 error 为空串时回退原文，而不是显示空', () => {
    expect(extractToolErrorText(toolErrorResult('{"ok":false,"error":"  "}'))).toBe(
      '{"ok":false,"error":"  "}',
    )
  })
})
