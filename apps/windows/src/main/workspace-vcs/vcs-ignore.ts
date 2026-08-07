/**
 * Workspace VCS 默认 .gitignore 规则
 *
 * 工作空间版本管理跟踪用户/Agent 产出（含 outputs/ 下的生成文件），
 * 排除大体积上传二进制、依赖与缓存，避免 isomorphic-git 在大目录上变慢。
 *
 * 注意：outputs/ 故意纳入版本管理；uploads/ 下的大媒体/PDF 默认忽略。
 */

/** 默认忽略条目（每行一条 .gitignore 规则） */
export const DEFAULT_VCS_IGNORE_RULES: readonly string[] = [
  '# Lumii 工作空间版本管理默认忽略规则（自动生成，可手动追加）',
  'node_modules/',
  '.DS_Store',
  'Thumbs.db',
  '*.log',
  // VCS 自身元数据目录（双保险，正常通过独立 gitdir 已隔离）
  '.mtbot-vcs/',
  // 临时与缓存
  'tmp/',
  'temp/',
  '.cache/',
  // 上传的大文件/二进制（按需调整）；outputs/ 生成物不在此列，需纳入版本管理
  'uploads/**/*.zip',
  'uploads/**/*.mp4',
  'uploads/**/*.mov',
  'uploads/**/*.png',
  'uploads/**/*.jpg',
  'uploads/**/*.jpeg',
  'uploads/**/*.gif',
  'uploads/**/*.pdf',
]

/** 生成 .gitignore 文件内容 */
export function buildDefaultGitignore(): string {
  return DEFAULT_VCS_IGNORE_RULES.join('\n') + '\n'
}

/**
 * 若用户本地 .gitignore 误忽略了整个 outputs/，去掉这些规则以恢复跟踪。
 * 只处理明确的 outputs 目录级忽略，不改动其它自定义规则。
 */
export function stripOutputsIgnoreRules(gitignoreContent: string): string {
  const lines = gitignoreContent.split(/\r?\n/)
  const filtered = lines.filter((line) => {
    const t = line.trim()
    if (!t || t.startsWith('#')) return true
    // 目录级：outputs / outputs/ / /outputs/ / outputs/** / outputs/**/*
    return !/^(?:\/)?outputs(?:\/)?$/.test(t) && !/^(?:\/)?outputs\/\*\*(?:\/\*)?$/.test(t)
  })
  return filtered.join('\n')
}

/**
 * 遍历工作树时直接跳过递归的"重目录"名集合。
 *
 * 与上方目录级忽略规则对应：若仅靠 git.isIgnored 逐文件过滤，仍需先递归进
 * node_modules（动辄上万文件）再逐个判断，会在每轮自动快照时阻塞主进程造成卡顿。
 * 在 walk 阶段直接剪枝这些目录，避免无谓的递归与 stat。
 * 注意：不得包含 outputs —— Agent 产出目录需要进入版本管理。
 */
export const VCS_SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git',
  '.mtbot-vcs',
  'node_modules',
  '.cache',
  'tmp',
  'temp',
])

/** 按扩展名判定为二进制，跳过逐行文本 diff（仍纳入 status / commit） */
export const VCS_BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
  '.zip', '.rar', '.7z', '.gz', '.tar', '.bz2',
  '.mp3', '.mp4', '.wav', '.webm', '.mov', '.avi',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.exe', '.dll', '.so', '.dylib',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
])

/** 判断相对路径是否为二进制文件（应跳过文本 diff） */
export function isVcsBinaryPath(filepath: string): boolean {
  const lower = filepath.replace(/\\/g, '/').toLowerCase()
  const base = lower.includes('/') ? lower.slice(lower.lastIndexOf('/') + 1) : lower
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return false
  return VCS_BINARY_EXTENSIONS.has(base.slice(dot))
}