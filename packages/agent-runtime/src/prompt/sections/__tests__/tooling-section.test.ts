/**
 * Tooling section 漂移守卫测试
 *
 * 目的：锁死「提示词工具清单」与「运行时工具注册表」的一致性。
 * 计划依据：docs/plans/Agent协作与提示词/2026-08-28-Tooling提示词重构实施计划.md P0-T8
 *
 * 这些测试是 P0/P1/P2 各阶段的验收闸门——任何新增工具漏配分组、
 * 或映射表残留已注销的工具名，都会在此处立即失败。
 */

import { describe, it, expect, vi } from "vitest"
import { categorizeTools, TOOL_SUMMARIES, PROMPT_TOOL_GROUPS } from "../tooling-section.js"
import { ALL_BUILT_IN_TOOL_CONFIGS } from "../../../tools/built-in/index.js"

/** 注册表中真实存在的 built-in 工具名 */
const BUILT_IN_NAMES: readonly string[] = ALL_BUILT_IN_TOOL_CONFIGS.map((c) => c.name)

/**
 * 客户端（apps/windows）注册、runtime 编译期无法枚举的工具名。
 * 这些名字允许出现在 TOOL_SUMMARIES / 分组里而无对应 built-in config。
 *
 * ⚠️ 这份清单是手工维护的，会腐坏——2026-09-18 实测它漏了 6 个（云同步 5 个 + 开发转交 1 个），
 * 那 6 个在生产里落进了 `Other Tools`。**漏配会被两道守卫接住**：
 *   ① 本文件第 5 条「分组常量不含未注册的幽灵工具名」——加了分组却忘了加这里；
 *   ② `apps/windows/src/main/agent-runtime/host-tool-prompt-coverage.test.ts`
 *      （源码扫描宿主注册器）——加了工具却忘了加分组。
 * 两份守卫合起来才闭环，改一处务必想着另一处。
 */
const CLIENT_REGISTERED_NAMES: readonly string[] = [
  "a2ui_guide",
  "cron_guide",
  "weixin_send_guide",
  "prompt_guide",
  "browser_navigate",
  "browser_screenshot",
  "browser_click",
  "browser_type",
  "browser_scroll",
  "browser_wait",
  "browser_eval",
  "browser_back",
  "browser_forward",
  // 云同步（bridge-tool-registrar-sync.ts）与开发转交（bridge-tool-registrar-handoff.ts）
  // 2026-09-18 补入提示词分组——此前它们在 Other Tools 里，minimal 档下只是个数字
  "cloud_sync_read_file",
  "cloud_sync_git",
  "cloud_sync_now",
  "cloud_sync_push",
  "resolve_sync_conflict",
  "propose_dev_handoff",
]

/** 已定义常量但尚未注册的工具名（预置分组，避免注册即无描述） */
const PRE_REGISTERED_NAMES: readonly string[] = ["execute_skill"]

const KNOWN_NAMES = new Set<string>([
  ...BUILT_IN_NAMES,
  ...CLIENT_REGISTERED_NAMES,
  ...PRE_REGISTERED_NAMES,
])

/** 从 categorizeTools 输出中提取某工具所属的 `### 分组名` */
function groupOf(toolName: string): string | undefined {
  const lines = categorizeTools([toolName])
  let current: string | undefined
  for (const line of lines) {
    if (line.startsWith("### ")) current = line.slice(4).trim()
    if (line.startsWith(`- \`${toolName}\``) || line.includes(`\`${toolName}\``)) {
      return current
    }
  }
  return undefined
}

/** 从 categorizeTools 输出中提取某工具的描述文本（无描述返回空串） */
function hintOf(toolName: string): string {
  const lines = categorizeTools([toolName])
  const own = lines.find((l) => l.startsWith(`- \`${toolName}\``))
  if (!own) return ""
  const idx = own.indexOf("`: ")
  return idx === -1 ? "" : own.slice(idx + 3).trim()
}

describe("tooling-section 漂移守卫", () => {
  it("每个已注册的 built-in 工具都归入正式分组（非 Other Tools）", () => {
    const orphans = BUILT_IN_NAMES.filter((name) => {
      const g = groupOf(name)
      return g === undefined || g === "Other Tools"
    })
    expect(orphans, `以下工具未归入正式分组，落进 Other Tools: ${orphans.join(", ")}`).toEqual([])
  })

  it("每个已注册的 built-in 工具都有非空描述", () => {
    const missing = BUILT_IN_NAMES.filter((name) => hintOf(name).length === 0)
    expect(missing, `以下工具在提示词中无描述: ${missing.join(", ")}`).toEqual([])
  })

  it("TOOL_SUMMARIES 不含已注销的死键", () => {
    const dead = Object.keys(TOOL_SUMMARIES).filter((name) => !KNOWN_NAMES.has(name))
    expect(dead, `以下键在注册表中不存在（死键）: ${dead.join(", ")}`).toEqual([])
  })

  it("分组集合两两不重叠", () => {
    const overlaps: string[] = []
    const groups = Object.entries(PROMPT_TOOL_GROUPS)
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const [labelA, setA] = groups[i]!
        const [labelB, setB] = groups[j]!
        for (const tool of setA) {
          if (setB.has(tool)) overlaps.push(`${tool} 同时属于 ${labelA} 与 ${labelB}`)
        }
      }
    }
    expect(overlaps, overlaps.join("; ")).toEqual([])
  })

  it("分组常量不含未注册的幽灵工具名", () => {
    const ghosts: string[] = []
    for (const [label, set] of Object.entries(PROMPT_TOOL_GROUPS)) {
      for (const tool of set) {
        if (!KNOWN_NAMES.has(tool)) ghosts.push(`${tool}（在 ${label}）`)
      }
    }
    expect(ghosts, `以下分组成员在注册表中不存在: ${ghosts.join(", ")}`).toEqual([])
  })

  it("完整注册表喂进去时不产生 Other Tools 分组", () => {
    const lines = categorizeTools([...BUILT_IN_NAMES, ...CLIENT_REGISTERED_NAMES])
    expect(lines).not.toContain("### Other Tools")
  })

  // ── 运行时告警（2026-09-18 补）────────────────────────────────────────────
  // 静态守卫（apps/windows 的 host-tool-prompt-coverage.test.ts）扫的是源码，
  // 覆盖不到运行时动态注册的工具（bridge.ts 的 registerEvolvedTool）。
  // partitionToolNames 里的 console.warn 是那一半的兜底——这里给它上锁，
  // 否则它只是"写了但没人验"，哪天被顺手删掉也不会有人发现。

  it("未归类的工具触发运行时告警（兜住静态守卫扫不到的动态注册）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      categorizeTools(["some_dynamically_registered_tool"])
      expect(warn).toHaveBeenCalledTimes(1)
      const msg = String(warn.mock.calls[0]![0])
      expect(msg).toContain("some_dynamically_registered_tool")
      expect(msg).toContain("未归入任何提示词分组")
    } finally {
      warn.mockRestore()
    }
  })

  it("工具全部归组时不告警（否则告警会被当噪声忽略）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      categorizeTools([...BUILT_IN_NAMES, ...CLIENT_REGISTERED_NAMES])
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it("Desktop Control 前缀不算未归类（它们本就不进正式分组）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      categorizeTools(["app_act", "screen_record_start", "screen_screenshot"])
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
