/**
 * 将帧序列合成视频（ffmpeg -framerate -i frames/frame-%06d.jpg）
 */
import path from 'node:path'
import { runFfmpeg } from '../../../../main/ffmpeg-runner'

export interface FramesToVideoParams {
  /** 帧序列目录（含 frame-000000.jpg, frame-000001.jpg...） */
  framesDir: string
  /** 输出视频路径（.mp4） */
  outputPath: string
  /** 帧率（与录制时的 fps 一致） */
  fps: number
  /** 视频编码质量（CRF 18-28，默认 23） */
  crf?: number
}

/**
 * 将帧序列合成为 MP4 视频
 *
 * 命令示例：
 * ffmpeg -framerate 10 -i frames/frame-%06d.jpg \
 *   -c:v libx264 -preset fast -crf 23 \
 *   -pix_fmt yuv420p -movflags +faststart output.mp4
 */
export async function framesToVideo(
  params: FramesToVideoParams,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const inputPattern = path.join(params.framesDir, 'frame-%06d.jpg')
  const crf = params.crf ?? 23

  return runFfmpeg([
    '-framerate',
    String(params.fps),
    '-i',
    inputPattern,
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    String(crf),
    '-pix_fmt',
    'yuv420p', // 兼容性（部分播放器需要）
    '-movflags',
    '+faststart',
    params.outputPath,
  ])
}
