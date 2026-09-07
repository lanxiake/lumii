/**
 * mergeAssistantParts / mergeFileChanges 单元测试
 */
import { describe, it, expect } from 'vitest'
import type { AssistantPart, FileChangeEntry } from '@mtbot/agent-runtime/browser'
import { mergeAssistantParts, mergeFileChanges } from './mergeAssistantParts'

describe('mergeAssistantParts', () => {
  it('子 Agent parts 追加到父消息末尾，保持时间顺序', () => {
    const parent: AssistantPart[] = [
      { type: 'thinking', id: 'th-1', text: 'plan', status: 'done' },
      { type: 'tool', id: 't1', name: 'Read', args: {}, status: 'done' },
      { type: 'text', id: 'tx1', text: 'partial', status: 'done' },
      { type: 'text', id: 'tx2', text: 'final', status: 'done' },
    ]
    const child: AssistantPart[] = [
      { type: 'tool', id: 't2', name: 'Write', args: {}, status: 'done' },
    ]

    const merged = mergeAssistantParts(parent, child)

    // 修复后：子 Agent parts 追加到末尾，避免打乱主 Agent 已输出的内容顺序
    expect(merged.map((p) => p.id)).toEqual(['th-1', 't1', 'tx1', 'tx2', 't2'])
  })

  it('无 trailing text 时子 parts 追加到末尾', () => {
    const parent: AssistantPart[] = [
      { type: 'tool', id: 't1', name: 'Read', args: {}, status: 'done' },
    ]
    const child: AssistantPart[] = [
      { type: 'text', id: 'tx1', text: 'done', status: 'done' },
    ]

    expect(mergeAssistantParts(parent, child).map((p) => p.id)).toEqual(['t1', 'tx1'])
  })

  it('child 为空时返回 parent 副本', () => {
    const parent: AssistantPart[] = [
      { type: 'text', id: 'tx1', text: 'only', status: 'done' },
    ]

    expect(mergeAssistantParts(parent, [])).toEqual(parent)
    expect(mergeAssistantParts(parent, undefined)).toEqual(parent)
  })
})

describe('mergeFileChanges', () => {
  it('按 path 去重合并，后者覆盖前者', () => {
    const parent: FileChangeEntry[] = [
      { path: 'a.ts', status: 'modified' },
      { path: 'b.ts', status: 'added' },
    ]
    const child: FileChangeEntry[] = [
      { path: 'a.ts', status: 'deleted' },
      { path: 'c.ts', status: 'added' },
    ]

    expect(mergeFileChanges(parent, child)).toEqual([
      { path: 'a.ts', status: 'deleted' },
      { path: 'b.ts', status: 'added' },
      { path: 'c.ts', status: 'added' },
    ])
  })
})
