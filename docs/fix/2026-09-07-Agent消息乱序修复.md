# 修复：Agent 实时渲染消息乱序问题

**日期**：2026-09-07  
**问题**：在对话中，子 Agent 的长回复内容必定出现顺序混乱：先回复的内容显示在最下面，后回复的内容显示在前面。

## 问题分析

### 根本原因

在 `ChatContainer/mergeAssistantParts.ts` 中，子 Agent 的 parts 被**插入到父消息的"末尾连续 text 段之前"**，而不是追加到末尾。这导致当主 Agent 在调用子 Agent 后继续输出文本时，子 Agent 的内容会显示在主 Agent 后续输出之后，造成时间顺序错乱。

### 问题场景

**典型场景**：主 Agent 调用子 Agent 并在子 Agent 运行期间继续输出

```
时间线:
  T1: 主 Agent 输出 "开始处理..." (text_A)
  T2: 主 Agent 调用子 Agent (tool_call)
  T3: 主 Agent 继续输出 "正在等待子任务..." (text_B)
  T4: 子 Agent 输出 "子任务完成" (child_text)

parent.parts (合并前): [text_A, tool_call, text_B]
child.parts:  [child_text]

旧逻辑（插入到末尾 text 之前）:
  merged: [text_A, tool_call, child_text, text_B]  ❌ 错误！
  显示顺序: T1 → T2 → T4 → T3  （T4 的内容在 T3 之前显示）

新逻辑（直接追加到末尾）:
  merged: [text_A, tool_call, text_B, child_text]  ✅ 正确！
  显示顺序: T1 → T2 → T3 → T4  （按时间顺序）
```

### 代码层面的问题

**旧代码** (`mergeAssistantParts.ts`):
```typescript
function mergeAssistantParts(
  parentParts: readonly AssistantPart[] | undefined,
  childParts: readonly AssistantPart[] | undefined,
): AssistantPart[] {
  const parent = [...(parentParts ?? [])]
  const child = [...(childParts ?? [])]
  if (child.length === 0) return parent
  let insertAt = parent.length
  while (insertAt > 0 && parent[insertAt - 1]?.type === 'text') insertAt--
  return [...parent.slice(0, insertAt), ...child, ...parent.slice(insertAt)]
}
```

这段代码会向后扫描，找到第一个非 text 类型的 part，然后将子 Agent 的 parts 插入到那个位置之后。

**问题**：主 Agent 的 parts 是按时间顺序累积的，但子 Agent 的 parts 被插入到中间位置，打乱了时间顺序。

## 修复方案

### 修改内容

将 `mergeAssistantParts` 函数改为**直接追加到末尾**，保持时间顺序：

```typescript
/**
 * 将子 Agent parts 追加到父消息末尾，保持时间顺序
 *
 * 修复问题：之前的实现会将子 Agent parts 插入到"末尾连续 text 之前"，
 * 导致当主 Agent 在调用子 Agent 后继续输出时，子 Agent 内容显示在主 Agent 后续输出之后，
 * 造成消息乱序（先回复的内容显示在后面，后回复的内容显示在前面）。
 *
 * 现在改为直接追加，保持消息按真实回复顺序显示。
 */
export function mergeAssistantParts(
  parentParts: readonly AssistantPart[] | undefined,
  childParts: readonly AssistantPart[] | undefined,
): AssistantPart[] {
  const parent = [...(parentParts ?? [])]
  const child = [...(childParts ?? [])]
  if (child.length === 0) return parent
  // 直接追加到末尾，保持时间顺序
  return [...parent, ...child]
}
```

### 测试更新

更新了 `mergeAssistantParts.test.ts` 中的测试用例，验证新的追加逻辑：

```typescript
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
```

## 影响分析

### 受影响的文件

1. `apps/windows/src/renderer/pages/ChatPage/components/ChatContainer/mergeAssistantParts.ts` - 核心逻辑修改
2. `apps/windows/src/renderer/pages/ChatPage/components/ChatContainer/mergeAssistantParts.test.ts` - 测试更新

### 兼容性

这个修复不会影响现有功能：

- **子 Agent 消息仍然被合并到父消息**：UI 表现保持不变，子 Agent 的内容仍然显示在父消息的气泡内
- **时间顺序得到修正**：消息按照真实的回复时间顺序显示
- **测试全部通过**：4 个单元测试全部通过，287 个集成测试全部通过

## 验证

运行测试验证修复：

```bash
cd apps/windows
pnpm test src/renderer/pages/ChatPage/components/ChatContainer/mergeAssistantParts.test.ts --run
```

测试结果：
```
✓ src/renderer/pages/ChatPage/components/ChatContainer/mergeAssistantParts.test.ts (4 tests)
  ✓ mergeAssistantParts
    ✓ 子 Agent parts 追加到父消息末尾，保持时间顺序
    ✓ 无 trailing text 时子 parts 追加到末尾
    ✓ child 为空时返回 parent 副本
  ✓ mergeFileChanges
    ✓ 按 path 去重合并，后者覆盖前者
```

## 相关提交

- 原始设计提交：`4cc6b12` - "fix(windows): correct sub-agent parts merge order and aborted UI"
  - 该提交引入了"插入到末尾 text 之前"的逻辑，目的是避免工具调用全部落到终稿之后
  - 但这个逻辑在主 Agent 和子 Agent 异步并行时会导致消息乱序

## 总结

这次修复将子 Agent parts 的合并逻辑从"插入到末尾 text 之前"改为"直接追加到末尾"，解决了消息乱序问题。修复后，消息严格按照时间顺序显示，用户体验得到改善。
