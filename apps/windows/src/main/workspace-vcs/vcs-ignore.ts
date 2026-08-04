/**
 * Workspace VCS 默认 .gitignore 规则
 *
 * 工作空间版本管理只关心用户/Agent 产生的文本内容（SOUL.md / USER.md / skills 等），
 * 排除大体积、易变、无版本价值的目录与二进制，避免 isomorphic-git 在大目录上变慢。
 */

/** 默认忽略条目（每行一条 .gitignore 规则） */
export const DEFAULT_VCS_IGNORE_RULES: readonly string[] = [
  '# Mtbot 工作空间版本管理默认忽略规则（自动生成，可手动追加）',
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
  // 上传的大文件/二进制（按需调整）
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
 * 遍历工作树时直接跳过递归的"重目录"名集合。
 *
 * 与上方目录级忽略规则对应：若仅靠 git.isIgnored 逐文件过滤，仍需先递归进
 * node_modules（动辄上万文件）再逐个判断，会在每轮自动快照时阻塞主进程造成卡顿。
 * 在 walk 阶段直接剪枝这些目录，避免无谓的递归与 stat。
 */
export const VCS_SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git',
  '.mtbot-vcs',
  'node_modules',
  '.cache',
  'tmp',
  'temp',
])
