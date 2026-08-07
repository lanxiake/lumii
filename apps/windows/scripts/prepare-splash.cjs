/**
 * 从源视频生成开机画面 splash.mp4（裁掉下方 12%）
 * 用法: node scripts/prepare-splash.cjs [source.mp4]
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const OUT_DIR = path.resolve(__dirname, '../assets')
const DEFAULT_SRC = path.join(OUT_DIR, 'source', 'logo-splash-src.mp4')
const OUT = path.join(OUT_DIR, 'splash.mp4')

function main() {
  const src = path.resolve(process.argv[2] || DEFAULT_SRC)
  if (!fs.existsSync(src)) {
    console.error('找不到源视频:', src)
    process.exit(1)
  }
  let ffmpegPath
  try {
    ffmpegPath = require('@ffmpeg-installer/ffmpeg').path
  } catch {
    console.error('请安装 @ffmpeg-installer/ffmpeg（devDependency）')
    process.exit(1)
  }

  console.log('[prepare-splash] src =', src)
  console.log('[prepare-splash] ffmpeg =', ffmpegPath)
  const r = spawnSync(
    ffmpegPath,
    [
      '-y',
      '-i',
      src,
      '-vf',
      'crop=iw:ih*0.88:0:0',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '20',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      OUT,
    ],
    { encoding: 'utf8' },
  )
  if (r.status !== 0) {
    console.error(r.stderr?.slice(-1000))
    process.exit(r.status || 1)
  }
  console.log('[prepare-splash] wrote', OUT, fs.statSync(OUT).size, 'bytes')
}

main()
