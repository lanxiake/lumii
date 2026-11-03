/**
 * 内置流水线 spec 的加载期守卫 + 离线 harness。
 *
 * 原来的 `KNOWN_TOOLS` 是**手写白名单**：工具名写错、工具其实没注册，只要白名单里有就过。
 * 2026-11-02 真机踩到两次（`reverse_probe` 断言 `ok` 字段、种子 precondition 缺必填参数），
 * 都是"能编译、能跑、测试绿"却不对的形态。所以这里改成**真的把工具注册进来**：
 *
 * 1. 用真实的注册函数建一个 `ToolRegistry`，拿 `getAll()` 当已知工具表；
 * 2. 用工具自己的 `parameters`（TypeBox schema）检查 spec 的必填项有没有给；
 * 3. 空跑整条 spec（fake deps），确认每一步的参数引用都能解析。
 *
 * 覆盖不到的东西也写在注释里：`expect.fields` 断言的那个字段是不是工具真的会返回，
 * 静态看不出来——那只能靠真机 journal。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { ToolRegistry, ALL_BUILT_IN_TOOL_CONFIGS } from '@mtbot/agent-runtime'
import { registerAppUiTools } from '@main/agent-runtime/bridge-app-ui-tools'
import { registerBrowserTools } from '@main/agent-runtime/bridge-browser-tools'
import { registerScreenRecordTools } from '@main/agent-runtime/bridge-screen-record-tools'
import { createReverseProbeToolConfig } from './../reverse/tools'
import { validateSpec } from './spec'
import { runPipeline } from './runner'
import type { RunnerDeps } from './types'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLED = join(HERE, '..', '..', '..', '..', 'bundled-pipelines')

/** 纯 TypeBox schema 的静态读取（不引 ajv：只查 required 与类型，够用且零依赖） */
interface JsonSchema {
  type?: string
  required?: string[]
  properties?: Record<string, JsonSchema>
  additionalProperties?: JsonSchema | boolean
}

/**
 * 建一份「本机真实会注册的工具」表。
 *
 * 只注册不需要 Electron 窗口实体的那些——注册函数本身是同步的，deps 里的 getter
 * 在注册阶段不会被调用（真调用会抛，正好当作"这条 spec 不能静态验"的信号）。
 * MCP 工具（`mcp__*`）与 wechat 侧车工具不进这里：它们由 MCP 连接后动态注册，
 * 静态环境看不到，涉及它们的 spec 会在下面的用例里显式跳过。
 */
function buildRealRegistry(): { registry: ToolRegistry } {
  const registry = new ToolRegistry()
  const noopCtx = {} as never
  const noopResize = async (b: Buffer) => ({
    buffer: b,
    mimeType: 'image/png',
    wasResized: false,
    originalBytes: b.length,
    finalBytes: b.length,
  })

  // 内置工具（bash / list_dir / file_write / web_fetch …）是第三块，漏掉它会误报
  // 「unknown tool: list_dir」——第一版就是这么错的，正是要防的「白名单不全」
  for (const c of ALL_BUILT_IN_TOOL_CONFIGS) {
    const cfg = c as unknown as { name: string } & Record<string, unknown>
    registry.register(
      { ...cfg, execute: async () => ({ content: [], details: undefined }) } as never,
    )
  }

  registerAppUiTools(registry as never, noopCtx, { getWindow: () => null, resizeImageIfNeeded: noopResize })
  registerBrowserTools(registry as never, noopCtx, () => null)
  registerScreenRecordTools(registry as never, noopCtx, { getService: () => null })
  registry.register(
    createReverseProbeToolConfig({
      service: {} as never,
      spawnProbe: (async () => ({ code: 1, stdout: '', stderr: 'stub' })) as never,
    }) as never,
  )
  return { registry }
}

const { registry } = buildRealRegistry()
const KNOWN_TOOLS: ReadonlySet<string> = new Set(registry.getAll().map((t) => t.name))

/**
 * 内置 spec 引用的 Agent；取 bridge 侧 knownAgents 的同名集合。
 *
 * `security`（灵栖安全）在 `BUILTIN_AGENT_DEFINITIONS` 里是 `isActive: true`，
 * 所以它**在** `knownAgents` 里、spec 引用它不会被加载期拒。
 */
const KNOWN_AGENTS = new Set([
  'assistant',
  'builtin:explore',
  'builtin:plan',
  'builtin:verify',
  'code-dev',
  'security',
])

/** 依赖 MCP 连接后才存在、静态环境拿不到的工具前缀 */
const DYNAMIC_TOOL_PREFIXES = ['mcp__', 'read_history', 'send_text', 'send_file', 'reply_to', 'poll_new', 'list_sessions', 'check_env', 'locate_db', 'repair_env', 'search_messages', 'export_chat', 'list_unread', 'wechat_', 'kb_', 'autoreply_', 'tag_', 'list_accounts', 'dashboard_feed_']

function isDynamicTool(name: string): boolean {
  return DYNAMIC_TOOL_PREFIXES.some((p) => name.startsWith(p))
}

let dirs: string[] = []
try {
  dirs = readdirSync(BUNDLED, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
} catch {
  /* 打包产物里没有 source 目录：跳过（另有真机播种覆盖） */
}

/** 读一份内置 spec 的原始 JSON；坏 JSON 在这里就炸，比跑起来再炸早 */
function rawOf(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(BUNDLED, id, 'spec.json'), 'utf8')) as Record<string, unknown>
}

/** 所有 tool 步骤 + preconditions + postCleanup 的 `{id, tool, params}` */
function toolStepsOf(raw: Record<string, unknown>): { id: string; tool: string; params: Record<string, unknown> }[] {
  const out: { id: string; tool: string; params: Record<string, unknown> }[] = []
  const push = (v: unknown, where: string) => {
    if (!v || typeof v !== 'object') return
    const o = v as Record<string, unknown>
    if (typeof o.tool !== 'string') return
    out.push({ id: String(o.id ?? where), tool: o.tool, params: (o.params as Record<string, unknown>) ?? {} })
  }
  for (const p of (raw.preconditions as unknown[]) ?? []) push(p, 'precondition')
  for (const s of (raw.steps as unknown[]) ?? []) push(s, 'step')
  for (const c of (raw.postCleanup as unknown[]) ?? []) push(c, 'cleanup')
  return out
}

describe('bundled-pipelines 全部 spec', () => {
  it('目录可枚举（找不到源目录时说明本用例在打包环境里跑）', () => {
    expect(Array.isArray(dirs)).toBe(true)
  })

  it('真实工具表非空（否则下面所有用例都在空集上通过——假绿）', () => {
    // 这条是**元测试**：注册函数哪天改了签名或依赖了真实的 Electron 对象，
    // 这里会先红，而不是让「所有 spec 都通过校验」变成一个骗人的结论。
    expect(KNOWN_TOOLS.size).toBeGreaterThan(20)
    expect(KNOWN_TOOLS.has('app_goto')).toBe(true)
    expect(KNOWN_TOOLS.has('browser_navigate')).toBe(true)
    expect(KNOWN_TOOLS.has('screen_record_start')).toBe(true)
  })

  it.each(dirs)('%s 的工具名全部真实存在', (id) => {
    const raw = rawOf(id)
    const unknown = toolStepsOf(raw)
      .map((s) => s.tool)
      .filter((t) => !KNOWN_TOOLS.has(t) && !isDynamicTool(t))
    expect(unknown, `未知工具: ${[...new Set(unknown)].join(', ')}`).toEqual([])
  })

  it.each(dirs)('%s 能通过加载期校验', (id) => {
    const raw = rawOf(id)
    // 动态工具（MCP / 侧车）静态看不见，校验时补进已知集——它们由连接后注册，
    // 名字对不对由各自的真机用例负责，不该让整个文件在这里失败。
    const known = new Set([...KNOWN_TOOLS, ...toolStepsOf(raw).map((s) => s.tool).filter(isDynamicTool)])
    const v = validateSpec(raw, known, KNOWN_AGENTS)
    expect(v.ok ? undefined : v.errors).toBeUndefined()
  })

  /**
   * **必填参数有没有给**。
   *
   * 2026-10-31 真机：种子 precondition 写了 `list_dir` 却没给 `path`，
   * 那条 spec 永远跑不起来——而加载期校验只查工具名，完全看不见这件事。
   * 这里用工具自己的 TypeBox schema 的 `required` 对一遍。
   */
  it.each(dirs)('%s 的工具步骤给了参数 schema 要求的必填项', (id) => {
    const raw = rawOf(id)
    const problems: string[] = []
    for (const s of toolStepsOf(raw)) {
      if (isDynamicTool(s.tool)) continue
      const schema = registry.get(s.tool)?.parameters as JsonSchema | undefined
      for (const key of schema?.required ?? []) {
        if (!(key in s.params)) problems.push(`${s.id}(${s.tool}) 缺必填参数 ${key}`)
      }
    }
    expect(problems, problems.join('; ')).toEqual([])
  })

  /**
   * 空跑整条 spec：确认每一步的 `{{}}` 引用都能解析。
   *
   * 用假的 callTool（永远返回 ok），所以它验的是**spec 自身的一致性**：
   * 引用链断没断、变量有没有漏。参数的真假（比如 app_goto 的 view 名对不对）验不了。
   */
  it.each(dirs)('%s 能空跑完全程（引用链不断）', async (id) => {
    const raw = rawOf(id)
    const known = new Set([...KNOWN_TOOLS, ...toolStepsOf(raw).map((s) => s.tool).filter(isDynamicTool)])
    const v = validateSpec(raw, known, KNOWN_AGENTS)
    if (!v.ok) return expect.fail(`加载期校验未过: ${v.errors.join('; ')}`)

    // 每个变量都给一个占位值，验的是「给了就能跑通」，而不是「缺了会怎样」
    const inputs: Record<string, string> = {}
    for (const i of v.spec.inputs ?? []) inputs[i.name] = `__${i.name}__`

    const deps: RunnerDeps = {
      callTool: vi.fn(async () => ({ ok: true, data: { ok: true } })),
      runAgentStage: vi.fn(async () => ({ ok: true, data: { output: 'stub' } })),
      screenRecord: null, // 空跑不录
      readViewState: async () => ({ view: 'chat' }),
      now: () => 1000,
    }
    // 放系统临时目录：放源码目录会留下未跟踪文件，下一次接线守卫会把它当死代码候选
    const runDir = mkdtempSync(join(tmpdir(), 'lumii-harness-'))
    const res = await runPipeline({
      // 空跑**剥掉 preconditions 与 expect**：前者要真实的目录/视图，后者要工具真的返回
      // 那个字段——这两件事静态都判不了，留着只会让每一条 spec 都"失败"，把真正的
      // 引用链问题埋在假失败里。它们各自的守卫在上面的用例里（precondition 的参数必填、
      // 「不许对不返回 ok 的工具断言 ok」）。
      spec: {
        ...v.spec,
        preconditions: undefined,
        steps: v.spec.steps.map((s) => ({ ...s, expect: undefined })),
      },
      specHash: v.specHash,
      mode: 'rehearsal',
      runDir,
      deps,
      sleep: () => Promise.resolve(),
      // 全部放行：这里验的是引用链，不是 rehearsal 语义
      isRehearsalBlocked: () => false,
      inputs,
    })
    rmSync(runDir, { recursive: true, force: true })
    if (!res.ok) {
      expect.fail(`第 ${(res.failedAt?.i ?? -1) + 1} 步 (${res.failedAt?.id}) 失败: ${res.error}`)
    }
  })

  /**
   * 描述里不许出现占位符名。
   *
   * 2026-11-02 真机踩到：`exe-clone` 的描述写着「跑之前把 __TARGET__ 与 __SLUG__ 换成真实值」，
   * 用户替换之后这句话变成「跑之前把 C:/…/LiteShell.exe 与 liteshell-clone 换成真实值」——
   * Agent 读完以为自己还没填，回头去查 spec、查目录、查进程，绕了半小时。
   *
   * 占位符名是对**作者**说的，不是对**运行时的读者**说的。替换之后仍然要读得通。
   */
  it.each(dirs)('%s 的描述里不含占位符名（替换后读起来自相矛盾）', (id) => {
    const raw = rawOf(id)
    const desc: string = typeof raw.description === 'string' ? raw.description : ''
    const found = desc.match(/__[A-Z][A-Z0-9_]*__/g) ?? []
    expect(found, `description 里出现占位符 ${found.join(', ')}——改成「先填 inputs.json」这种不点名的说法`).toEqual([])
  })

  /**
   * `reverse_probe` 返回纯 `KEY=value` 文本，没有 `ok` 字段。
   *
   * 2026-11-02 真机踩到：`exe-clone` 的 unpack 步写了 `expect.fields.ok === true`，
   * 于是**解包完全成功（EXTRACT_VERIFIED=11/11）却被判 ok:false**，报错里 observed
   * 是一大段正常输出，看着非常像「输出有问题」。
   */
  it.each(dirs)('%s 不对不返回 ok 的工具断言 expect.fields.ok', (id) => {
    const raw = rawOf(id)
    const offenders: string[] = []
    for (const s of (raw.steps as { id?: string; tool?: string; expect?: { fields?: Record<string, unknown> } }[]) ?? []) {
      if (!TOOLS_WITHOUT_OK_FIELD.has(s.tool ?? '')) continue
      if (s.expect?.fields && 'ok' in s.expect.fields) offenders.push(`${s.id} (${s.tool}) 断言了 ok`)
    }
    expect(offenders, offenders.join('; ')).toEqual([])
  })

  /** 引用的运行时变量必须能从 spec 里推出来（写错名字不会有任何报错，只会在运行时炸） */
  it.each(dirs)('%s 的 {{input.x}} 名字前后一致', (id) => {
    const raw = rawOf(id)
    const text = JSON.stringify(raw).replace(/\{\{\s*input\.[A-Za-z0-9_-]+\s*\}\}/g, '')
    // 去掉所有合法的变量引用后，不该再有 input. 的痕迹（说明有写歪的，比如 {{input . x}}）
    expect(text.includes('input.')).toBe(false)
  })

  /**
   * **`cmd | tail` 不能用来判成败**。
   *
   * 管道里 `$?` 是最后一个命令（`tail`）的退出码——`git clone` 失败照样返回 0。
   * 2026-11-03 真机两处踩到：clone 步的失败被 `| tail -3` 吞掉（靠 `set -e` 才没继续），
   * deps/build/test 三步的 `| tail` 会把构建失败报成成功，而"测试通过率"正是
   * `open-source-eval` 的核心产出——一条假数据比没有更糟。
   *
   * 正确写法：先重定向到日志文件判退出码，再 `tail` 那个文件。
   */
  it.each(dirs)('%s 的 bash 步不用管道尾巴判成败', (id) => {
    const raw = rawOf(id)
    const bad: string[] = []
    for (const s of toolStepsOf(raw)) {
      if (s.tool !== 'bash') continue
      const cmd = typeof s.params.command === 'string' ? s.params.command : ''
      // `... | tail` 且前面不是从日志文件读（`tail "$LOG"` 是合法的）
      if (/\|\s*tail\s+-?\d*\s*$|\|\s*tail\s+-?\d+\s*;/m.test(cmd)) bad.push(`${s.id}: 命令以 | tail 结尾`)
    }
    expect(bad, `${bad.join('; ')}——管道会让 $? 变成 tail 的退出码，改写成先重定向到日志再 tail`).toEqual([])
  })

  /** 循环里的 `[ ] && echo` 在最后一项不存在时会让整个 for 返回非零（`&&` 链因此断掉） */
  it.each(dirs)('%s 的 bash 步不用 `[ ] && echo` 作循环体', (id) => {
    const raw = rawOf(id)
    const bad: string[] = []
    for (const s of toolStepsOf(raw)) {
      if (s.tool !== 'bash') continue
      const cmd = typeof s.params.command === 'string' ? s.params.command : ''
      if (/for\s+\w+\s+in[^;]*;\s*do\s*\[[^\]]*\][^;]*&&\s*echo/.test(cmd)) bad.push(s.id)
    }
    expect(bad, `${bad.join(', ')}——最后一项不成立时 for 返回 1，后面 && 接的整串都不执行。改成 do if ...; then echo; fi; done`).toEqual([])
  })
})

const TOOLS_WITHOUT_OK_FIELD = new Set(['reverse_probe'])
