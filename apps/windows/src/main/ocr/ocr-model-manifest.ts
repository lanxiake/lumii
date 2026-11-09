/**
 * OCR 模型与运行时发行物清单（Task 0）。
 *
 * 模型：PP-OCRv4 mobile 中英（HuggingFace SWHL/RapidOCR）。
 * ORT：utility 子进程私有安装，与主进程 sherpa 1.27 / E5 1.14 隔离。
 */

/** 模型包版本目录名 */
export const OCR_MODEL_PACKAGE_ID = 'ppocr-v4-mobile-zh-en' as const

/** 相对用户数据根的模型目录：`models/ocr/<packageId>` */
export const OCR_MODEL_RELATIVE_DIR = `models/ocr/${OCR_MODEL_PACKAGE_ID}`

/** 相对用户数据根的 ORT 运行时目录（utility 私有） */
export const OCR_ORT_RUNTIME_RELATIVE_DIR = 'runtimes/ocr/onnxruntime-node'

/** 就绪标记文件名 */
export const OCR_MODEL_COMPLETE_MARKER = '.lumii-complete'

/** HuggingFace 模型仓库（经镜像拉取） */
export const OCR_HF_REPO = 'SWHL/RapidOCR'

/** 默认 HF 镜像（与 wiki/voice 一致） */
export const DEFAULT_OCR_HF_MIRROR = 'https://hf-mirror.com'

/**
 * PP-OCRv4 mobile 文件清单。
 * sha256 在首次可信下载后固化；未知时为空串，下载器只校验体积下限。
 */
export type OcrModelFileSpec = {
  /** 包内相对路径（HF resolve 路径） */
  remotePath: string
  /** 落盘文件名 */
  localName: string
  /** 已知字节数（护栏；缺省不校验） */
  sizeBytes?: number
  /** sha256 hex；空表示尚未钉死，仅做存在性检查 */
  sha256: string
}

/**
 * det / rec / 字典。cls（方向分类）首版可选，省略以减体积与耗时。
 */
export const OCR_MODEL_FILES: readonly OcrModelFileSpec[] = [
  {
    remotePath: 'PP-OCRv4/ch_PP-OCRv4_det_infer.onnx',
    localName: 'det.onnx',
    sizeBytes: 4_750_000,
    sha256: '',
  },
  {
    remotePath: 'PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx',
    localName: 'rec.onnx',
    sizeBytes: 10_900_000,
    sha256: '',
  },
  {
    // 字典随 RapidOCR 仓；若路径漂移由下载器多源回退
    remotePath: 'PP-OCRv4/ppocr_keys_v1.txt',
    localName: 'ppocr_keys_v1.txt',
    sizeBytes: 20_000,
    sha256: '',
  },
] as const

/** 本地模型目录内必备文件名 */
export const OCR_REQUIRED_LOCAL_FILES = ['det.onnx', 'rec.onnx', 'ppocr_keys_v1.txt'] as const

/**
 * utility 使用的 onnxruntime-node 目标版本。
 * 与主进程 E5 的 1.14、sherpa 自带 1.27 均解耦；仅在子进程加载。
 */
export const OCR_ORT_NODE_VERSION = '1.22.0'

/**
 * 构造 HF 镜像上的模型文件 URL。
 */
export function buildOcrModelFileUrl(mirrorBase: string, remotePath: string): string {
  const base = mirrorBase.replace(/\/$/, '')
  return `${base}/${OCR_HF_REPO}/resolve/main/${remotePath}`
}

/**
 * GitHub Release 备用源（eSearch-OCR ch 包思路；首版以 HF 为主）。
 * 完整 zip 解压映射留给下载器实现。
 */
export const OCR_MODEL_GITHUB_FALLBACK = {
  repo: 'xushengfeng/eSearch-OCR',
  tag: '4.0.0',
  asset: 'ch.zip',
} as const
