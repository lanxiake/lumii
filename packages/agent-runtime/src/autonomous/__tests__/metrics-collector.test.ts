/**
 * 指标收集器测试（V53 起）
 *
 * 这里钉的是**脱敏边界**与**摘要的确定性**两件事：
 *
 * 1. 用户原话**不进**这条链（`buildSessionSnapshot` 把消息正文抹成空串）——
 *    曾经 `taskDescription` 取的是 `messages[0].content`，一旦哪天有人"顺手"
 *    把正文填回去，这一条会红。
 * 2. 摘要必须**确定**：同一批工具调用换个顺序也要得到同一个字符串，
 *    否则落库的值、日志、测试断言三者会互相飘。
 */

import { describe, it, expect } from 'vitest';
import { collectMetricsFromSession, summarizeToolCalls } from '../metrics-collector';

describe('summarizeToolCalls', () => {
  it('按次数降序、同次数按名字升序', () => {
    expect(
      summarizeToolCalls([
        { toolName: 'grep' },
        { toolName: 'file_read' },
        { toolName: 'file_read' },
        { toolName: 'file_read' },
        { toolName: 'grep' },
        { toolName: 'bash' },
      ])
    ).toBe('file_read×3, grep×2, bash');
  });

  it('输入顺序不影响输出（确定性）', () => {
    const a = summarizeToolCalls([{ toolName: 'a' }, { toolName: 'b' }, { toolName: 'a' }]);
    const b = summarizeToolCalls([{ toolName: 'b' }, { toolName: 'a' }, { toolName: 'a' }]);
    expect(a).toBe(b);
    expect(a).toBe('a×2, b');
  });

  it('次数为 1 时不带 ×1 后缀', () => {
    expect(summarizeToolCalls([{ toolName: 'web_search' }])).toBe('web_search');
  });

  it('没有工具调用 → undefined（不是空串，让"没有"与"有但是空"可分）', () => {
    expect(summarizeToolCalls([])).toBeUndefined();
    expect(summarizeToolCalls(undefined)).toBeUndefined();
  });

  it('工具名缺失或空白的条目跳过；全空按"没有"处理', () => {
    expect(summarizeToolCalls([{ toolName: '' }, { toolName: '  ' }, {}])).toBeUndefined();
    expect(summarizeToolCalls([{ toolName: '' }, { toolName: 'grep' }])).toBe('grep');
  });

  it('超长截断到 200 字符（这是给人读的一行，不是数据）', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ toolName: `tool_${String(i).padStart(3, '0')}` }));
    const out = summarizeToolCalls(many);
    expect(out).toBeDefined();
    expect((out as string).length).toBeLessThanOrEqual(200);
  });
});

describe('collectMetricsFromSession', () => {
  it('taskDescription 来自工具摘要，不是消息正文', () => {
    const metrics = collectMetricsFromSession({
      id: 'session-1',
      agentId: 'agent-1',
      startedAt: new Date('2026-09-24T10:00:00Z'),
      messages: [{ role: 'user', content: '这是一句不该出现在自主进化链路里的用户原话' }],
      toolCalls: [
        { success: true, toolName: 'file_read' },
        { success: true, toolName: 'file_read' },
        { success: false, toolName: 'grep' },
      ],
      errors: [{ message: 'grep failed' }],
    });

    expect(metrics.taskDescription).toBe('file_read×2, grep');
    // ★ 脱敏断言：整条指标里不许出现用户原话
    expect(JSON.stringify(metrics)).not.toContain('不该出现');
  });

  it('工具计数与错误计数照实带出（V53 起落库）', () => {
    const metrics = collectMetricsFromSession({
      id: 'session-2',
      agentId: 'agent-1',
      startedAt: new Date('2026-09-24T10:00:00Z'),
      messages: [],
      toolCalls: [{ success: true }, { success: false }],
      errors: [{ message: 'boom' }],
    });

    expect(metrics.toolCallCount).toBe(2);
    expect(metrics.errorCount).toBe(1);
  });

  it('无工具调用的会话：taskDescription 为 undefined 而不是空串', () => {
    const metrics = collectMetricsFromSession({
      id: 'session-3',
      agentId: 'agent-1',
      startedAt: new Date('2026-09-24T10:00:00Z'),
      messages: [{ role: 'user', content: '你好' }],
      toolCalls: [],
    });

    expect(metrics.taskDescription).toBeUndefined();
  });
});
