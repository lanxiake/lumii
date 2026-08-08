/**
 * 从源视频生成开机画面 splash.mp4（上下各裁掉 8%，保留中间 84%），并抽取首帧海报 splash-poster.jpg
 * 用法: node scripts/prepare-splash.cjs [source.mp4]
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const OUT_DIR = path.resolve(__dirname, '../assets')
const DEFAULT_SRC = path.join(OUT_DIR, 'source', 'logo-splash-src.mp4')
const OUT = path.join(OUT_DIR, 'splash.mp4')
const POSTER_OUT = path.join(OUT_DIR, 'splash-poster.jpg')

/**
 * 运行 ffmpeg，失败则退出进程
 */
function runFfmpeg(ffmpegPath, args, label) {
  const r = spawnSync(ffmpegPath, args, { encoding: 'utf8' })
  if (r.status !== 0) {
    console.error(`[prepare-splash] ${label} 失败`)
    console.error(r.stderr?.slice(-1000))
    process.exit(r.status || 1)
  }
}

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
  runFfmpeg(
    ffmpegPath,
    [
      '-y',
      '-i',
      src,
      // 上下各裁 8%：起点 y=ih*0.08，高度 ih*0.84
      '-vf',
      'crop=iw:ih*0.84:0:ih*0.08',
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
    '编码 splash.mp4',
  )
  console.log('[prepare-splash] wrote', OUT, fs.statSync(OUT).size, 'bytes')

  // 从成品视频抽首帧作海报，避免 React 挂载前纯黑屏
  runFfmpeg(
    ffmpegPath,
    ['-y', '-i', OUT, '-vf', 'select=eq(n\\,0)', '-vframes', '1', '-q:v', '3', POSTER_OUT],
    '抽取 splash-poster.jpg',
  )
  console.log('[prepare-splash] wrote', POSTER_OUT, fs.statSync(POSTER_OUT).size, 'bytes')
}

main()
