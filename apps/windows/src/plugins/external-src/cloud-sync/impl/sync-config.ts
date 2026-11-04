/**
 * 云同步配置读写。
 *
 * 独立文件 ~/.lumii/config/cloud-sync.json，token 经 safeStorage 加密落盘
 * （加密不可用时用 plain: 前缀明文兜底，与 provider-config.ts 同模式）。
 * 所有加密逻辑集中在本模块；渲染层只看到掩码，IPC/manager 层不直接操作密文。
 */
import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import { resolveWindowsClientDataRoot } from '../../../../main/client-data-root'
import { createLogger } from '../../../../main/logger'
import type { CloudSyncConfig, CloudSyncConfigView } from '../../../../shared/cloud-sync'

const logger = createLogger('cloud-sync/config')

const configFile = (): string =>
  path.join(resolveWindowsClientDataRoot(), 'config', 'cloud-sync.json')

/**
 * 默认排除：**只同步文本/代码/文档，不同步多媒体与压缩包**（2026-11-04）。
 *
 * 动因是实测出来的：仓库 11GB 里 9.5GB 是历史，其中 `wiki_sources.jsonl` 的
 * 466 个版本占 7.9GB（当前文件才 4MB），`outputs/` 的 17797 个历史 blob 占 4GB
 * （当前 3286 个）。二进制文件每次改动都在 git 里留一个完整新副本，而它们
 * 本来就不该走版本控制——这些是作品产物，不是源数据。
 *
 * 基准是 `workspace/outputs` 的相对路径（见 sync-scope 的说明）。
 * 用「排除扩展名」而不是「只允许白名单」：白名单会让用户新建的
 * `.md`/`.json` 之类意外漏同步，而漏同步比多同步更难发现。
 */
const MEDIA_EXCLUDES = [
  // 视频 / 音频
  '**/*.mp4', '**/*.mkv', '**/*.mov', '**/*.avi', '**/*.webm', '**/*.flv',
  '**/*.mp3', '**/*.wav', '**/*.m4a', '**/*.aac', '**/*.flac', '**/*.ogg', '**/*.silk',
  // 图片（图卡/封面/素材都属作品产物；需要跨设备时另行归档，不走 git）
  '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.gif', '**/*.webp', '**/*.bmp',
  '**/*.ico', '**/*.svg', '**/*.psd', '**/*.ai', '**/*.sketch', '**/*.fig',
  // 压缩包与镜像
  '**/*.zip', '**/*.7z', '**/*.rar', '**/*.tar', '**/*.gz', '**/*.bz2', '**/*.xz',
  '**/*.iso', '**/*.dmg', '**/*.exe', '**/*.msi', '**/*.apk', '**/*.ipa',
  // 下载中间产物
  '**/*.part', '**/*.download', '**/*.tmp', '**/*.crdownload',
  // 模型与二进制库
  '**/*.onnx', '**/*.bin', '**/*.gguf', '**/*.safetensors', '**/*.pth', '**/*.pt',
  '**/*.dll', '**/*.so', '**/*.dylib', '**/*.node',
]

export const DEFAULT_CLOUD_SYNC_CONFIG: CloudSyncConfig = {
  enabled: false,
  provider: 'gitcode',
  repoUrl: '',
  branch: 'main',
  intervalMinutes: 15,
  // 分级阈值：阶段一只传 ≤1MB 的文件（实测 68% 的文件只占 1.6% 的体积，
  // 几十秒即可到位），更大者交给阶段二队列分批传（T4.4 已就绪）
  smallFileThresholdBytes: 1024 * 1024,
  largeFileBatchBytes: 50 * 1024 * 1024,
  // 只同步文本/代码/文档（见 MEDIA_EXCLUDES 的注释）
  syncExcludePatterns: MEDIA_EXCLUDES,
  syncForceIncludePatterns: [],
}

function encryptToken(token: string): string {
  if (!token) return ''
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(token).toString('base64')
  }
  return `plain:${token}`
}

/** 仅主进程内部使用（sync onAuth / testConnection 需明文），绝不经 IPC 返回渲染层 */
export function decryptToken(enc?: string): string {
  if (!enc) return ''
  if (enc.startsWith('plain:')) return enc.slice(6)
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return ''
  }
}

export function loadCloudSyncConfig(): CloudSyncConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile(), 'utf-8')) as Partial<CloudSyncConfig>
    // **排除规则是「默认 + 用户追加」，不是「用户覆盖默认」**（2026-11-04）。
    // 老配置文件里存的是空数组 `[]`，直接展开会让默认的多媒体排除规则失效——
    // 那正是这轮要修的问题（11GB 仓库里 9.5GB 是历史多媒体）。
    // 用户想放行某个类型，加进 syncForceIncludePatterns（排除优先，需两边都改）。
    const userExcludes = Array.isArray(raw.syncExcludePatterns) ? raw.syncExcludePatterns : []
    const merged = [...new Set([...MEDIA_EXCLUDES, ...userExcludes])]
    return { ...DEFAULT_CLOUD_SYNC_CONFIG, ...raw, syncExcludePatterns: merged }
  } catch {
    return { ...DEFAULT_CLOUD_SYNC_CONFIG }
  }
}

/** 从视图保存：token 显式语义，空串沿用旧值 */
export function saveConfigFromView(view: CloudSyncConfigView): CloudSyncConfig {
  const cur = loadCloudSyncConfig()
  const tokenEnc = view.token && view.token.trim() !== '' ? encryptToken(view.token) : cur.tokenEnc
  const next: CloudSyncConfig = {
    enabled: view.enabled,
    provider: view.provider,
    repoUrl: view.repoUrl.trim(),
    branch: view.branch?.trim() || 'main',
    intervalMinutes: view.intervalMinutes,
    tokenEnc,
    // 分级阈值暂不经设置页编辑，保存时**沿用现值** —— 否则每次保存配置
    // 都会被 View（不含这两个字段）覆写回 undefined
    smallFileThresholdBytes: cur.smallFileThresholdBytes,
    largeFileBatchBytes: cur.largeFileBatchBytes,
    syncExcludePatterns: cur.syncExcludePatterns,
    syncForceIncludePatterns: cur.syncForceIncludePatterns,
  }
  fs.mkdirSync(path.dirname(configFile()), { recursive: true })
  fs.writeFileSync(configFile(), JSON.stringify(next, null, 2), 'utf-8')
  logger.info(`[saveConfigFromView] 已保存云同步配置, provider=${next.provider}, enabled=${next.enabled}`)
  return next
}

/** 只读回显视图（token 掩码），workspaceDir 由 IPC 层填充 */
export function toConfigView(cfg: CloudSyncConfig): CloudSyncConfigView {
  const token = decryptToken(cfg.tokenEnc)
  const masked =
    token.length <= 4 ? (token ? '****' : '') : `${token.slice(0, 4)}****${token.slice(-4)}`
  return {
    enabled: cfg.enabled,
    provider: cfg.provider,
    repoUrl: cfg.repoUrl,
    branch: cfg.branch,
    intervalMinutes: cfg.intervalMinutes,
    tokenMasked: masked,
    workspaceDir: '',
  }
}
