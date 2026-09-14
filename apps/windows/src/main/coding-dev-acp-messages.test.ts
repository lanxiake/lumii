/**
 * ACP 失败消息的文案契约与判定（09-P3b）。
 *
 * 判定的两端：`coding-dev-acp-run.ts` 用前缀构造消息，`dev-handoff-executor` 用同一组前缀判失败。
 * 本测试同时钉住「前缀稳定」与「不误判正常产出」两件事。
 */

import { describe, expect, it } from 'vitest'
import {
  ACP_CANCELLED_PREFIX,
  ACP_ERROR_PREFIX,
  isAcpRunFailureText,
} from './coding-dev-acp-messages'

describe('isAcpRunFailureText', () => {
  it('识别执行失败与超时（run 实际构造的文案形态）', () => {
    expect(isAcpRunFailureText(`${ACP_ERROR_PREFIX}执行失败：spawn claude ENOENT`)).toBe(true)
    expect(
      isAcpRunFailureText(`${ACP_ERROR_PREFIX}执行超时（已等待 60 分钟）。任务已中止。`),
    ).toBe(true)
  })

  it('识别用户取消', () => {
    expect(isAcpRunFailureText(`${ACP_CANCELLED_PREFIX}。`)).toBe(true)
  })

  it('正常产出不误判——包括以 ❌ 开头但并非 ACP 失败的普通文本', () => {
    expect(isAcpRunFailureText('已修复 Pager 的页码边界并补了用例，改动 2 个文件。')).toBe(false)
    // 关键：只看 ❌ 不够，必须是 `❌ ACP ` 这个前缀
    expect(isAcpRunFailureText('❌ 这个测试挂了，我顺手改了一下')).toBe(false)
    expect(isAcpRunFailureText('已取消订阅逻辑的重构已经完成')).toBe(false)
  })

  it('空值与空白安全', () => {
    expect(isAcpRunFailureText('')).toBe(false)
    expect(isAcpRunFailureText('   ')).toBe(false)
    expect(isAcpRunFailureText(undefined)).toBe(false)
  })

  it('允许前后空白（消息可能被拼接/裁剪）', () => {
    expect(isAcpRunFailureText(`  ${ACP_ERROR_PREFIX}执行失败：x  `)).toBe(true)
  })
})
