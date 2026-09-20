/**
 * io — 目录遍历、JSON 读取、原子搬运、注册表 upsert。
 *
 * 「校验不通过 → 装不上，但绝不影响渲染稳定性」的**执行部分**在这里。
 * 判断部分（纯函数）在 @mtbot/pet-core 的 pet-package.ts。
 *
 * 原子性的做法：先把整包写进 `<目标>/.installing-<id>-<ts>/`，写全了再 `rename`
 * 成正式目录。同分区 rename 是原子的，所以扫描侧**永远看不到半成品**。
 * 目标已存在时先改名为 `.bak-...`，失败则改回。
 */

import { promises as fs } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import type { PetInstallPlan, PetModelConfig } from '@mtbot/pet-core'

const INSTALLING_PREFIX = '.installing-'
const BACKUP_PREFIX = '.bak-'
const REGISTRY_FILE = 'registry.json'

/** 递归列出目录下所有文件，返回相对 root 的路径（正斜杠） */
export async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) await walk(abs)
      else if (e.isFile()) out.push(relative(root, abs).split(sep).join('/'))
    }
  }
  await walk(root)
  return out.sort()
}

export interface JsonReadResult {
  exists: boolean
  /** 解析成功时的值 */
  value?: unknown
  /** 文件存在但读取/解析失败时的说明 */
  error?: string
}

/** 读 JSON；文件不存在不算错（返回 exists:false），解析失败算错 */
export async function readJson(filePath: string): Promise<JsonReadResult> {
  let text: string
  try {
    text = await fs.readFile(filePath, 'utf-8')
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return { exists: false }
    return { exists: true, error: `读取失败：${e.message}` }
  }
  try {
    return { exists: true, value: JSON.parse(text) }
  } catch (err) {
    return { exists: true, error: `JSON 解析失败：${(err as Error).message}` }
  }
}

/** 原子写文件（先写同目录临时文件再 rename） */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await fs.mkdir(dirname(filePath), { recursive: true })
  await fs.writeFile(tmp, content, 'utf-8')
  await fs.rename(tmp, filePath)
}

// ---------------------------------------------------------------------------
// 残留清理与崩溃恢复
// ---------------------------------------------------------------------------

/** 从 `.installing-<id>-<ts>` / `.bak-<id>-<ts>` 里取回 id */
function parseTempDirName(name: string, prefix: string): string | null {
  if (!name.startsWith(prefix)) return null
  const rest = name.slice(prefix.length)
  const m = /^(.*)-\d+$/.exec(rest)
  return m ? m[1] : null
}

/**
 * 清理上一次中断留下的痕迹。
 *
 * - `.installing-*` 永远是不完整的，直接删
 * - `.bak-*` 若对应的正式目录不存在，说明上次崩在「改名备份」与「改名就位」之间，
 *   **把它改回去**——这是用户原本能用的模型，不能因为一次安装失败就丢了
 */
export async function cleanStale(targetDir: string): Promise<string[]> {
  const actions: string[] = []
  let entries: string[]
  try {
    entries = await fs.readdir(targetDir)
  } catch {
    return actions
  }
  for (const name of entries) {
    const installingId = parseTempDirName(name, INSTALLING_PREFIX)
    if (installingId !== null) {
      await fs.rm(join(targetDir, name), { recursive: true, force: true })
      actions.push(`清理未完成的安装目录 ${name}`)
      continue
    }
    const backupId = parseTempDirName(name, BACKUP_PREFIX)
    if (backupId === null) continue
    const official = join(targetDir, backupId)
    const exists = await pathExists(official)
    if (exists) {
      await fs.rm(join(targetDir, name), { recursive: true, force: true })
      actions.push(`清理已完成安装的备份 ${name}`)
    } else {
      await fs.rename(join(targetDir, name), official)
      actions.push(`从备份恢复 ${backupId}（上次安装中断）`)
    }
  }
  return actions
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 安装
// ---------------------------------------------------------------------------

export interface InstallOptions {
  /** 包目录（绝对路径） */
  pkgDir: string
  /** 用户宠物目录（绝对路径） */
  targetDir: string
  plan: PetInstallPlan
}

export interface InstallOutcome {
  /** 安装后的模型目录 */
  installedDir: string
  /** 本次安装前留下的备份（若原本就存在同 id 目录） */
  backupDir: string | null
  /** 写入了条目的注册表文件 */
  registryPath: string
  /** 残留清理动作（有输出说明上次异常退出过） */
  recovered: string[]
}

/**
 * 执行安装。
 *
 * 失败时回滚到安装前状态并把原错误抛出——调用方据此报错，用户目录保持可用。
 */
export async function installPackage(opts: InstallOptions): Promise<InstallOutcome> {
  const { pkgDir, targetDir, plan } = opts
  await fs.mkdir(targetDir, { recursive: true })
  const recovered = await cleanStale(targetDir)

  const stamp = Date.now()
  const staging = join(targetDir, `${INSTALLING_PREFIX}${plan.dirName}-${stamp}`)
  const official = join(targetDir, plan.dirName)
  const backup = join(targetDir, `${BACKUP_PREFIX}${plan.dirName}-${stamp}`)

  let backupMade = false
  let placed = false
  try {
    await fs.mkdir(staging, { recursive: true })
    for (const f of plan.files) {
      // plan.files[].to 形如 "<id>/<rel>"；staging 本身就是那个 <id> 目录
      const rel = f.to.slice(plan.dirName.length + 1)
      const dest = join(staging, rel)
      await fs.mkdir(dirname(dest), { recursive: true })
      await fs.copyFile(join(pkgDir, f.from), dest)
    }

    if (await pathExists(official)) {
      await fs.rename(official, backup)
      backupMade = true
    }
    await fs.rename(staging, official)
    placed = true
  } catch (err) {
    // 回滚：先撤掉半成品，再把备份改回原位
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
    if (backupMade && !placed) {
      await fs.rm(official, { recursive: true, force: true }).catch(() => {})
      await fs.rename(backup, official).catch(() => {})
    }
    throw err
  }

  // 文件已就位，接下来写注册表。注册表写失败不回滚文件——
  // 目录已经完整可用，只是还没被注册；下次 install 或手工补一条即可。
  // 反过来（回滚文件）会让「已经完整可用的模型」消失，那更糟。
  const registryPath = join(targetDir, REGISTRY_FILE)
  await upsertRegistryEntry(registryPath, plan.registryEntry)

  if (backupMade) {
    await fs.rm(backup, { recursive: true, force: true }).catch(() => {})
  }

  return { installedDir: official, backupDir: backupMade ? backup : null, registryPath, recovered }
}

/**
 * 把条目 upsert 进用户注册表。
 *
 * 保留表内其它条目与 `version` 字段——用户可能是手写维护这张表的，
 * 安装一个新宠物不该把手写的部分抹掉。
 */
export async function upsertRegistryEntry(
  registryPath: string,
  entry: PetModelConfig,
): Promise<void> {
  const existing = await readJson(registryPath)
  const base =
    existing.exists && existing.value && typeof existing.value === 'object' && !Array.isArray(existing.value)
      ? (existing.value as Record<string, unknown>)
      : {}
  const models = Array.isArray(base.models) ? [...(base.models as unknown[])] : []

  const idx = models.findIndex(
    (m) => m !== null && typeof m === 'object' && (m as { id?: unknown }).id === entry.id,
  )
  if (idx >= 0) models[idx] = entry
  else models.push(entry)

  const next: Record<string, unknown> = {
    version: typeof base.version === 'number' ? base.version : 2,
    ...base,
    models,
  }
  if (typeof next.defaultModelId !== 'string' || !next.defaultModelId) {
    next.defaultModelId = entry.id
  }

  await writeFileAtomic(registryPath, JSON.stringify(next, null, 2) + '\n')
}
