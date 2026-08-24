/**
 * 会话列表预览文本提取测试
 *
 * 覆盖 assistant_parts（当前落库格式）与扁平 text（旧数据）两种 content_json 结构，
 * 回归「侧栏会话大量显示暂无消息」的缺陷。
 */

import { describe, it, expect } from 'vitest'
import { extractPreviewText } from '../../main/ipc/agent-runtime/conversation-commands'

describe('extractPreviewText', () => {
  it('从 assistant_parts 中取出 text part 的正文', () => {
    const json = JSON.stringify({
      type: 'assistant_parts',
      parts: [
        { type: 'thinking', id: 'th-1', text: '我需要先读文件', status: 'done' },
        { type: 'text', id: 'tx-1', text: '已经帮你修好了。', status: 'done' },
      ],
    })
    expect(extractPreviewText(json)).toBe('已经帮你修好了。')
  })

  it('拼接多个 text part，忽略 thinking 与 tool', () => {
    const json = JSON.stringify({
      type: 'assistant_parts',
      parts: [
        { type: 'text', id: 'tx-1', text: '第一段', status: 'done' },
        { type: 'tool', id: 't-1', name: 'Read', args: {}, status: 'done' },
        { type: 'thinking', id: 'th-1', text: '不该出现', status: 'done' },
        { type: 'text', id: 'tx-2', text: '第二段', status: 'done' },
      ],
    })
    expect(extractPreviewText(json)).toBe('第一段 第二段')
  })

  it('纯工具调用的 assistant 消息没有正文，返回空串', () => {
    const json = JSON.stringify({
      type: 'assistant_parts',
      parts: [{ type: 'tool', id: 't-1', name: 'Bash', args: {}, status: 'running' }],
    })
    expect(extractPreviewText(json)).toBe('')
  })

  it('兼容扁平 text 结构（旧数据与用户消息）', () => {
    expect(extractPreviewText(JSON.stringify({ type: 'text', text: '你好' }))).toBe('你好')
  })

  it('兼容 content 字段', () => {
    expect(extractPreviewText(JSON.stringify({ content: '备用字段' }))).toBe('备用字段')
  })

  it('非法 JSON 与非对象返回空串', () => {
    expect(extractPreviewText('not json')).toBe('')
    expect(extractPreviewText('null')).toBe('')
    expect(extractPreviewText('123')).toBe('')
  })

  it('tool_result 消息不产出预览', () => {
    const json = JSON.stringify({
      type: 'tool_result',
      tool_use_id: 'x',
      tool_name: 'Read',
      result: 'file contents',
      is_error: false,
    })
    expect(extractPreviewText(json)).toBe('')
  })

  it('手动压缩摘要被识别并过滤（`[对话摘要]` 前缀）', () => {
    const json = JSON.stringify({
      type: 'assistant_parts',
      parts: [{ type: 'text', id: 'tx', text: '[对话摘要]\n之前讨论了……', status: 'done' }],
    })
    // extractPreviewText 不关心语义，只提文本；由 resolveLastMessagePreview 的 isCompactSummaryText 过滤
    expect(extractPreviewText(json)).toBe('[对话摘要]\n之前讨论了……')
  })

  it('自动压缩摘要被识别并过滤（<conversation_summary> 标签）', () => {
    const json = JSON.stringify({
      type: 'text',
      text: '<conversation_summary>对话开头……</conversation_summary>继续对话。',
    })
    expect(extractPreviewText(json)).toBe('<conversation_summary>对话开头……</conversation_summary>继续对话。')
  })
})
