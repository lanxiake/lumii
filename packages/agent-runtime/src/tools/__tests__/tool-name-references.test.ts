/**
 * 工具名引用守卫
 *
 * 目的：锁死「工具描述文本 / 运行时错误文案里引用的工具名，必须真实存在」。
 *
 * 为什么需要它：2026-09-18 的工具面复盘发现三处失效引用活到了生产——
 * `web-fetch-tool.ts` 让人用不存在的 `read_file`、`skill-tools.ts` 的 hint 指向
 * 已并入 `skill_search` 的 `skill_list`、`file-edit-tool.ts` 的描述与错误文案把参数名
 * 写成 `old_string`（schema 里是 `oldString`）。
 *
 * 它们逃过既有守卫的原因很具体：`tooling-section.test.ts` 比的是**键集合**
 * （注册表 ↔ 分组 ↔ TOOL_SUMMARIES），而 schema 描述与 content 文案对它不可见。
 * 同类守卫补上这一面。
 *
 * 三处引用里危害最大的是**错误文案**——它在 `content` 里，minimal 档（生产主力）
 * 下 schema 描述会被 `tool-definition-style.ts` 裁掉，错误文案却是全档位可见的。
 * 参数名被写错时，模型会照着错的试第二次。
 *
 * 设计取舍：**黑名单为主，反引号扫描为辅**。
 * 曾试过"裸 snake_case 词全量比对"，误报 32/32（`line_trimmed` 是匹配策略名、
 * `batch_create` 是 action 值、`*_binary` 是文件类型分类）——那种守卫只会被加满豁免项
 * 然后被删掉。黑名单零误报且直指已发生的病；反引号扫描补上"新引用"的一半。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ALL_BUILT_IN_TOOL_CONFIGS } from '../built-in/index.js'

const BUILT_IN_DIR = join(__dirname, '..', 'built-in')

/**
 * 剥离注释后再检查。
 *
 * 注释是写给**人**看的，里面提旧名字恰恰是有价值的历史记录
 * （如 `// 原来有个独立的 skill_list，已并入 skill_search`）——模型看不到注释，没有危害。
 * 只剥离块注释与整行行注释：行尾注释（`code // note`）保留，因为它贴着代码，
 * 更可能是描述代码行为而非历史备注。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** 内置目录下所有工具源码（排除测试，剥注释） */
function toolSources(): ReadonlyArray<readonly [string, string]> {
  return readdirSync(BUILT_IN_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => [f, stripComments(readFileSync(join(BUILT_IN_DIR, f), 'utf8'))] as const)
}

const REGISTERED = new Set<string>(ALL_BUILT_IN_TOOL_CONFIGS.map((c) => c.name))

/**
 * 曾经真实出现过的失效工具名。**只增不减**——每一条都对应一次生产事故或一次复盘发现。
 * 加新条目时请在提交信息里写清它是怎么进来的。
 */
const BANNED_TOOL_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['read_file', 'web-fetch-tool.ts:30 让人用它读本地文件（真名 file_read），2026-09-18 修'],
  ['skill_list', 'skill-tools.ts:165 的 hint（已并入 skill_search），2026-09-18 修'],
  ['write_file', 'gateway 时代的旧名（真名 file_write）'],
  ['edit_file', 'gateway 时代的旧名（真名 file_edit）'],
  ['file_manage', '不存在的工具；日志里出现过 `Tool file_manage not found` × 2'],
  ['global_search', '不存在的工具；日志里出现过 `Tool global_search not found` × 1'],
]

/**
 * schema 参数名，不是工具名。写错参数名的危害与写错工具名同级
 * （`file-edit-tool.ts` 的失败文案一度写 `old_string`，而 schema 是 `oldString`）。
 */
const BANNED_PARAM_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['old_string', 'file-edit-tool.ts 的描述与两处错误文案，2026-09-18 修'],
  ['new_string', '同上'],
]

/**
 * 反引号里合法但**不是工具名**的词。
 *
 * 判定标准：它是 shell 命令、字段名、action 值、或匹配策略名，且**不会被模型当成工具名**。
 * 往这里加词之前先问：模型读到 `` `xxx` `` 会不会去调一个叫 xxx 的工具？
 */
const ALLOWED_NON_TOOL_BACKTICKS = new Set([
  // shell 命令（bash 描述里明确说"用 X 命令"，指 shell 而非工具）
  // 注意：`grep` 不在此列——它既是 shell 命令**也是**注册工具名，本就该放行
  'find',
  'mkdir',
  'sed',
  'awk',
  'cat',
  'cp',
  'mv',
  'ls',
  // ask_user_question 的返回字段
  'annotations',
  'answers',
  'declined',
  // 时间/查询参数
  'days',
  'since',
  // 表名与参数名
  'maintenance_reports',
  'prompt',
  // memory_search 的参数名与返回字段：合并 memory_read 后，描述里用反引号点出
  // 「传 query 检索 / 传 drawerId 直读」两条路，以及结果里的来源标记
  'query',
  'provider',
  // 库名
  'lumii-ui',
])

describe('工具名引用守卫', () => {
  it('工具文本里不出现已知的失效工具名', () => {
    const hits: string[] = []
    for (const [file, src] of toolSources()) {
      for (const [banned, why] of BANNED_TOOL_NAMES) {
        if (new RegExp(`\\b${banned}\\b`).test(src)) hits.push(`${file} 引用了 \`${banned}\`（${why}）`)
      }
    }
    expect(hits, hits.join('\n')).toEqual([])
  })

  it('工具文本里不出现写错的 schema 参数名', () => {
    const hits: string[] = []
    for (const [file, src] of toolSources()) {
      for (const [banned, why] of BANNED_PARAM_NAMES) {
        if (new RegExp(`\\b${banned}\\b`).test(src)) hits.push(`${file} 写成了 \`${banned}\`（${why}）`)
      }
    }
    expect(hits, hits.join('\n')).toEqual([])
  })

  it('反引号包裹的工具名都真实存在', () => {
    const unknown: string[] = []
    for (const [file, src] of toolSources()) {
      for (const m of src.matchAll(/`([a-z][a-z0-9_]{3,})`/g)) {
        const word = m[1]!
        if (REGISTERED.has(word) || ALLOWED_NON_TOOL_BACKTICKS.has(word)) continue
        // 16 位纯 hex：drawer_id / 内容哈希的示例值（如 memory_read 参数说明里的样例）。
        // 按模式豁免而不是逐个登记——示例值会变，但"纯 hex 不可能是工具名"恒成立。
        if (/^[0-9a-f]{16}$/.test(word)) continue
        // 排除已经报过的失效名（上一条用例负责，避免重复噪声）
        if ([...BANNED_TOOL_NAMES, ...BANNED_PARAM_NAMES].some(([b]) => b === word)) continue
        unknown.push(`${file}: \`${word}\``)
      }
    }
    expect(
      unknown,
      `以下反引号标识符既不是注册工具名、也不在豁免表里：\n${unknown.join('\n')}\n` +
        `若它是合法引用（shell 命令 / 字段名 / 库名），加进 ALLOWED_NON_TOOL_BACKTICKS 并写明理由；\n` +
        `若是工具名，检查是否拼错或该工具已下线。`,
    ).toEqual([])
  })

  it('豁免表里不含已注册的真实工具名（防止豁免表变成藏污纳垢处）', () => {
    const wrong = [...ALLOWED_NON_TOOL_BACKTICKS].filter((w) => REGISTERED.has(w))
    expect(wrong, `以下词已是真实工具名，不该留在豁免表里: ${wrong.join(', ')}`).toEqual([])
  })

  it('守卫自身有效：把失效名塞进文本能被抓到', () => {
    // 元测试——防止守卫因正则写错而永远通过
    const probe = 'Do NOT use file:// URLs — use the read_file tool instead.'
    expect(BANNED_TOOL_NAMES.some(([b]) => new RegExp(`\\b${b}\\b`).test(probe))).toBe(true)
  })
})

describe('运行时错误文案的参数名', () => {
  it('file_edit 的失败文案用 schema 里的参数名（oldString）', async () => {
    const { fileEditToolConfig } = await import('../built-in/file-edit-tool.js')
    const ctx = {
      getCwd: () => process.cwd(),
      getAllowedRoots: () => undefined,
      readFile: async () => 'const a = 1\n',
      writeFile: async () => {},
    } as never

    const notFound = await fileEditToolConfig.execute(
      'tc',
      { filePath: 'probe.md', oldString: '不存在的字符串', newString: 'x' },
      ctx,
    )
    const text = (notFound.content[0] as { text: string }).text
    expect(text).toContain('`oldString`')
    expect(text).not.toContain('old_string')
  })

  it('skill_invoke 找不到技能时指向 skill_search 而非已下线的 skill_list', async () => {
    const { skillInvokeToolConfig } = await import('../built-in/skill-tools.js')
    const ctx = { getSkills: () => [], readFile: async () => '', glob: async () => [] } as never

    const res = await skillInvokeToolConfig.execute('tc', { skillName: 'nope' }, ctx)
    const text = (res.content[0] as { text: string }).text
    expect(text).toContain('skill_search')
    expect(text).not.toContain('skill_list')
  })

  it('web_fetch 的 url 描述指向 file_read（而不是不存在的 read_file）', async () => {
    const { webFetchToolConfig } = await import('../built-in/web-fetch-tool.js')
    const desc = (
      webFetchToolConfig.parameters as { properties: { url: { description: string } } }
    ).properties.url.description
    expect(desc).toContain('file_read')
    expect(desc).not.toMatch(/\bread_file\b/)
  })
})
