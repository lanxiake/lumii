/**
 * 后台任务跟进 · 真实服务联调（默认跳过，只在显式开启时跑）
 *
 * 用法：
 *   LUMII_LIVE_COMFY=1 LUMII_COMFY_URL=https://... LUMII_COMFY_AUTH=Basic ... \
 *     npx vitest run src/main/agent-runtime/background-task-live.integration.test.ts
 *
 * 为什么单独放一个文件：默认 `vitest run` 不该依赖外网和 GPU。这里只读 ComfyUI
 * （查队列/查历史），**不提交渲染任务**，所以跑一次不花钱、不占卡。
 *
 * 覆盖：
 *   - 真实 ComfyUI 上「查无此任务」的判断路径
 *   - 真实历史文本 → 产出文件解析（含 /view 地址拼装）
 *   - 真实不可达地址下 withRetry 的退避与失败分类
 */

import { describe, expect, it } from 'vitest'
import { followComfyJob, parseHistoryOutputs } from './comfyui-job-follower'
import { withRetry } from './with-retry'

const LIVE = process.env.LUMII_LIVE_COMFY === '1'
const BASE_URL = (process.env.LUMII_COMFY_URL || '').replace(/\/+$/, '')
const AUTH = process.env.LUMII_COMFY_AUTH || ''

/** 真实 ComfyUI HTTP 调用：把 JSON 响应序列化成 MCP 风格的文本 */
async function callComfy(endpoint: string, query: Record<string, string> = {}): Promise<string> {
  const url = new URL(`${BASE_URL}/${endpoint}`)
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  const res = await fetch(url, {
    headers: AUTH ? { Authorization: AUTH } : {},
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

describe.runIf(LIVE && BASE_URL)('后台任务跟进 · 真实 ComfyUI', () => {
  it('不存在的 prompt_id 判为「查无此任务」，且不误报成功', async () => {
    const controller = new AbortController()
    const outcome = await followComfyJob({
      promptId: `definitely-not-a-real-${Date.now()}`,
      callTool: (tool, args) => {
        if (tool === 'queue') {
          return callComfy('queue').then((text) => {
            // 真实 /queue 返回 JSON；MCP 的 queue 工具会包一层，这里直接按真实内容判定
            const parsed = JSON.parse(text) as { queue_pending?: unknown[]; queue_running?: unknown[] }
            const found = [...(parsed.queue_running ?? []), ...(parsed.queue_pending ?? [])].length > 0
            return JSON.stringify({ found, done: false, running: found })
          })
        }
        return callComfy('history', { max_items: String(args.prompt_id ?? '') })
      },
      signal: controller.signal,
      intervalMs: 100,
      maxConsecutiveErrors: 2,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.outputs).toHaveLength(0)
  })

  it('真实历史文本能解析出文件（有历史时才断言）', async () => {
    const historyText = await callComfy('history', { max_items: '30' })
    // ComfyUI 原始 /history 是 JSON，MCP 工具才渲染成 `videos → **a.mp4 (type=output)**`。
    // 这里验证的正是那段渲染形状的解析器：用真实文件名回填成该形状再解析。
    const names = [...historyText.matchAll(/"filename"\s*:\s*"([^"]+)"/g)].map((m) => m[1]!)
    if (names.length === 0) {
      console.log('[live] 历史为空，跳过产出解析断言')
      return
    }
    const sample = names[0]!
    const shaped = `videos → **${sample} (type=output)**`
    const outputs = parseHistoryOutputs(shaped, BASE_URL)
    expect(outputs).toHaveLength(1)
    expect(outputs[0]).toMatchObject({ name: sample, path: sample })
    expect(outputs[0]?.url).toContain('/view?')
  })
})

describe('重试 · 真实不可达服务', () => {
  it('对关闭的端口按指数退避重试后抛出原错误', async () => {
    let calls = 0
    const startedAt = Date.now()
    await expect(
      withRetry(
        async () => {
          calls += 1
          const res = await fetch('http://127.0.0.1:9/definitely-closed', {
            signal: AbortSignal.timeout(3_000),
          }).catch((err) => {
            throw new Error(`ECONNREFUSED: ${err.message}`)
          })
          return res.text()
        },
        { maxAttempts: 3, backoffMs: 50, backoffMultiplier: 2, maxBackoffMs: 200 },
      ),
    ).rejects.toThrow(/ECONNREFUSED/)
    expect(calls).toBe(3)
    // 至少退避过 50ms + 100ms
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140)
  })

  it('不可重试错误（权限）只尝试一次', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls += 1
          throw new Error('permission denied')
        },
        { maxAttempts: 5, backoffMs: 10 },
      ),
    ).rejects.toThrow('permission denied')
    expect(calls).toBe(1)
  })
})
