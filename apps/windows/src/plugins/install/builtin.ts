/**
 * 内置插件注册表（主进程）
 *
 * 每接入一个插件就在这里 `registerPlugin({...})`。新增插件时同步在
 * `renderer/data/asset-plugins.ts` 的 `PLUGIN_REGISTRY` 里加一条
 * UI 元数据（id 必须一致）——渲染层据它出卡片，主进程据这里认 id。
 *
 * **MCP 不在这里**（2026-10-25 定案）：MCP Server（含 `wechat-chat-mcp`）由用户自己
 * 装、自己在「设置 › MCP 服务」里配，客户端只检测。这个文件只登记**插件**自身需要的
 * 运行时资产（反检测浏览器、ffmpeg、宠物模型），不再代管任何 MCP 二进制——
 * 之前那种「插件装着装着一个 MCP」的设计让两条链路互相打架，见
 * `shared/wechat-mcp-status.ts` 的文件头。
 */
import { app } from 'electron'
import { join } from 'path'
import os from 'os'
import { existsSync, readdirSync, promises as fs } from 'fs'
import { registerPlugin } from './plugin-manager'
import { installNpmFile } from './npm-fetch'
import { installGithubAsset, installGithubZip } from './github-fetch'
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

/** 资产托管在公开产品库 release；宠物包按 App 版本 tag 取 */
const RELEASE_TAG = (): string => `v${app.getVersion()}`

/** 宠物包与官方扩展的托管仓库（公开产品库 release） */
const RELEASE_REPO = 'lanxiake/lumii'

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
        repo: RELEASE_REPO,
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

/** 插件安装/卸载需要触达外部系统的钩子（由 index.ts 注入） */
export interface PluginDeps {
  /**
   * 官方扩展**运行期**装好之后的补接线。
   *
   * 启动时读一次的服务（perf 的 IPC、云同步的调度器 start）不会因为扩展被装上而
   * 自动重跑；宿主约 1 秒后才把服务放进容器，所以这里只负责调度，真正的轮询在 index.ts。
   */
  onOfficialExtensionInstalled?: (id: string) => void
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
              repo: RELEASE_REPO,
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

  for (const id of PET_PLUGIN_IDS) registerPetPlugin(id)

  // 官方扩展：装/卸都落 ~/.lumii/extensions，与随包同步共用同一套覆盖策略
  registerOfficialExtensionPlugins(loadOfficialCatalog(officialExtensionsSourceDir()), deps)
}
