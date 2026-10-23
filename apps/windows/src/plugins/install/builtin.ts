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
import { join, dirname, basename } from 'path'
import os from 'os'
import { existsSync, readdirSync, promises as fs } from 'fs'
import { registerPlugin } from './plugin-manager'
import { installNpmFile } from './npm-fetch'
import { installGithubAsset, installGithubZip } from './github-fetch'
import { getDeployedMcpExePath } from '../../main/bundled-mcp-exe'
import {
  MCP_PRESETS,
  WECHAT_MCP_ASSET,
  WECHAT_MCP_RELEASE_TAG,
  WECHAT_MCP_SERVER_NAME,
  WECHAT_MCP_VERSION,
} from '../../shared/mcp-presets'
import { presetToEntry, type McpServerEntry } from '../../main/config/mcp-config'
import { resolvePluginRuntimeDir } from '../../main/paths'
import { resolveUserPetModelsDir } from '../builtin/pet/pet-asset-protocol'
import { resolveExtensionsDir } from '../external/loader'
import { setMainExtensionEnabled } from '../../main/kernel/extension-store'
import {
  installOfficialExtension,
  isOfficialExtensionInstalled,
  loadOfficialCatalog,
  removeOfficialExtension,
  type OfficialCatalogEntry,
} from '../external/official'

/** CloakBrowser 的落点（历史上就在 homedir，不在客户端数据根，保持不变） */
const CLOAK_DIR = join(os.homedir(), '.cloakbrowser')

/** ffmpeg 落点（客户端数据根的插件运行时目录；解析链见 main/ffmpeg-runner.ts） */
const FFMPEG_DIR = resolvePluginRuntimeDir('ffmpeg')
const FFMPEG_EXE = join(FFMPEG_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')

/**
 * 微信 MCP（`wechat-chat-mcp`）：落点**必须**与 MCP 链路写进 `mcp-servers.json` 的
 * command 完全一致（`getDeployedMcpExePath`），否则装了插件 MCP 也连不上。
 *
 * 旧产品名 `wechat-mcp` 已废弃；老安装的目录只作迁移兼容（仍可用，卸载/升级时清理）。
 */
const WECHAT_MCP_SERVER = WECHAT_MCP_SERVER_NAME
const WECHAT_MCP_DEPLOY_NAME = 'wechat-chat-mcp'
const WECHAT_MCP_EXE = getDeployedMcpExePath(WECHAT_MCP_DEPLOY_NAME)
const WECHAT_MCP_DIR = dirname(WECHAT_MCP_EXE)
const LEGACY_WECHAT_MCP_EXE = getDeployedMcpExePath('wechat-mcp')
const LEGACY_WECHAT_MCP_DIR = dirname(LEGACY_WECHAT_MCP_EXE)
/** 资产托管在公开产品库 release；MCP 用自己的 tag，不跟 App 版本走 */
const WECHAT_MCP_REPO = 'lanxiake/lumii'
const RELEASE_TAG = (): string => `v${app.getVersion()}`

/** 安装时写下的版本边车（exe 旁边；卸载时随目录一起删） */
function versionFileOf(exe: string): string {
  return join(dirname(exe), 'version.json')
}

/**
 * 读安装版本。
 *
 * 为什么不直接跑 `--version`：PyInstaller onefile 冷启动 1–3s，
 * 而插件页每次打开都要查状态；实读会把面板拖住。
 */
async function readWechatMcpVersion(exe: string): Promise<string | undefined> {
  try {
    const meta = JSON.parse(await fs.readFile(versionFileOf(exe), 'utf-8')) as {
      version?: string
    }
    if (meta.version) return meta.version
  } catch {
    /* 没边车：继续看产品自带安装器留下的信息 */
  }
  // 产品自带 `--install`：台账 `installed.json`（相对它自己的数据根 `.lumii/`）
  try {
    const meta = JSON.parse(
      await fs.readFile(
        join(WECHAT_MCP_DIR, '.lumii', 'mcp', WECHAT_MCP_DEPLOY_NAME, 'installed.json'),
        'utf-8',
      ),
    ) as { version?: string; exe?: string }
    if (meta.version) return meta.version
  } catch {
    /* 没台账 */
  }
  // 最后从带版本号的文件名里取：wechat-chat-mcp-0.10.0.exe
  return basename(exe).match(/^wechat-chat-mcp-(\d+\.\d+\.\d+[^/]*)\.exe$/)?.[1]
}

/**
 * 找到实际安装的 exe。
 *
 * 优先自己下载的无版本名；其次认**产品自带 `--install`** 落下的带版本号副本
 * （那个安装器不写 `version.json`，但会写 `installed.json` 与版本号文件名）；
 * 最后才看旧产品名目录（迁移兼容）。
 */
async function findWechatMcpExe(): Promise<string | null> {
  if (existsSync(WECHAT_MCP_EXE)) return WECHAT_MCP_EXE
  const names = await fs.readdir(WECHAT_MCP_DIR).catch(() => [] as string[])
  const versioned = names
    .filter((n) => /^wechat-chat-mcp-\d+\.\d+\.\d+.*\.exe$/.test(n))
    .sort()
    .at(-1)
  if (versioned) return join(WECHAT_MCP_DIR, versioned)
  return existsSync(LEGACY_WECHAT_MCP_EXE) ? LEGACY_WECHAT_MCP_EXE : null
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 清理上次「改名让位」留下的残留（仍在运行的文件删不掉，留给下次） */
async function cleanupStaleWechatFiles(): Promise<void> {
  const names = await fs.readdir(WECHAT_MCP_DIR).catch(() => [] as string[])
  await Promise.all(
    names
      .filter((n) => n.includes('.old-'))
      .map((n) => fs.rm(join(WECHAT_MCP_DIR, n), { recursive: true, force: true }).catch(() => {})),
  )
}

/**
 * 卸载删不掉目录时：把所有文件改名让位。
 *
 * Windows 不允许删除仍被进程打开的文件；但**改名是可以的**。改完 `status()` 立刻按
 * 未安装处理（版本号文件名/无版本名都以 `.old-` 结尾，不再命中），残留由下次安装清理。
 */
async function renameWechatFilesAside(): Promise<void> {
  const names = await fs.readdir(WECHAT_MCP_DIR).catch(() => [] as string[])
  for (const name of names) {
    if (name.includes('.old-')) continue
    await fs
      .rename(join(WECHAT_MCP_DIR, name), join(WECHAT_MCP_DIR, `${name}.old-${Date.now()}`))
      .catch(() => {})
  }
}

async function writeWechatMcpVersion(): Promise<void> {
  await fs.mkdir(WECHAT_MCP_DIR, { recursive: true })
  await fs.writeFile(
    versionFileOf(WECHAT_MCP_EXE),
    JSON.stringify({ version: WECHAT_MCP_VERSION, installedAt: Date.now() }, null, 2),
  )
}

/** 删除旧产品名的安装目录（被旧进程占用时忽略，下次再清） */
async function removeLegacyWechatMcpDir(): Promise<void> {
  if (LEGACY_WECHAT_MCP_DIR === WECHAT_MCP_DIR || !existsSync(LEGACY_WECHAT_MCP_DIR)) return
  try {
    await fs.rm(LEGACY_WECHAT_MCP_DIR, { recursive: true, force: true })
  } catch {
    /* 旧 exe 还在跑：留着，不影响新版；下次安装/卸载再清 */
  }
}

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
  /**
   * 写入并启用一个 MCP server 条目（安装微信 MCP 时用，含热重连）。
   *
   * `originalName` 传同名 = **覆盖已有条目**（产品的 `--install` 可能已经写过一条）；
   * 不传时同名会被当成重复新增而报错。
   */
  upsertMcpServer?: (entry: McpServerEntry, originalName?: string) => Promise<void>
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

/** 由内置预设构造 wechat-chat 的配置条目（command 指向部署路径），并置为启用 */
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
      const { exeFilename } = await import('../../main/cloak-browser-downloader.js')
      const exePath = join(CLOAK_DIR, latest, exeFilename())
      if (!existsSync(exePath)) return { installed: false }
      return { installed: true, version: latest.replace('chromium-', ''), exePath }
    },
    async install(onProgress, signal) {
      const { ensureCloakBrowser } = await import('../../main/cloak-browser-downloader.js')
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
    id: WECHAT_MCP_DEPLOY_NAME,
    async status() {
      // 兼容三种安装来源：插件自己下的 / 产品自带 --install 落的带版本副本 / 旧产品名目录
      const exe = await findWechatMcpExe()
      return {
        installed: Boolean(exe),
        latestVersion: WECHAT_MCP_VERSION,
        ...(exe ? { exePath: exe, version: await readWechatMcpVersion(exe) } : {}),
      }
    },
    async install(onProgress, signal) {
      if (process.platform !== 'win32') throw new Error('微信 MCP 目前只有 Windows 版')
      // 幂等：同版本已装好就不重复下载 37 MB；但仍要把配置条目补齐/启用
      if (existsSync(WECHAT_MCP_EXE) && (await readWechatMcpVersion(WECHAT_MCP_EXE)) === WECHAT_MCP_VERSION) {
        onProgress({ phase: 'skipped', version: WECHAT_MCP_VERSION })
        await deps.upsertMcpServer?.(wechatMcpEntry(), WECHAT_MCP_SERVER)
        await cleanupStaleWechatFiles()
        return
      }
      await cleanupStaleWechatFiles()
      await installGithubAsset({
        repo: WECHAT_MCP_REPO,
        // 独立 tag：MCP 单独发版，不依赖 App 版本
        tag: WECHAT_MCP_RELEASE_TAG,
        asset: WECHAT_MCP_ASSET,
        destFile: WECHAT_MCP_EXE,
        onProgress,
        signal,
      })
      // 边车失败不影响可用性（最坏只是面板不显示版本），别把装好的文件判成失败
      await writeWechatMcpVersion().catch(() => {})
      // 装完把 MCP 条目写进配置并启用（含热重连）；同名覆盖，顺带把旧路径改到新路径
      await deps.upsertMcpServer?.(wechatMcpEntry(), WECHAT_MCP_SERVER)
      await removeLegacyWechatMcpDir()
    },
    async uninstall() {
      // 先停用（会 disconnect 子进程），再删文件——否则 Windows 下 exe 被占用删不掉。
      // 只停用不删条目：可逆、不破坏用户在面板里的调整（见 PluginDeps.setMcpServerEnabled）。
      await deps.setMcpServerEnabled?.(WECHAT_MCP_SERVER, false).catch(() => {})
      // 等子进程真的退出（PyInstaller 是引导进程 + Python 子进程两层，停服务先杀到引导进程）
      await sleep(500)
      await fs.rm(WECHAT_MCP_DIR, { recursive: true, force: true }).catch(() => {})
      if (existsSync(WECHAT_MCP_EXE) || (await findWechatMcpExe())) {
        // 仍被占用：改成 `.old-` 让位，status 立刻判未安装；残留下次安装时清理
        await renameWechatFilesAside()
      }
      await removeLegacyWechatMcpDir()
    },
  })

  for (const id of PET_PLUGIN_IDS) registerPetPlugin(id)

  // 官方扩展：装/卸都落 ~/.lumii/extensions，与随包同步共用同一套覆盖策略
  registerOfficialExtensionPlugins(loadOfficialCatalog(officialExtensionsSourceDir()), deps)
}
