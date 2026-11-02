/**
 * `capability_export`：把一个能力固化成**可读目录 + JSON 片段**。
 *
 * 与 `SkillExporter`（.ocskill 二进制包）语义不同：那个是分发物，这个是
 * 「拷到别的机器就能看、能读、能手工接上」的目录。两者并存，不合并。
 *
 * **不注册、不写 extensions**：插件与主进程同权限，自动注册等于自动生成
 * 任意代码执行（设计 §6）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Type } from '@sinclair/typebox'
import {
  createMtBotTool,
  type MtBotToolConfig,
  type ToolExecutionContext,
} from '@mtbot/agent-runtime'
import { jsonToolResult } from './bridge-utils'
import { resolveSharedConfigDir } from '../paths'

export type CapabilitySource =
  | { readonly kind: 'skill'; readonly id: string }
  | { readonly kind: 'mcp'; readonly id: string }

export interface ExportCapabilityOptions {
  /** 工作区根：写入与归属校验都以它为准 */
  readonly workspaceDir: string
  /** MCP 配置目录（`~/.lumii/config`） */
  readonly configDir: string
  /** 导出目录名 */
  readonly name: string
  readonly source: CapabilitySource
  /** 工作区相对路径；缺省 `exports/<name>` */
  readonly dest?: string
}

export type ExportCapabilityResult =
  | { readonly ok: true; readonly dir: string; readonly files: readonly string[] }
  | { readonly ok: false; readonly error: string }

/** 目录名只挡路径分隔与上跳；中文名合法（技能目录本来就有中文分类） */
function isSafeSegment(name: string): boolean {
  return !!name && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * 递归复制目录。
 *
 * **不能用 `fs.cpSync`**：Electron 36.9.5（Node 22.19）里源路径含中文时它会在内部
 * 抛 `length_error`（`-fno-exceptions` 下直接 abort 主进程，且没有任何 JS 栈可捕）。
 * 2026-11-02 真机验收时连崩 4 次才定位到——单测跑在系统 Node 上，永远看不见。
 * 与 `bundled-skills-seeder.copyDirSync` 同一形态。
 */
function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDirSync(from, to)
    else fs.copyFileSync(from, to)
  }
}

/** 技能 id → 目录：`skills/<id>/SKILL.md`，id 可含 `/` 表示分类 */
function resolveSkillDir(workspaceDir: string, id: string): string | null {
  const segments = id.replace(/\\/g, '/').split('/').filter(Boolean)
  if (segments.length === 0 || segments.some((s) => !isSafeSegment(s))) return null
  const dir = path.join(workspaceDir, 'skills', ...segments)
  return fs.existsSync(path.join(dir, 'SKILL.md')) ? dir : null
}

/** 标准 `mcpServers` 对象或旧 `servers` 数组，都认 */
function resolveMcpEntry(
  configDir: string,
  id: string,
): { ok: true; entry: Record<string, unknown> } | { ok: false; error: string } {
  const configPath = path.join(configDir, 'mcp-servers.json')
  if (!fs.existsSync(configPath)) {
    return { ok: false, error: `找不到 MCP 配置：${configPath}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (err) {
    return {
      ok: false,
      error: `MCP 配置不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
    }
  }
  const root = (parsed ?? {}) as Record<string, unknown>
  const servers = root.mcpServers
  const list = Array.isArray(root.servers) ? root.servers : []
  const found =
    (servers && typeof servers === 'object' ? (servers as Record<string, unknown>)[id] : undefined) ??
    list.find((s) => (s as { name?: unknown })?.name === id)

  if (!found || typeof found !== 'object') {
    const available = [
      ...Object.keys(servers && typeof servers === 'object' ? servers : {}),
      ...list.map((s) => (s as { name?: unknown }).name).filter((n): n is string => typeof n === 'string'),
    ]
    return {
      ok: false,
      error: `找不到 MCP server "${id}"。可用：${available.join(', ') || '（无）'}`,
    }
  }
  // 深拷贝：导出物不能与运行时配置共享引用
  return { ok: true, entry: JSON.parse(JSON.stringify(found)) as Record<string, unknown> }
}

function skillReadme(name: string, id: string): string {
  return [
    `# ${name}`,
    '',
    `来源：技能 \`${id}\``,
    '',
    '## 用法',
    '',
    '把**整个目录**拷到目标工作区的 `skills/` 下，重启客户端后会被扫描并注册。',
    '本目录的 `SKILL.md` 与 `references/` 原样来自源工作区。',
    '',
    '## 依赖',
    '',
    '见 `SKILL.md`。技能里提到的工具必须在目标客户端真实存在，本导出不会安装任何东西。',
    '',
  ].join('\n')
}

function mcpReadme(name: string, id: string): string {
  return [
    `# ${name}`,
    '',
    '> ⚠️ 该片段可能包含凭据（`env` 里的密钥/令牌），分享前先脱敏。',
    '',
    `来源：MCP Server \`${id}\``,
    '',
    '## 用法',
    '',
    '把 `mcp-servers.snippet.json` 里的 `mcpServers` 条目合并到',
    '`~/.lumii/config/mcp-servers.json` 中同名字段下，然后在客户端「设置 › MCP 服务」里确认已连接。',
    '',
    '本导出只拷贝这一条配置，不安装 server 本身。',
    '',
  ].join('\n')
}

export function exportCapability(opts: ExportCapabilityOptions): ExportCapabilityResult {
  if (!isSafeSegment(opts.name)) {
    return { ok: false, error: 'name 不能为空、不能包含路径分隔符、也不能是 . 或 ..' }
  }

  const dest = opts.dest
    ? path.resolve(opts.workspaceDir, opts.dest)
    : path.join(opts.workspaceDir, 'exports', opts.name)
  if (!isInside(opts.workspaceDir, dest)) {
    return { ok: false, error: `dest 必须在工作区内：${opts.workspaceDir}` }
  }
  if (fs.existsSync(dest)) {
    return {
      ok: false,
      error: `目标已存在，拒绝覆盖：${dest}\n换一个 name，或用 dest 指定新目录。`,
    }
  }

  const files: string[] = []
  try {
    if (opts.source.kind === 'skill') {
      const skillDir = resolveSkillDir(opts.workspaceDir, opts.source.id)
      if (!skillDir) {
        return {
          ok: false,
          error: `找不到技能 "${opts.source.id}"（需要 skills/${opts.source.id}/SKILL.md）`,
        }
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      copyDirSync(skillDir, dest)
      files.push(...listFiles(dest))
      fs.writeFileSync(path.join(dest, 'README.md'), skillReadme(opts.name, opts.source.id), 'utf8')
      files.push('README.md')
    } else {
      const entry = resolveMcpEntry(opts.configDir, opts.source.id)
      if (!entry.ok) return entry
      fs.mkdirSync(dest, { recursive: true })
      const snippet = JSON.stringify({ mcpServers: { [opts.source.id]: entry.entry } }, null, 2)
      fs.writeFileSync(path.join(dest, 'mcp-servers.snippet.json'), `${snippet}\n`, 'utf8')
      fs.writeFileSync(path.join(dest, 'README.md'), mcpReadme(opts.name, opts.source.id), 'utf8')
      files.push('mcp-servers.snippet.json', 'README.md')
    }
  } catch (err) {
    // 失败不留半个目录：下次同名导出不该被自己的残骸挡住
    fs.rmSync(dest, { recursive: true, force: true })
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  return { ok: true, dir: dest, files }
}

/** 递归列出文件（相对路径，正斜杠） */
function listFiles(dir: string, base = ''): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out
}

const CapabilityExportInput = Type.Object({
  name: Type.String({ description: '导出目录名（不能含路径分隔符）' }),
  source: Type.Union([
    Type.Object({
      kind: Type.Literal('skill'),
      id: Type.String({ description: '技能 id，如 逆向与复刻/reverse' }),
    }),
    Type.Object({
      kind: Type.Literal('mcp'),
      id: Type.String({ description: 'mcp-servers.json 里的 server 名' }),
    }),
  ]),
  dest: Type.Optional(
    Type.String({ description: '工作区相对目录；缺省 exports/<name>' }),
  ),
})

export function createCapabilityExportToolConfig(deps: {
  getWorkspaceDir: () => string
  getConfigDir?: () => string
}): MtBotToolConfig {
  return {
    name: 'capability_export',
    label: 'Export Capability',
    description:
      '把一个技能或一条 MCP server 配置导出成**可读目录**（工作区 exports/<name>/），' +
      '拷到别的机器就能用。技能 → 整个技能目录 + README；MCP → mcp-servers.snippet.json + README。\n' +
      '不安装、不注册、不写 ~/.lumii/extensions——自动注册等价于自动执行任意代码。' +
      '目标已存在时拒绝覆盖（换 name 或用 dest）。',
    parameters: CapabilityExportInput,
    category: 'filesystem' as const,
    isReadOnly: false,
    needsPermission: true,
    execute: async (_id: string, rawParams: unknown) => {
      try {
        const p = (rawParams ?? {}) as {
          name?: unknown
          source?: CapabilitySource
          dest?: unknown
        }
        const result = exportCapability({
          workspaceDir: deps.getWorkspaceDir(),
          configDir: deps.getConfigDir?.() ?? resolveSharedConfigDir(),
          name: typeof p.name === 'string' ? p.name.trim() : '',
          source: p.source as CapabilitySource,
          ...(typeof p.dest === 'string' && p.dest.trim() ? { dest: p.dest.trim() } : {}),
        })
        return jsonToolResult(result)
      } catch (err) {
        return jsonToolResult({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }
}

/** 注册入口：与其它 `register*Tools` 同形 */
export function registerCapabilityExportTools(
  toolRegistry: { register: (tool: ReturnType<typeof createMtBotTool>) => void },
  ctx: ToolExecutionContext,
  deps: { getWorkspaceDir: () => string },
): string[] {
  // 与 bridge.ts 同一个泛型擦除：带具体 schema 的配置无法赋给 MtBotTool<TSchema>（参数逆变）
  const config: MtBotToolConfig = createCapabilityExportToolConfig(deps)
  toolRegistry.register(createMtBotTool(config, ctx))
  return [config.name]
}
