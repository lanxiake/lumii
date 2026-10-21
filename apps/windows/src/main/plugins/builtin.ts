/**
 * 内置插件注册表（主进程）
 *
 * 每接入一个插件就在这里 `registerPlugin({...})`。新增插件时同步在
 * `renderer/data/asset-plugins.ts` 的 `PLUGIN_REGISTRY` 里加一条
 * UI 元数据（id 必须一致）——渲染层据它出卡片，主进程据这里认 id。
 *
 * 需要触达外部系统（如 MCP 配置）的插件，通过 `PluginDeps` 注入回调——**不直接 import
 * `AgentRuntimeBridge`**（它是 index.ts 里创建的单例，插件层不该反向依赖它）。
 */
import { app } from 'electron'
import { join, dirname } from 'path'
import os from 'os'
import { existsSync, readdirSync, promises as fs } from 'fs'
import { registerPlugin } from './plugin-manager'
import { installNpmFile } from './npm-fetch'
import { installGithubAsset, installGithubZip } from './github-fetch'
import { getDeployedMcpExePath } from '../bundled-mcp-exe'
import { MCP_PRESETS } from '../../shared/mcp-presets'
import { presetToEntry, type McpServerEntry } from '../config/mcp-config'
import { resolvePluginRuntimeDir } from '../paths'
import { resolveUserPetModelsDir } from '../pet/pet-asset-protocol'
import { resolveExtensionsDir } from '../extension-loader'
import { setMainExtensionEnabled } from '../kernel/extension-store'
import {
  installOfficialExtension,
  isOfficialExtensionInstalled,
  loadOfficialCatalog,
  removeOfficialExtension,
  type OfficialCatalogEntry,
} from '../official-extensions'

/** CloakBrowser 的落点（历史上就在 homedir，不在客户端数据根，保持不变） */
const CLOAK_DIR = join(os.homedir(), '.cloakbrowser')

/** ffmpeg 落点（客户端数据根的插件运行时目录；解析链见 screen-record/ffmpeg-runner.ts） */
const FFMPEG_DIR = resolvePluginRuntimeDir('ffmpeg')
const FFMPEG_EXE = join(FFMPEG_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')

/**
 * wechat-mcp：落点**必须**与 MCP 链路写进 `mcp-servers.json` 的 command 完全一致
 * （`getDeployedMcpExePath`），否则装了插件 MCP 也连不上。
 */
const WECHAT_MCP_SERVER = 'wechat-local'
const WECHAT_MCP_EXE = getDeployedMcpExePath('wechat-mcp')
const WECHAT_MCP_DIR = dirname(WECHAT_MCP_EXE)
/** 资产托管在公开产品库 release，tag = `v<App 版本>`（随 App 一起发，见设计文档 §12-6） */
const WECHAT_MCP_REPO = 'lanxiake/lumii'
const WECHAT_MCP_ASSET = 'wechat-mcp.exe'
const RELEASE_TAG = (): string => `v${app.getVersion()}`

/** 移出随包的宠物（各自一个插件）：id 即用户宠物目录名，资产名 `pet-<id>.zip` */
const PET_PLUGIN_IDS = ['demo_cartoon_cat', 'ug_official', 'xiaomai'] as const

type PetRegistryEntry = { id: string; [k: string]: unknown }

/** 用户宠物注册表路径（与 pet-model-resolver 的「用户」那一段一致） */
function userPetRegistryPath(): string {
  return join(resolveUserPetModelsDir(), 'registry.json')
}

/** 把一只宠物的清单条目并入用户注册表（按 id 覆盖） */
async function upsertUserPetEntry(userDir: string, entry: PetRegistryEntry): Promise<void> {
  const p = join(userDir, 'registry.json')
  let reg: { version?: number; models?: PetRegistryEntry[]; defaultModelId?: string } = {}
  try {
    reg = JSON.parse(await fs.readFile(p, 'utf-8'))
  } catch {
    /* 首次安装：新建 */
  }
  const models = (reg.models ?? []).filter((m) => m.id !== entry.id)
  models.push(entry)
  await fs.mkdir(userDir, { recursive: true })
  await fs.writeFile(p, JSON.stringify({ ...reg, version: reg.version ?? 2, models }, null, 2))
}

/** 从用户注册表移除一只宠物（按 id） */
async function removeUserPetEntry(userDir: string, id: string): Promise<void> {
  const p = join(userDir, 'registry.json')
  try {
    const reg = JSON.parse(await fs.readFile(p, 'utf-8')) as { models?: PetRegistryEntry[] }
    const models = (reg.models ?? []).filter((m) => m.id !== id)
    await fs.writeFile(p, JSON.stringify({ ...reg, models }, null, 2))
  } catch {
    /* 无注册表可改，忽略 */
  }
}

/**
 * 注册一只「移出随包」的宠物插件。
 *
 * 安装 = 下载 `pet-<id>.zip`（含 `<id>/` 资源与 `entry.json` 清单）→ 落到用户宠物目录
 * `<数据根>/pet-models/<id>/` 并把条目并入 `<数据根>/pet-models/registry.json`。
 * 用户目录与内置目录同布局，故内置注册表里的条目可**原样复用**（modelUrl 前缀就是 `<id>/`）。
 */
function registerPetPlugin(id: string): void {
  const userDir = resolveUserPetModelsDir()
  const petDir = join(userDir, id)
  registerPlugin({
    id: `pet:${id}`,
    async status() {
      return existsSync(join(petDir, 'runtime')) ? { installed: true } : { installed: false }
    },
    async install(onProgress, signal) {
      const staging = join(userDir, `.staging-${id}`)
      await fs.rm(staging, { recursive: true, force: true })
      await installGithubZip({
        repo: WECHAT_MCP_REPO,
        tag: RELEASE_TAG(),
        asset: `pet-${id}.zip`,
        destDir: staging,
        onProgress,
        signal,
      })
      const entry = JSON.parse(await fs.readFile(join(staging, 'entry.json'), 'utf-8')) as PetRegistryEntry
      await fs.rm(petDir, { recursive: true, force: true })
      await fs.cp(join(staging, id), petDir, { recursive: true })
      await upsertUserPetEntry(userDir, entry)
      await fs.rm(staging, { recursive: true, force: true })
    },
    async uninstall() {
      await fs.rm(petDir, { recursive: true, force: true })
      await removeUserPetEntry(userDir, id)
    },
  })
}

/** 插件安装/卸载需要触达外部系统的钩子（由 index.ts 从 AgentRuntimeBridge 注入） */
export interface PluginDeps {
  /** 写入并启用一个 MCP server 条目（安装 wechat-mcp 插件时用，含热重连） */
  upsertMcpServer?: (entry: McpServerEntry) => Promise<void>
  /**
   * 启停一个 MCP server 条目（**卸载时只停用、不删除**）。
   *
   * 为什么不是删除：删条目会留下「文件已删但卡片还显示已安装」之类的半死状态，且把用户
   * 在面板里对它的任何调整一并抹掉。停用则非破坏、可逆，重装即恢复。
   */
  setMcpServerEnabled?: (name: string, enabled: boolean) => Promise<void>
  /**
   * 官方扩展**运行期**装好之后的补接线。
   *
   * 启动时读一次的服务（perf 的 IPC、云同步的调度器 start）不会因为扩展被装上而
   * 自动重跑；宿主约 1 秒后才把服务放进容器，所以这里只负责调度，真正的轮询在 index.ts。
   */
  onOfficialExtensionInstalled?: (id: string) => void
}

/** 由内置预设构造 wechat-local 的配置条目（command 指向部署路径），并置为启用 */
function wechatMcpEntry(): McpServerEntry {
  const preset = MCP_PRESETS.find((p) => p.name === WECHAT_MCP_SERVER)
  if (!preset) throw new Error(`内置 MCP 预设缺失：${WECHAT_MCP_SERVER}`)
  return { ...presetToEntry(preset), enabled: true }
}

/** 官方扩展清单的随包位置：dev 下在仓库里，打包后由 extraResources 放到 resources/extensions */
function officialExtensionsSourceDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'extensions')
    : join(app.getAppPath(), 'resources', 'extensions')
}

/**
 * 按需安装的官方扩展：复用 `plugin:install` 骨架（进度、取消、单插件 AbortController）。
 *
 * 安装落点就是 `~/.lumii/extensions/<id>`，外部扩展加载器 1 秒内会把它捡起来
 * ——不需要额外的「装完刷新」回调。
 */
function registerOfficialExtensionPlugins(catalog: OfficialCatalogEntry[], deps: PluginDeps): void {
  const extensionsDir = resolveExtensionsDir()
  for (const entry of catalog) {
    registerPlugin({
      id: `ext:${entry.id}`,
      async status() {
        return isOfficialExtensionInstalled(extensionsDir, entry.id)
          ? { installed: true, version: entry.version }
          : { installed: false }
      },
      async install(onProgress, signal) {
        await installOfficialExtension({
          entry,
          extensionsDir,
          onProgress,
          signal,
          download: (destFile, report, sig) =>
            installGithubAsset({
              repo: WECHAT_MCP_REPO,
              tag: RELEASE_TAG(),
              asset: entry.asset,
              destFile,
              sha256: entry.sha256,
              onProgress: report,
              signal: sig,
            }),
        })
        // 以前禁用过同一 id：装完要能直接用，否则要用户再点一次启用 + 重启
        try {
          setMainExtensionEnabled(entry.id, true)
        } catch {
          /* 偏好清理失败不影响安装 */
        }
        // 运行期补接线（启动时只读一次的服务不会自己回来）
        deps.onOfficialExtensionInstalled?.(entry.id)
      },
      async uninstall() {
        removeOfficialExtension(extensionsDir, entry.id)
      },
    })
  }
}

/** 注册全部内置插件。必须在 `setupPluginIpcHandlers()` 之前调用。 */
export function registerBuiltinPlugins(deps: PluginDeps = {}): void {
  registerPlugin({
    id: 'cloak-browser',
    async status() {
      if (!existsSync(CLOAK_DIR)) return { installed: false }
      const entries = readdirSync(CLOAK_DIR).filter((d) => d.startsWith('chromium-'))
      if (entries.length === 0) return { installed: false }
      entries.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      const latest = entries[0]
      const { exeFilename } = await import('../cloak-browser-downloader.js')
      const exePath = join(CLOAK_DIR, latest, exeFilename())
      if (!existsSync(exePath)) return { installed: false }
      return { installed: true, version: latest.replace('chromium-', ''), exePath }
    },
    async install(onProgress, signal) {
      const { ensureCloakBrowser } = await import('../cloak-browser-downloader.js')
      await ensureCloakBrowser(onProgress, signal)
    },
    async uninstall() {
      if (existsSync(CLOAK_DIR)) await fs.rm(CLOAK_DIR, { recursive: true, force: true })
    },
  })

  registerPlugin({
    id: 'ffmpeg',
    async status() {
      return existsSync(FFMPEG_EXE) ? { installed: true, exePath: FFMPEG_EXE } : { installed: false }
    },
    async install(onProgress, signal) {
      const platformPkg =
        process.platform === 'win32' ? '@ffmpeg-installer/win32-x64' : '@ffmpeg-installer/linux-x64'
      await installNpmFile({
        packageName: platformPkg,
        entry: `package/${process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'}`,
        destFile: FFMPEG_EXE,
        onProgress,
        signal,
      })
    },
    async uninstall() {
      await fs.rm(FFMPEG_DIR, { recursive: true, force: true })
    },
  })

  registerPlugin({
    id: 'wechat-mcp',
    async status() {
      // 迁移：老用户之前由随包同步来的 exe 已在部署路径，直接视为「已安装」，不重复下载
      return existsSync(WECHAT_MCP_EXE) ? { installed: true, exePath: WECHAT_MCP_EXE } : { installed: false }
    },
    async install(onProgress, signal) {
      if (process.platform !== 'win32') throw new Error('wechat-mcp 目前只有 Windows 版')
      await installGithubAsset({
        repo: WECHAT_MCP_REPO,
        tag: `v${app.getVersion()}`,
        asset: WECHAT_MCP_ASSET,
        destFile: WECHAT_MCP_EXE,
        onProgress,
        signal,
      })
      // 装完把 MCP 条目写进配置并启用（含热重连）
      await deps.upsertMcpServer?.(wechatMcpEntry())
    },
    async uninstall() {
      // 先停用（会 disconnect 子进程），再删文件——否则 Windows 下 exe 被占用删不掉。
      // 只停用不删条目：可逆、不破坏用户在面板里的调整（见 PluginDeps.setMcpServerEnabled）。
      await deps.setMcpServerEnabled?.(WECHAT_MCP_SERVER, false).catch(() => {})
      try {
        await fs.rm(WECHAT_MCP_DIR, { recursive: true, force: true })
      } catch {
        // 子进程可能还没完全退出：改名让位，下次启动清理（status 判据只看原路径）
        await fs.rename(WECHAT_MCP_EXE, `${WECHAT_MCP_EXE}.old-${Date.now()}`).catch(() => {})
      }
    },
  })

  for (const id of PET_PLUGIN_IDS) registerPetPlugin(id)

  // 官方扩展：装/卸都落 ~/.lumii/extensions，与随包同步共用同一套覆盖策略
  registerOfficialExtensionPlugins(loadOfficialCatalog(officialExtensionsSourceDir()), deps)
}
