/**
 * 宠物 Agent 定义的守卫测试。
 *
 * 这个文件守的不是"今天字段对不对"，而是**两条会被好心改坏的决定**：
 * 1. 宠物的工具面**只能收窄不能悄悄放宽**——放宽一条就是一次越权，而且不报错；
 * 2. 宠物定义**不许被搬进 `BUILTIN_AGENT_DEFINITIONS`**——那条路会牵出 api-server 漂移
 *    与动态 id 表达不了的问题（理由写在 `pet-definition.ts` 文件头）。
 */
import { describe, expect, it } from 'vitest'
import {
  PET_ABSENT_CAPABILITIES,
  PET_AGENT_NAME,
  PET_MAX_TURNS,
  PET_PROMPT,
  PET_TOOL_ALLOWLIST,
  buildPetDefinition,
  isPetDeniedTool,
} from '../pet-definition.js'
import { BUILTIN_AGENT_DEFINITIONS, findBuiltInAgent } from '../../agent/builtin/definitions.js'
import { getAutonomousToolsForAgent } from '../goal-executor.js'
import { BUILTIN_AGENT_DISPLAY_NAMES } from '../../agent/builtin/agent-display-names.js'
import { ALL_BUILT_IN_TOOL_CONFIGS } from '../../tools/built-in/index.js'
import { WRITE_TOOL_NAMES } from '../../security/permission-types.js'

describe('buildPetDefinition — id 口径', () => {
  it('id 原样透传 agentId，不是常量 "pet"', () => {
    // 这一条是**记忆归属**的正确性：createInstance 把 def.id 写进 metrics.definitionId，
    // 而性格/情绪落在 personality_state['pet:<模型ID>']。两者不一致 = 记忆静默写错归属。
    expect(buildPetDefinition('pet:demo_cartoon_cat').id).toBe('pet:demo_cartoon_cat')
    expect(buildPetDefinition('pet:mao_pro').id).toBe('pet:mao_pro')
  })

  it('两只宠物拿到的是两个不同的定义（不是共享单例）', () => {
    const a = buildPetDefinition('pet:demo_cartoon_cat')
    const b = buildPetDefinition('pet:mao_pro')
    expect(a).not.toBe(b)
    expect(a.name).toBe(b.name)
    expect(a.name).toBe(PET_AGENT_NAME)
  })
})

describe('工具面 — 只读是硬边界', () => {
  it('白名单里没有任何写工具', () => {
    const writes = PET_TOOL_ALLOWLIST.filter((t) => WRITE_TOOL_NAMES.has(t))
    expect(writes, `宠物白名单出现了写工具: ${writes.join(', ')}`).toEqual([])
  })

  it('白名单里没有任何高危工具（bash / spawn / 外发 / 排期 / 浏览器 / MCP）', () => {
    const forbidden = [
      'bash',
      'spawn_agent',
      'send_message',
      'channel_send',
      'channel_list',
      'message',
      'cron_create',
      'cron_delete',
      'skill_invoke',
      'memory_manage',
      'wiki_capture',
      'dashboard_feed_write',
      'maintenance_report_write',
    ]
    const hits = PET_TOOL_ALLOWLIST.filter((t) => forbidden.includes(t))
    expect(hits, `宠物白名单出现了越权工具: ${hits.join(', ')}`).toEqual([])

    // 前缀类（browser_* / app_* / mcp__*）单独判——它们是宿主侧注册的工具，
    // 不在内置注册表里，混进来时上面的精确名单抓不到。
    const prefixed = PET_TOOL_ALLOWLIST.filter((t) =>
      t.startsWith('browser_') || t.startsWith('app_') || t.startsWith('mcp__') || t.startsWith('cloud_sync'),
    )
    expect(prefixed, `宠物白名单出现了前缀类高危工具: ${prefixed.join(', ')}`).toEqual([])
  })

  it('白名单里每个名字都真的在内置工具注册表里（防拼错）', () => {
    const registered = new Set(ALL_BUILT_IN_TOOL_CONFIGS.map((c) => c.name))
    const missing = PET_TOOL_ALLOWLIST.filter((t) => !registered.has(t))
    expect(
      missing,
      `宠物白名单里的名字不在工具注册表里，模型会看到一个不存在的工具: ${missing.join(', ')}`,
    ).toEqual([])
  })

  it('白名单不是空的，也不是通配符', () => {
    expect(PET_TOOL_ALLOWLIST.length).toBeGreaterThan(0)
    expect(PET_TOOL_ALLOWLIST).not.toContain('*')
  })
})

/**
 * 五期 T5.3：提示词里点名了"你没有这几类能力"，那几句话必须与白名单一致。
 *
 * 守的是**提示词撒谎**这种失败：白名单哪天被顺手放宽，提示词却还写着"你不能写文件"，
 * 于是模型照着新工具干活、用户照着提示词理解它——**两边都以为对方是对的**。
 * 这类不一致只有用户会发现（表现为"它说它不会，转头就干了"）。
 */
describe('缺席能力表与提示词、白名单三方一致', () => {
  it('白名单里没有任何一条落在"缺席能力"里', () => {
    const leaked = PET_TOOL_ALLOWLIST.filter((t) => isPetDeniedTool(t))
    expect(
      leaked,
      `宠物白名单出现了提示词明说"没有"的工具: ${leaked.join(', ')}——` +
        `要么撤掉它，要么连同 PET_PROMPT 与 PET_ABSENT_CAPABILITIES 一起改`,
    ).toEqual([])
  })

  it('对照组：这张表真的拦得住东西（否则上一条是空转）', () => {
    // 没有这三行，"表是空的"也能让上一条通过——那种假阳性比不测更糟
    expect(isPetDeniedTool('file_write')).toBe(true)
    expect(isPetDeniedTool('bash')).toBe(true)
    expect(isPetDeniedTool('browser_navigate')).toBe(true)
    expect(isPetDeniedTool('mcp__github__create_issue')).toBe(true)
    expect(isPetDeniedTool('cron_create')).toBe(true)
  })

  it('前缀匹配不越界：app_ 不该连 apply_patch 一起吃掉', () => {
    expect(isPetDeniedTool('apply_patch')).toBe(false)
    expect(isPetDeniedTool('apple_notes')).toBe(false)
    // 对照：真的 app_ 工具仍然拦得住
    expect(isPetDeniedTool('app_launch')).toBe(true)
  })

  it('提示词为**每一类**都写了话 —— 数据加了、话说漏了就会红', () => {
    // 逐类按**全名**找（提示词里是用粗体逐条列的）。改名就要连提示词一起改，这是有意的：
    // 那一句话是给模型看的，改了名而话没跟上，就等于这一类没说
    const missing = Object.keys(PET_ABSENT_CAPABILITIES).filter(
      (label) => !PET_PROMPT.includes(label),
    )
    expect(missing, `提示词里没提这几类缺席能力: ${missing.join(', ')}`).toEqual([])
  })

  it('提示词确实在讲"你没有"，不是只有一句含糊的"你有边界"', () => {
    // 这一条钉的是**那段话的存在**：模型看不到"缺什么"，只看到"有什么"
    expect(PET_PROMPT).toContain('你没有这些东西')
  })
})

describe('结构约束', () => {
  const def = buildPetDefinition('pet:demo_cartoon_cat')

  it('readOnly + 不能生成子 Agent（白名单之外的第二道防线）', () => {
    expect(def.permissionMode).toBe('readOnly')
    expect(def.canSpawnSubAgents).toBe(false)
    expect(def.tools).toEqual([...PET_TOOL_ALLOWLIST])
    expect(def.maxTurns).toBe(PET_MAX_TURNS)
  })

  it('不进会话选择器', () => {
    expect(def.selectable).not.toBe(true)
  })

  it('memory.readView 不是 user —— 宠物不读别的 Agent 的工作记忆', () => {
    // 缺省即 'own'。第四期 T4.5「读沉淀让预判带具体内容」要放宽时，
    // 必须连同"读谁的、读到什么程度"一起设计，不能顺手把这里改成 'user'。
    expect(def.memory?.readView).not.toBe('user')
    expect(def.memory?.autoExtract).toBe(false)
  })
})

/**
 * 防"顺手接错路径"：宠物若被接到通用的自主工具选择器上，
 * 会拿到 getGoalToolAllowlist（含 file_write / cron_create / message），
 * 比宠物的白名单宽得多且**不报错**。这一条把那条路堵死。
 */
describe('通用路径上的宠物分支是收窄的', () => {
  it('getAutonomousToolsForAgent 对 pet:* 返回宠物白名单，而不是通用白名单', () => {
    const pet = getAutonomousToolsForAgent('pet:demo_cartoon_cat', 'learning')
    expect(pet).toEqual([...PET_TOOL_ALLOWLIST])
    // 对照组：同一个调用换个 agentId，拿到的确实是更宽的那份——
    // 否则这条测试会因为"两份恰好一样"而永远通过（假阳性）
    const generic = getAutonomousToolsForAgent('assistant', 'learning')
    expect(generic.length).toBeGreaterThan(pet.length)
    expect(generic).toContain('file_write')
    expect(pet).not.toContain('file_write')
  })
})

describe('不许被搬进内置定义表', () => {
  it('BUILTIN_AGENT_DEFINITIONS 里没有宠物', () => {
    // 理由见 pet-definition.ts 文件头三条（api-server 漂移 / 动态 id / 不该被委派）。
    // 若有人把宠物加进去，这条会红——那时请先回读文件头，而不是改这条测试。
    expect(findBuiltInAgent('pet')).toBeUndefined()
    const petIds = BUILTIN_AGENT_DEFINITIONS.filter((d) => d.id.startsWith('pet')).map((d) => d.id)
    expect(petIds, `内置定义表混进了宠物: ${petIds.join(', ')}`).toEqual([])
  })

  it('显示名表里没有宠物条目', () => {
    const petKeys = Object.keys(BUILTIN_AGENT_DISPLAY_NAMES).filter((k) => k.startsWith('pet'))
    expect(petKeys).toEqual([])
  })
})
