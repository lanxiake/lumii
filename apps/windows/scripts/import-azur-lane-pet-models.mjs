#!/usr/bin/env node
/**
 * 将碧蓝航线（Azur Lane JP）Live2D 模型批量迁移到 pet-models 并写入 registry.json。
 *
 * 用法（在 apps/windows 目录）：
 *   node scripts/import-azur-lane-pet-models.mjs              # 移动并注册（默认）
 *   node scripts/import-azur-lane-pet-models.mjs --copy       # 复制而非移动
 *   node scripts/import-azur-lane-pet-models.mjs --dry-run    # 仅预览
 *   node scripts/import-azur-lane-pet-models.mjs --only=aidang_2,zhala_2
 *   node scripts/import-azur-lane-pet-models.mjs --force      # 覆盖已存在的 runtime 目录
 *
 * 默认源目录：仓库根/.qoder/docs/临时文档/live2d模型/Azue Lane(JP)
 * 默认目标：apps/windows/resources/pet-models
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WINDOWS_ROOT = path.resolve(__dirname, '..')
const REPO_ROOT = path.resolve(WINDOWS_ROOT, '../..')

const DEFAULT_SOURCE = path.join(
  REPO_ROOT,
  '.qoder',
  'docs',
  '临时文档',
  'live2d模型',
  'Azue Lane(JP)',
)
const DEFAULT_DEST = path.join(WINDOWS_ROOT, 'resources', 'pet-models')
const REGISTRY_PATH = path.join(DEFAULT_DEST, 'registry.json')

const PET_MOTION_GROUP_UNNAMED = '$unnamed'

/** 迁移时跳过的文件/目录（语音等非渲染资源） */
const SKIP_NAMES = new Set(['vioce', 'voice', '.ds_store'])
const SKIP_EXT = new Set(['.mp3', '.wav', '.ogg', '.bak'])

/** 解析 CLI 参数 */
function parseArgs(argv) {
  const opts = {
    source: DEFAULT_SOURCE,
    dest: DEFAULT_DEST,
    copy: false,
    dryRun: false,
    force: false,
    only: null,
  }
  for (const arg of argv) {
    if (arg === '--copy') opts.copy = true
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--force') opts.force = true
    else if (arg.startsWith('--source=')) opts.source = path.resolve(arg.slice(9))
    else if (arg.startsWith('--dest=')) opts.dest = path.resolve(arg.slice(7))
    else if (arg.startsWith('--only=')) {
      opts.only = new Set(
        arg
          .slice(7)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
    } else if (arg === '--help' || arg === '-h') {
      console.log(`用法: node scripts/import-azur-lane-pet-models.mjs [选项]

选项:
  --copy          复制文件（保留源目录）
  --dry-run       仅打印计划，不写磁盘
  --force         覆盖已存在的 {id}/runtime 目录
  --only=a,b      仅处理指定模型 id（文件夹名）
  --source=PATH   源目录（默认 Azue Lane(JP)）
  --dest=PATH     目标 pet-models 目录
`)
      process.exit(0)
    }
  }
  return opts
}

/**
 * 将动作组 key 转为 registry 可读标签（空串 → $unnamed）。
 */
function formatMotionGroupLabel(group) {
  return group === '' ? PET_MOTION_GROUP_UNNAMED : group
}

/**
 * 从 model3.json 原始对象解析表情、动作组、命中区域。
 */
function parseModel3Json(data) {
  const expressions = []
  const motions = []
  const exprList = data?.FileReferences?.Expressions ?? []
  exprList.forEach((entry, index) => {
    expressions.push({
      index,
      name: entry.Name ?? `expr_${index}`,
      file: entry.File ?? '',
    })
  })

  const motionGroups = data?.FileReferences?.Motions ?? {}
  for (const [group, items] of Object.entries(motionGroups)) {
    if (!Array.isArray(items)) continue
    items.forEach((item, index) => {
      motions.push({
        group,
        groupLabel: formatMotionGroupLabel(group),
        index,
        file: item?.File ?? '',
      })
    })
  }

  const lipGroup = data?.Groups?.find((g) => g.Target === 'Parameter' && g.Name === 'LipSync')
  const lipSyncParams = lipGroup?.Ids?.length ? [...lipGroup.Ids] : []

  const hitAreas = (data?.HitAreas ?? []).map((h) => ({
    id: h.Id ?? '',
    name: h.Name ?? '',
  }))

  return { expressions, motions, lipSyncParams, hitAreas }
}

/**
 * 从 motion 文件路径提取无扩展名的语义名（如 touch_head）。
 */
function motionStem(filePath) {
  const base = path.basename(filePath).replace(/\.motion3\.json$/i, '')
  return base.replace(/[^a-zA-Z0-9_一-龥-]/g, '_')
}

/**
 * 为 HitArea 匹配 Tap* 动作组名。
 */
function matchTapGroup(hitAreaId, motionGroupNames) {
  const id = hitAreaId.toLowerCase()
  const tapGroups = motionGroupNames.filter((g) => g.toLowerCase().startsWith('tap'))
  for (const g of tapGroups) {
    const gl = g.toLowerCase()
    if (gl === `tap${id}` || gl === `taptouch${id}`) return g
  }
  for (const g of tapGroups) {
    const gl = g.toLowerCase()
    if (gl.endsWith(id) || gl.includes(id)) return g
  }
  return null
}

/**
 * 根据 model3 结构生成 registry 单条模型配置（不含 id/name/modelUrl/thumbnailUrl）。
 */
function buildRegistryFields(modelId, model3, catalog) {
  const motionGroupNames = [...new Set(catalog.motions.map((m) => m.group))]
  const hasIdle = motionGroupNames.includes('Idle')
  const hasUnnamed = motionGroupNames.includes('')

  let idleMotionGroup = 'Idle'
  let idleMotionFallbackGroup
  if (hasIdle) {
    idleMotionGroup = 'Idle'
    if (hasUnnamed) idleMotionFallbackGroup = PET_MOTION_GROUP_UNNAMED
  } else if (hasUnnamed) {
    idleMotionGroup = PET_MOTION_GROUP_UNNAMED
  } else if (motionGroupNames.length > 0) {
    idleMotionGroup = formatMotionGroupLabel(motionGroupNames[0])
  }

  const scaleRaw = typeof model3.ScaleFactor === 'number' ? model3.ScaleFactor : 0
  const scale =
    scaleRaw > 0 ? Math.min(0.5, Math.max(0.22, Math.round(scaleRaw * 2.8 * 100) / 100)) : 0.35

  const emotionMap = { neutral: 0, 平静: 0, 默认: 0 }
  for (const expr of catalog.expressions) {
    const key = expr.name.trim()
    if (key) emotionMap[key] = expr.index
    emotionMap[`exp_${expr.index}`] = expr.index
    emotionMap[key.toLowerCase()] = expr.index
  }

  const tapMotions = {}
  for (const hit of catalog.hitAreas) {
    if (!hit.id) continue
    const group = matchTapGroup(hit.id, motionGroupNames)
    if (group) tapMotions[hit.id] = { [group]: 0 }
  }

  const reservedGroups = new Set([
    'Idle',
    'Start',
    '',
    ...motionGroupNames.filter((g) => g.toLowerCase().startsWith('tap')),
  ])
  if (idleMotionFallbackGroup) reservedGroups.add('')

  const actionMotions = {}
  if (hasUnnamed && !hasIdle) {
    for (const m of catalog.motions) {
      if (m.group !== '') continue
      const stem = motionStem(m.file)
      if (!stem || stem === 'idle') continue
      actionMotions[stem] = {
        group: PET_MOTION_GROUP_UNNAMED,
        index: m.index,
        description: `动作 ${stem}`,
      }
    }
  }

  const displayName = typeof model3.Name === 'string' && model3.Name.trim() ? model3.Name.trim() : modelId
  const hasExpressions = catalog.expressions.length > 0
  const hasActions = Object.keys(actionMotions).length > 0

  let personaAddon = `你是碧蓝航线舰娘虚拟人「${displayName}」（模型 ${modelId}）。`
  if (hasExpressions) {
    personaAddon +=
      ' 请用方括号表情标签切换面部表情；表情名见 emotionMap。\n回复口语化、适合朗读。'
  } else if (hasActions) {
    personaAddon +=
      ' 本模型无独立表情文件，可用 [motion:动作名] 触发肢体动作（如 touch_head、main_1）。\n回复口语化、适合朗读。'
  } else {
    personaAddon +=
      ' 本模型主要靠待机动画与点击互动，无独立表情与可编排动作；请勿使用 [motion:] 或表情标签。\n回复口语化、适合朗读。'
  }

  return {
    name: displayName,
    rendererType: 'live2d',
    scale,
    idleMotionGroup,
    ...(idleMotionFallbackGroup ? { idleMotionFallbackGroup } : {}),
    talkMotionGroup: idleMotionGroup,
    agentId: '',
    emotionMap,
    tapMotions,
    actionMotions,
    defaultExpression: 0,
    personaAddon,
    toolPrompts: {
      expression: hasExpressions,
      thinkTag: true,
    },
  }
}

/**
 * 判断路径是否应跳过（语音等）。
 */
function shouldSkipEntry(name) {
  if (SKIP_NAMES.has(name.toLowerCase())) return true
  const ext = path.extname(name).toLowerCase()
  return SKIP_EXT.has(ext)
}

/**
 * 递归复制目录，跳过语音等非渲染文件。
 */
async function copyTreeFiltered(src, dest) {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const ent of entries) {
    if (shouldSkipEntry(ent.name)) continue
    const from = path.join(src, ent.name)
    const to = path.join(dest, ent.name)
    if (ent.isDirectory()) {
      await copyTreeFiltered(from, to)
    } else if (ent.isFile()) {
      await fs.copyFile(from, to)
    }
  }
}

/**
 * 递归删除目录。
 */
async function rmRecursive(target) {
  await fs.rm(target, { recursive: true, force: true })
}

/**
 * 在 runtime 目录生成 icon.png（取自 textures/texture_00.png）。
 */
async function ensureIcon(runtimeDir) {
  const iconPath = path.join(runtimeDir, 'icon.png')
  try {
    await fs.access(iconPath)
    return
  } catch {
    /* 不存在则生成 */
  }
  const texture = path.join(runtimeDir, 'textures', 'texture_00.png')
  try {
    await fs.access(texture)
    await fs.copyFile(texture, iconPath)
  } catch {
    console.warn(`  [warn] 未找到贴图，跳过 icon: ${texture}`)
  }
}

/**
 * 写入模型 ReadMe.txt。
 */
async function writeReadMe(modelDir, modelId) {
  const text = `# ${modelId}

碧蓝航线（Azur Lane JP）第三方 Live2D 模型，由 import-azur-lane-pet-models.mjs 导入。

⚠️ 仅限开发测试；产品化发布前须确认版权与商用授权。
`
  await fs.writeFile(path.join(modelDir, 'ReadMe.txt'), text, 'utf-8')
}

/**
 * 扫描源目录，返回 { id, srcDir, model3File, model3 } 列表。
 */
async function discoverModels(sourceDir, onlySet) {
  const result = []
  let entries
  try {
    entries = await fs.readdir(sourceDir, { withFileTypes: true })
  } catch (err) {
    throw new Error(`无法读取源目录 ${sourceDir}: ${err.message}`)
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const id = ent.name
    if (onlySet && !onlySet.has(id)) continue

    const srcDir = path.join(sourceDir, id)
    const files = await fs.readdir(srcDir)
    const model3File = files.find((f) => f.endsWith('.model3.json'))
    if (!model3File) {
      console.warn(`[skip] ${id}: 未找到 *.model3.json`)
      continue
    }

    const model3Path = path.join(srcDir, model3File)
    let model3
    try {
      const raw = await fs.readFile(model3Path, 'utf-8')
      model3 = JSON.parse(raw)
    } catch (err) {
      console.warn(`[skip] ${id}: model3.json 解析失败 — ${err.message}`)
      continue
    }

    result.push({ id, srcDir, model3File, model3 })
  }

  return result.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * 迁移单个模型到 pet-models/{id}/runtime。
 */
async function migrateOneModel(model, destRoot, opts) {
  const { id, srcDir, model3File, model3 } = model
  const modelDir = path.join(destRoot, id)
  const runtimeDir = path.join(modelDir, 'runtime')

  const exists = await fs
    .access(runtimeDir)
    .then(() => true)
    .catch(() => false)

  if (exists && !opts.force) {
    console.log(`[skip] ${id}: 已存在 ${runtimeDir}（加 --force 覆盖）`)
    return { id, skipped: true, reason: 'exists' }
  }

  const action = opts.copy ? 'copy' : 'move'
  console.log(`[${action}] ${id} → ${runtimeDir}`)

  if (opts.dryRun) {
    return { id, skipped: false, dryRun: true }
  }

  if (exists) await rmRecursive(runtimeDir)
  await fs.mkdir(modelDir, { recursive: true })
  await copyTreeFiltered(srcDir, runtimeDir)

  if (!opts.copy) {
    await rmRecursive(srcDir)
  }

  await ensureIcon(runtimeDir)
  await writeReadMe(modelDir, id)

  const modelUrl = `${id}/runtime/${model3File}`
  const thumbnailUrl = `${id}/runtime/icon.png`
  const catalog = parseModel3Json(model3)
  const fields = buildRegistryFields(id, model3, catalog)

  return {
    id,
    skipped: false,
    entry: {
      id,
      modelUrl,
      thumbnailUrl,
      ...fields,
    },
  }
}

/**
 * 合并新条目到 registry.json（按 id 更新或追加，保留 defaultModelId）。
 */
async function mergeRegistry(destRoot, newEntries, dryRun) {
  const registryPath = path.join(destRoot, 'registry.json')
  let registry
  try {
    const raw = await fs.readFile(registryPath, 'utf-8')
    registry = JSON.parse(raw)
  } catch {
    registry = { version: 2, models: [], defaultModelId: 'mao_pro' }
  }

  const byId = new Map(registry.models.map((m) => [m.id, m]))
  for (const entry of newEntries) {
    byId.set(entry.id, entry)
  }
  registry.models = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
  registry.version = registry.version ?? 2

  if (dryRun) {
    console.log('\n[dry-run] registry 将新增/更新:', newEntries.map((e) => e.id).join(', '))
    return
  }

  await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8')
  console.log(`\n[registry] 已写入 ${registryPath}（共 ${registry.models.length} 个模型）`)
}

/**
 * 主流程：发现 → 迁移 → 注册。
 */
async function main() {
  const opts = parseArgs(process.argv.slice(2))
  console.log('源目录:', opts.source)
  console.log('目标目录:', opts.dest)
  console.log('模式:', opts.copy ? '复制' : '移动', opts.dryRun ? '(dry-run)' : '')

  const models = await discoverModels(opts.source, opts.only)
  console.log(`\n发现 ${models.length} 个可导入模型\n`)

  if (models.length === 0) {
    console.log('没有可处理的模型，退出。')
    process.exit(0)
  }

  const entries = []
  let migrated = 0
  let skipped = 0

  for (const model of models) {
    const result = await migrateOneModel(model, opts.dest, opts)
    if (result.skipped) {
      skipped++
      if (result.reason === 'exists') {
        const catalog = parseModel3Json(model.model3)
        const fields = buildRegistryFields(model.id, model.model3, catalog)
        entries.push({
          id: model.id,
          modelUrl: `${model.id}/runtime/${model.model3File}`,
          thumbnailUrl: `${model.id}/runtime/icon.png`,
          ...fields,
        })
      }
    } else if (result.entry) {
      entries.push(result.entry)
      migrated++
    } else if (result.dryRun) {
      const catalog = parseModel3Json(model.model3)
      const fields = buildRegistryFields(model.id, model.model3, catalog)
      entries.push({
        id: model.id,
        modelUrl: `${model.id}/runtime/${model.model3File}`,
        thumbnailUrl: `${model.id}/runtime/icon.png`,
        ...fields,
      })
      migrated++
    }
  }

  if (entries.length > 0) {
    await mergeRegistry(opts.dest, entries, opts.dryRun)
  }

  console.log(`\n完成: 处理 ${migrated} 个，跳过 ${skipped} 个（已存在且未 --force）`)
  if (opts.dryRun) console.log('（dry-run：未写入任何文件）')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
