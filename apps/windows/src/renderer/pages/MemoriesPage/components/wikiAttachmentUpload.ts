/**
 * wikiAttachmentUpload — Wiki 编辑器拖拽上传的文件分类与导入逻辑
 *
 * 复用 ChatInput 的 file-attachment-strategy 分类函数与既有 files:import 通道
 * （设计 §10.3：接口隔离，只复用分类函数而非组件）。
 */
import { processFilesWithStrategies } from '../../ChatPage/utils/file-attachment-strategy'
import { serializeAttachmentReference } from '@mtbot/agent-runtime/browser'

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      resolve(result.split(',')[1] ?? '')
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

const CATEGORY_TO_MEDIA_TYPE: Record<string, 'document' | 'image' | 'audio' | 'video'> = {
  image: 'image',
  audio: 'audio',
  video: 'video',
}

export interface WikiUploadedAttachment {
  readonly filePath: string
  readonly mediaType: 'document' | 'image' | 'audio' | 'video'
  readonly displayName: string
  readonly referenceLine: string
}

/** 上传一批拖入的文件，返回可插入正文的引用行与附件元信息 */
export async function uploadFilesForWikiAttachment(
  files: FileList,
): Promise<readonly WikiUploadedAttachment[]> {
  const attached = processFilesWithStrategies(files)
  const results: WikiUploadedAttachment[] = []

  for (let i = 0; i < attached.length; i++) {
    const a = attached[i]!
    const file = files[i]
    try {
      const hasPath = a.filePath && a.filePath !== a.fileName
      const payload: Record<string, unknown> = {
        type: 'files:import',
        userId: 'local-user',
        fileName: a.fileName,
        mimeType: a.mimeType,
      }
      if (hasPath) {
        payload.sourcePath = a.filePath
      } else if (file) {
        payload.fileBuffer = await readFileAsBase64(file)
      }
      const result = (await window.electronAPI?.agentRuntime?.sendCommand(payload)) as { absPath: string }
      const mediaType = CATEGORY_TO_MEDIA_TYPE[a.category] ?? 'document'
      results.push({
        filePath: result.absPath,
        mediaType,
        displayName: a.fileName,
        referenceLine: serializeAttachmentReference(result.absPath, a.fileName),
      })
    } catch (err) {
      console.error('[wikiAttachmentUpload] 上传失败:', a.fileName, err)
    }
  }
  return results
}
