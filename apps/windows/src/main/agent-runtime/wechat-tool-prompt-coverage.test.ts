/**
 * 「本机微信工具清单」三方对账。
 *
 * 这份清单被抄在三个地方，而**唯一的事实源是 Python 侧**（`assets/wechat/app.py` 的
 * `TOOLS`）——工具是真由那边实现的：
 *
 *   ① `app.py` 的 `TOOLS`（减掉 `sidecar.py` 里 `_UNAVAILABLE_TOOLS` 摘掉的）
 *   ② `packages/agent-runtime` 的 `PROMPT_TOOL_GROUPS["Local WeChat"]`
 *   ③ `bridge-wechat-tools.ts` 注册时用的名字（**动态**来自侧车，不静态可查）
 *
 * ③ 天然跟着 ① 走（名字是 initialize 时拉回来的），所以真正会漂移的是 ②：
 * 有人在 app.py 里加/改了个工具，提示词那份没跟上——结果新工具落进 `Other Tools`，
 * minimal 档下模型只看到一个数字（连名字都没有）。这条测试就是那个信号。
 *
 * 反方向也守：② 里留着一个 ① 已删掉的名字，模型会被提示去调一个不存在的工具。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PROMPT_TOOL_GROUPS } from '@mtbot/agent-runtime'

const HERE = dirname(fileURLToPath(import.meta.url))
const WECHAT_DIR = join(HERE, '..', '..', '..', 'assets', 'wechat')

/**
 * 从 `app.py` 抽出工具名。
 *
 * `TOOLS` 里每条工具写成 `{"name": "xxx",` 起头（花括号与 `"name"` 同行），
 * 而函数体里的返回字典是 `{"ok": ..., "name": _display_name(...)}` —— 值**不是字符串**，
 * 所以要求 `"name": "` 后紧跟字符串字面量即可把它们排除；`DISPATCH` 的键是
 * `"list_sessions": tool_sessions`（有引号但后面是函数名，不是字符串字面量），同样排除。
 */
function toolNamesFromAppPy(): string[] {
  const src = readFileSync(join(WECHAT_DIR, 'app.py'), 'utf8')
  const names = new Set<string>()
  for (const m of src.matchAll(/"name":\s*"([a-z][a-z0-9_]*)"\s*,/g)) names.add(m[1]!)
  return [...names].sort()
}

/** `sidecar.py` 里显式摘掉的工具（依赖没随包发，见那边的注释） */
function unavailableTools(): string[] {
  const src = readFileSync(join(WECHAT_DIR, 'sidecar.py'), 'utf8')
  const m = /_UNAVAILABLE_TOOLS\s*=\s*\{([^}]*)\}/.exec(src)
  if (!m) return []
  return [...m[1]!.matchAll(/"([a-z][a-z0-9_]*)"/g)].map((x) => x[1]!).sort()
}

const APP_TOOLS = toolNamesFromAppPy()
const UNAVAILABLE = new Set(unavailableTools())
/** 侧车真正交出去的工具 = app.py 的清单 − 摘掉的那些 */
const SIDECAR_TOOLS = APP_TOOLS.filter((n) => !UNAVAILABLE.has(n)).sort()
/** 提示词侧登记的那份 */
const PROMPT_TOOLS = [...(PROMPT_TOOL_GROUPS['Local WeChat'] ?? [])].sort()

describe('本机微信工具清单对账（app.py ↔ 提示词分组）', () => {
  // 元断言：防止正则因 app.py 结构变化而空转，让下面那条永远"通过"
  it('app.py 抽得出工具名，且量级合理', () => {
    expect(APP_TOOLS.length).toBeGreaterThan(20)
    expect(APP_TOOLS).toContain('list_sessions')
    expect(APP_TOOLS).toContain('send_text')
    expect(APP_TOOLS).toContain('list_accounts')
    // 语音转写在 TOOLS 里，但侧车摘掉了——两条清单必须对得上这个差
    expect(APP_TOOLS).toContain('transcribe_voice')
    expect(UNAVAILABLE.has('transcribe_voice')).toBe(true)
    expect(SIDECAR_TOOLS).not.toContain('transcribe_voice')
  })

  it('提示词分组与侧车实际交出的工具**完全一致**', () => {
    const missing = SIDECAR_TOOLS.filter((n) => !PROMPT_TOOLS.includes(n))
    const ghosts = PROMPT_TOOLS.filter((n) => !SIDECAR_TOOLS.includes(n))
    expect(
      missing,
      `这些工具侧车会交给模型，但提示词分组里没有（会落进 Other Tools）：${missing.join(', ')}\n` +
        `改 packages/agent-runtime/src/prompt/sections/tooling-section.ts 的 LOCAL_WECHAT_TOOLS，` +
        `以及同目录 __tests__/tooling-section.test.ts 的 CLIENT_REGISTERED_NAMES。`,
    ).toEqual([])
    expect(
      ghosts,
      `提示词分组里这些名字侧车已不再提供（模型会被指引去调不存在的工具）：${ghosts.join(', ')}`,
    ).toEqual([])
  })
})
