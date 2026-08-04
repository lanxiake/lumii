/**
 * 文件附件策略模式
 *
 * 将不同类型文件（图片、Office 文档、PDF、电子书、代码/文本、音视频、压缩包等）的
 * 处理逻辑封装为独立策略。上传后统一通过 `[media attached: path (fileName)]`
 * 格式注入消息文本，Agent 根据路径读取文件内容。
 *
 * 策略链按顺序匹配，第一个 accepts 的策略处理该文件：
 *   image → office → ebook → data → archive → audio → video → code → fallback
 *
 * 新增格式时只需：
 *   1) 在对应的 EXTENSIONS / MIME 集合中增加扩展名或 MIME
 *   2) 若是全新类别（例如 3D 模型），新增独立 strategy 并追加到 STRATEGY_CHAIN
 */

const logger = {
  debug: (...args: unknown[]) => console.debug('[FileAttachmentStrategy]', ...args),
  warn: (...args: unknown[]) => console.warn('[FileAttachmentStrategy]', ...args),
}

export type AttachmentCategory =
  | 'image'
  | 'office'
  | 'ebook'
  | 'data'
  | 'archive'
  | 'audio'
  | 'video'
  | 'code'
  | 'other'

export interface AttachedFile {
  /** 文件名 */
  fileName: string
  /** 本地绝对路径（Electron File.path） */
  filePath: string
  /** MIME 类型 */
  mimeType: string
  /** 文件大小（字节） */
  size: number
  /** 附件类别，供 UI/后端根据类型渲染或处理 */
  category: AttachmentCategory
}

export interface FileAttachmentStrategy {
  /** 策略名称，用于日志 */
  readonly name: string
  /** 该策略对应的类别 */
  readonly category: AttachmentCategory
  /** 判断该策略是否接受此文件 */
  accepts(file: File): boolean
  /** 将文件转换为 AttachedFile 描述 */
  process(file: File): AttachedFile
}

/** 将 AttachedFile 列表序列化为消息文本中的附件行 */
export function serializeAttachments(files: AttachedFile[]): string {
  return files.map((f) => `[media attached: ${f.filePath} (${f.fileName})]`).join('\n')
}

/** 将附件行追加到消息文本 */
export function appendAttachmentsToMessage(text: string, files: AttachedFile[]): string {
  if (files.length === 0) return text
  const attachmentLines = serializeAttachments(files)
  return text ? `${text}\n${attachmentLines}` : attachmentLines
}

// ---------------------------------------------------------------
// 扩展名与 MIME 集合（按类别分组）
// ---------------------------------------------------------------

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.tiff', '.tif',
  '.ico', '.heic', '.heif', '.avif',
])

const IMAGE_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
  'image/bmp', 'image/tiff', 'image/x-icon', 'image/heic', 'image/heif',
  'image/avif',
])

/** Office / PDF / 常见办公文档 */
const OFFICE_EXTENSIONS = new Set([
  '.pdf',
  '.doc', '.docx', '.rtf', '.odt',
  '.xls', '.xlsx', '.ods',
  '.ppt', '.pptx', '.odp',
  '.pages', '.numbers', '.key',
])

/** 电子书格式 */
const EBOOK_EXTENSIONS = new Set([
  '.epub', '.mobi', '.azw', '.azw3', '.fb2', '.lit', '.lrf',
])

/** 数据集 / 结构化数据 */
const DATA_EXTENSIONS = new Set([
  '.csv', '.tsv', '.parquet', '.arrow', '.feather', '.orc',
  '.jsonl', '.ndjson', '.ipynb',
])

/** 压缩包 / 归档文件 */
const ARCHIVE_EXTENSIONS = new Set([
  '.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.zst',
])

/** 音频 */
const AUDIO_MIME_PREFIX = 'audio/'
const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.opus', '.wma', '.amr',
])

/** 视频 */
const VIDEO_MIME_PREFIX = 'video/'
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v', '.ogv', '.flv', '.wmv',
])

/** 代码 / 纯文本 / 配置 */
const CODE_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.rst', '.log',
  '.json', '.json5', '.yaml', '.yml', '.toml', '.ini', '.env', '.properties',
  '.xml', '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.php', '.pl', '.lua', '.r', '.dart',
  '.go', '.rs', '.java', '.kt', '.swift', '.scala',
  '.c', '.cpp', '.cxx', '.cc', '.h', '.hpp', '.hxx', '.cs', '.m', '.mm',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.sql', '.graphql', '.gql', '.proto',
  '.vue', '.svelte', '.astro',
])

// ---------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------

/** 读取文件扩展名（含点），统一小写；无扩展名返回空串 */
function getExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  return name.slice(dot).toLowerCase()
}

/** Electron 环境下 File 对象上的 path 属性；其它环境退化为文件名 */
function resolvePath(file: File): string {
  return (file as File & { path?: string }).path ?? file.name
}

/** 通用 AttachedFile 构造器 */
function makeAttachedFile(
  file: File,
  category: AttachmentCategory,
  fallbackMime = 'application/octet-stream',
): AttachedFile {
  return {
    fileName: file.name,
    filePath: resolvePath(file),
    mimeType: file.type || fallbackMime,
    size: file.size,
    category,
  }
}

// ---------------------------------------------------------------
// 具体策略实现
// ---------------------------------------------------------------

/** 图片附件策略 */
export const imageAttachmentStrategy: FileAttachmentStrategy = {
  name: 'ImageAttachmentStrategy',
  category: 'image',
  accepts(file: File): boolean {
    if (IMAGE_MIME_TYPES.has(file.type)) return true
    return IMAGE_EXTENSIONS.has(getExtension(file.name))
  },
  process(file: File): AttachedFile {
    return makeAttachedFile(file, 'image', 'image/*')
  },
}

/** Office / PDF 文档策略 */
export const officeAttachmentStrategy: FileAttachmentStrategy = {
  name: 'OfficeAttachmentStrategy',
  category: 'office',
  accepts(file: File): boolean {
    return OFFICE_EXTENSIONS.has(getExtension(file.name))
  },
  process(file: File): AttachedFile {
    return makeAttachedFile(file, 'office')
  },
}

/** 电子书策略 */
export const ebookAttachmentStrategy: FileAttachmentStrategy = {
  name: 'EbookAttachmentStrategy',
  category: 'ebook',
  accepts(file: File): boolean {
    return EBOOK_EXTENSIONS.has(getExtension(file.name))
  },
  process(file: File): AttachedFile {
    return makeAttachedFile(file, 'ebook')
  },
}

/** 数据集策略（CSV/TSV/Parquet/JSONL 等） */
export const dataAttachmentStrategy: FileAttachmentStrategy = {
  name: 'DataAttachmentStrategy',
  category: 'data',
  accepts(file: File): boolean {
    return DATA_EXTENSIONS.has(getExtension(file.name))
  },
  process(file: File): AttachedFile {
    return makeAttachedFile(file, 'data')
  },
}

/** 压缩包策略 */
export const archiveAttachmentStrategy: FileAttachmentStrategy = {
  name: 'ArchiveAttachmentStrategy',
  category: 'archive',
  accepts(file: File): boolean {
    return ARCHIVE_EXTENSIONS.has(getExtension(file.name))
  },
  process(file: File): AttachedFile {
    return makeAttachedFile(file, 'archive')
  },
}

/** 音频策略 */
export const audioAttachmentStrategy: FileAttachmentStrategy = {
  name: 'AudioAttachmentStrategy',
  category: 'audio',
  accepts(file: File): boolean {
    if (file.type.startsWith(AUDIO_MIME_PREFIX)) return true
    return AUDIO_EXTENSIONS.has(getExtension(file.name))
  },
  process(file: File): AttachedFile {
    return makeAttachedFile(file, 'audio')
  },
}

/** 视频策略 */
export const videoAttachmentStrategy: FileAttachmentStrategy = {
  name: 'VideoAttachmentStrategy',
  category: 'video',
  accepts(file: File): boolean {
    if (file.type.startsWith(VIDEO_MIME_PREFIX)) return true
    return VIDEO_EXTENSIONS.has(getExtension(file.name))
  },
  process(file: File): AttachedFile {
    return makeAttachedFile(file, 'video')
  },
}

/** 代码 / 文本 / 配置文件策略 */
export const codeAttachmentStrategy: FileAttachmentStrategy = {
  name: 'CodeAttachmentStrategy',
  category: 'code',
  accepts(file: File): boolean {
    if (CODE_EXTENSIONS.has(getExtension(file.name))) return true
    return file.type.startsWith('text/')
  },
  process(file: File): AttachedFile {
    return makeAttachedFile(file, 'code', 'text/plain')
  },
}

/** 兜底策略：接受所有文件 */
export const fallbackAttachmentStrategy: FileAttachmentStrategy = {
  name: 'FallbackAttachmentStrategy',
  category: 'other',
  accepts(_file: File): boolean {
    return true
  },
  process(file: File): AttachedFile {
    return makeAttachedFile(file, 'other')
  },
}

/** 策略链：按顺序尝试，第一个 accepts 的策略处理文件 */
const STRATEGY_CHAIN: FileAttachmentStrategy[] = [
  imageAttachmentStrategy,
  officeAttachmentStrategy,
  ebookAttachmentStrategy,
  dataAttachmentStrategy,
  archiveAttachmentStrategy,
  audioAttachmentStrategy,
  videoAttachmentStrategy,
  codeAttachmentStrategy,
  fallbackAttachmentStrategy,
]

/** 用策略链处理 FileList，返回 AttachedFile 列表 */
export function processFilesWithStrategies(files: FileList): AttachedFile[] {
  const result: AttachedFile[] = []
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    if (!file) continue
    const strategy = STRATEGY_CHAIN.find((s) => s.accepts(file))
    if (strategy) {
      logger.debug(`[processFilesWithStrategies] ${file.name} 匹配策略: ${strategy.name}`)
      result.push(strategy.process(file))
    } else {
      logger.warn(`[processFilesWithStrategies] ${file.name} 无匹配策略，跳过`)
    }
  }
  return result
}

/** 汇总所有支持的文档扩展名，供 <input accept="..."> 使用 */
export function getSupportedDocumentAccept(): string {
  return [
    ...OFFICE_EXTENSIONS,
    ...EBOOK_EXTENSIONS,
    ...DATA_EXTENSIONS,
    ...ARCHIVE_EXTENSIONS,
    ...AUDIO_EXTENSIONS,
    ...VIDEO_EXTENSIONS,
    ...CODE_EXTENSIONS,
  ].join(',')
}

/** 汇总所有支持的图片 accept，供 <input accept="..."> 使用 */
export function getSupportedImageAccept(): string {
  return [...IMAGE_MIME_TYPES, ...IMAGE_EXTENSIONS].join(',')
}
