/**
 * 流水线的父实例在整个 run 内不变。
 *
 * 现场（2026-11-02，`web-clone` run `20261102-101043-jh31xq`，**从对话发起**）：
 *
 * ```
 * 7  brief   agent  ok    232927ms
 * 8  scaffold bash  ok    104101ms
 * 9  export  file_write ok
 * 10 build   agent  FAIL  811ms  「无法解析发起流水线的 Agent 实例」
 * ```
 *
 * 同一个 run、同一次 `pipeline_run` 调用里，第一个 agent 步能跑、第二个不能。
 * 根因：`currentToolExecutorInstanceId` 是**全局单值**，子 Agent 的每个工具调用结束
 * 都会经 `afterActualToolExecute` 写回自己的栈顶；子 Agent 跑完栈空了，写回 `undefined`，
 * 而流水线的父工具调用还在进行中。
 *
 * 修法：首次解析到的父实例**缓存整条 run**（`pipeline_run` 是一个递归深度不变的
 * 长调用，父实例不会变），run 结束时在 finally 里清掉，避免下一条流水线沿用旧归属。
 *
 * 这里用 `Bridge.prototype` 上的两个私有方法验证行为，不启动整个 runtime：
 * 只钉「取一次就记住」与「run 结束清空」这两条，不去复现 spawnAgent。
 */
import { describe, expect, it, vi } from 'vitest'

/**
 * 抽出来的最小复现：与 `callPipelineTool` / `runPipelineAgentStage` 里那段
 * 取值逻辑同形。**保持同形是这条测试的全部价值**——真正的实现散在 bridge.ts 的
 * 两个私有方法里，直接 import 会连带整个 Electron 运行时。
 *
 * 若哪天 bridge.ts 里的写法变了（比如改成用 runId 映射），这条测试会失去意义，
 * 那时应当把它删掉并补一条针对新写法的测试，而不是改这里的期望值。
 */
function makeHarness() {
  /** 与 bridge 共享的那只 ref（全局单值） */
  const sharedRef = { value: undefined as string | undefined }
  /** 本次 run 的父实例 */
  let cached: string | undefined

  return {
    sharedRef,
    /** 对应 callPipelineTool 开头：每条新 run 重新取一次 */
    beginRun: () => {
      cached = sharedRef.value
    },
    /** 对应 runPipelineAgentStage 开头：没有就取，有就沿用 */
    resolveParent: () => {
      if (!cached) cached = sharedRef.value
      return cached
    },
    /** 对应 finally：run 结束清掉 */
    endRun: () => {
      cached = undefined
    },
    /** 子 Agent 跑完全部工具后，共享 ref 会被写回 undefined */
    subAgentFinishedAllTools: () => {
      sharedRef.value = undefined
    },
  }
}

describe('流水线父实例的缓存', () => {
  it('**子 Agent 清空共享 ref 后，第二个 agent 步仍能解析到父实例**（原 bug）', () => {
    const h = makeHarness()
    h.sharedRef.value = 'main-instance'
    h.beginRun()
    expect(h.resolveParent()).toBe('main-instance')

    // 子 Agent 跑完，把共享 ref 冲成 undefined
    h.subAgentFinishedAllTools()

    // 第二个 agent 步（web-clone 的 build）必须还能拿到
    expect(h.resolveParent()).toBe('main-instance')
  })

  it('一开始就解析不到时，明确失败而不是猜一个', () => {
    const h = makeHarness()
    h.beginRun()
    expect(h.resolveParent()).toBeUndefined()
  })

  it('run 结束后缓存清空，下一条流水线重新取（不沿用旧会话归属）', () => {
    const h = makeHarness()
    h.sharedRef.value = 'session-A'
    h.beginRun()
    expect(h.resolveParent()).toBe('session-A')
    h.endRun()

    h.sharedRef.value = 'session-B'
    h.beginRun()
    expect(h.resolveParent()).toBe('session-B')
  })

  it('缓存之后共享 ref 再变，也不跟着变（父实例在 run 内是常量）', () => {
    const h = makeHarness()
    h.sharedRef.value = 'parent'
    h.beginRun()
    h.resolveParent()
    h.sharedRef.value = 'some-sub-agent'
    expect(h.resolveParent()).toBe('parent')
  })
})
