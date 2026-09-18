/**
 * 宿主工具 ↔ 提示词分组 一致性守卫
 *
 * 目的：宿主注册的工具必须归入某个提示词分组，否则会在 system prompt 里落进
 * `Other Tools`。minimal 档（生产主力）下模型只看到一句 `Other Tools (9)`——
 * 连名字都没有，更别说"何时用"。
 *
 * 为什么放在 apps/windows 而不是 packages/agent-runtime：
 * 宿主工具注册器在这里。2026-08-28 Tooling 计划的约定是 runtime 侧对客户端工具
 * 只做前缀归类（Desktop Control），不硬编码逐个工具名——所以这层校验放宿主侧。
 *
 * 为什么用源码扫描而不是调用 registerAll()：
 * `BridgeToolRegistrar` 需要完整的 `BridgeToolRegistrarDeps`（toolContext / config /
 * 各 repo），测试里构造不出来。源码扫描的**已知盲区**是运行时动态注册的工具
 * （`bridge.ts` 的 `registerEvolvedTool` 走工具进化产物，名字跑的时候才知道）——
 * 那一半由 `tooling-section.ts` 的 `partitionToolNames` 运行时告警兜底：
 * 只要落进 Other Tools，名字就会进日志。两层互补，缺一不可。
 *
 * 背景与实测数据：docs/plans/Agent协作与提示词/2026-09-18-工具面治理执行计划与场景推演.md §二 场景 3
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PROMPT_TOOL_GROUPS } from '@mtbot/agent-runtime'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 抓工具配置里的 `name: 'xxx'`。缩进前缀是为了避开类型定义与对象字面量里的同名字段 */
const NAME_RE = /^\s+name:\s*['"]([a-z][a-z0-9_]{2,})['"]/gm

/**
 * 刻意不进正式分组的工具：`partitionToolNames` 会把它们归入 `Desktop Control`。
 * 判定必须与 `packages/agent-runtime/src/prompt/sections/tooling-section.ts` 保持一致——
 * 否则守卫会与生产渲染各说各话。
 */
function isDesktopControl(name: string): boolean {
  return name.startsWith('app_') || name.startsWith('screen_record_') || name === 'screen_screenshot'
}

/** 扫 bridge-*.ts 源码，收集宿主注册的工具名 */
function scanHostToolNames(): string[] {
  const names = new Set<string>()
  for (const f of readdirSync(HERE)) {
    if (!f.startsWith('bridge-') || !f.endsWith('.ts') || f.endsWith('.test.ts')) continue
    for (const m of readFileSync(join(HERE, f), 'utf8').matchAll(NAME_RE)) names.add(m[1]!)
  }
  return [...names].sort()
}

describe('宿主工具 ↔ 提示词分组', () => {
  // 元断言：防止扫描因目录/正则失效而空转，让下面那条永远"通过"
  it('扫描结果非空且量级合理', () => {
    const names = scanHostToolNames()
    expect(names.length).toBeGreaterThan(20)
    expect(names).toContain('browser_navigate')
    expect(names).toContain('app_act')
  })

  it('每个宿主注册的工具都归入正式分组（Desktop Control 除外）', () => {
    const known = new Set(Object.values(PROMPT_TOOL_GROUPS).flatMap((s) => [...s]))
    const orphans = scanHostToolNames().filter((n) => !known.has(n) && !isDesktopControl(n))

    expect(
      orphans,
      `以下宿主工具不在任何提示词分组，会在 system prompt 里落进 Other Tools：\n` +
        orphans.map((n) => `  - ${n}`).join('\n') +
        `\n\n处理方式二选一：\n` +
        `  1. 加进 packages/agent-runtime/src/prompt/sections/tooling-section.ts 的\n` +
        `     PROMPT_TOOL_GROUPS（连同 TOOL_SUMMARIES 一条"何时用"）——**推荐**，它们在被真实使用；\n` +
        `  2. 若确实是本客户端 UI 控制面，加进上面的 isDesktopControl() 并同步\n` +
        `     tooling-section.ts 的 partitionToolNames。`,
    ).toEqual([])
  })

  it('分组成员与宿主实际注册的工具对得上（防止分组里留死名）', () => {
    const hostNames = new Set(scanHostToolNames())
    const dead: string[] = []
    for (const [label, members] of Object.entries(PROMPT_TOOL_GROUPS)) {
      for (const m of members) {
        // 只查那些"看起来像宿主工具"的：内置工具不在此目录，跳过
        if (m.startsWith('browser_') || m.endsWith('_guide')) {
          if (!hostNames.has(m)) dead.push(`${m}（在 ${label}）`)
        }
      }
    }
    expect(
      dead,
      `以下分组成员在宿主注册器里找不到对应实现（工具可能已下线）：${dead.join(', ')}`,
    ).toEqual([])
  })
})
