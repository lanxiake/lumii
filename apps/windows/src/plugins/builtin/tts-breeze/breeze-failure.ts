/**
 * 从 Breeze 进程的 stderr 尾部判断启动失败原因，决定能不能自动补救。
 *
 * 纯函数，便于测试；补救动作由 breeze-client 执行。
 */
export type BreezeFailureKind =
  | 'missing-module'
  | 'cuda-oom'
  | 'fast-path'
  | 'port-in-use'
  | 'model-broken'
  | 'unknown'

export interface BreezeFailure {
  kind: BreezeFailureKind
  /** missing-module 时对应的 pip 包规格（不在白名单里则为 undefined，不自动装） */
  pipSpec?: string
  module?: string
}

/** 只自动安装这些包：与 installQwenDeps 的版本口径一致，避免装出不兼容的版本 */
const PIP_SPEC_BY_MODULE: Record<string, string> = {
  fastapi: 'fastapi>=0.115',
  starlette: 'fastapi>=0.115',
  uvicorn: 'uvicorn>=0.30',
  multipart: 'python-multipart>=0.0.18',
  python_multipart: 'python-multipart>=0.0.18',
  anyio: 'anyio',
  soundfile: 'soundfile',
  librosa: 'librosa',
  einops: 'einops',
  numpy: 'numpy',
  transformers: 'transformers==4.57.3',
  accelerate: 'accelerate==1.12.0',
  qwen_tts: 'qwen-tts',
}

export function classifyBreezeFailure(stderr: string): BreezeFailure {
  const mod = /No module named ['"]([\w.]+)['"]/.exec(stderr)
  if (mod) {
    const top = mod[1]!.split('.')[0]!
    return { kind: 'missing-module', module: top, pipSpec: PIP_SPEC_BY_MODULE[top] }
  }
  if (/CUDA out of memory|OutOfMemoryError|cudaErrorMemoryAllocation/i.test(stderr)) {
    return { kind: 'cuda-oom' }
  }
  if (/TritonMissing|CUDAGraph|cuda graph|StreamCapture|graph capture|torch\._dynamo|torch\._inductor/i.test(stderr)) {
    return { kind: 'fast-path' }
  }
  if (/error while attempting to bind|Errno 10048|Errno 98|address already in use/i.test(stderr)) {
    return { kind: 'port-in-use' }
  }
  if (/safetensors|Error while deserializing|does not appear to have a file|config\.json|incomplete metadata/i.test(stderr)) {
    return { kind: 'model-broken' }
  }
  return { kind: 'unknown' }
}

/** 给用户看的说明：出了什么事 + 怎么修 */
export function describeBreezeFailure(f: BreezeFailure, tail: string): string {
  switch (f.kind) {
    case 'missing-module':
      return f.pipSpec
        ? `Breeze 缺少 Python 依赖 ${f.module}，自动安装后仍失败。请检查网络后重试，或在「设置 → 语音」重新安装语音运行时`
        : `Breeze 缺少 Python 依赖 ${f.module}。请在「设置 → 语音」重新安装语音运行时`
    case 'cuda-oom':
      return '显存不足，Breeze 无法加载（需要约 10GB 显存）。请关闭其他占用显卡的程序（游戏、其他 AI 服务）后重试'
    case 'fast-path':
      return 'Breeze GPU 加速初始化失败，已退回普通模式仍未成功。请更新显卡驱动后重试'
    case 'port-in-use':
      return 'Breeze 端口被其他程序占用。请在设置里换一个端口后重试'
    case 'model-broken':
      return 'Breeze 模型文件不完整或已损坏。请在「设置 → 语音」删除 Breeze 模型后重新下载'
    default: {
      const last = tail.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' | ').slice(0, 300)
      return `Breeze 服务启动失败${last ? `：${last}` : ''}。可在「设置 → 语音」重新安装语音运行时后重试`
    }
  }
}
