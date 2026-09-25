// 临时：从 floaty 拼条裁第 12 格（视频尾段=回到首帧尺度的那一拍，
// 之前 auto-pick 的 07 格在飘行中段、模型把角色画大了 26%）
import sharp from 'sharp'
const strip = 'C:/Users/75791/.lumii/workspace/outputs/pet-motion/moonrabbit-pose-floaty/f0000.png'
const out = 'C:/Users/75791/.lumii/workspace/outputs/pet-motion/moonrabbit-pose-floaty/pick-12.png'
const m = await sharp(strip).metadata()
const cw = Math.floor(m.width / 16)
await sharp(strip).extract({ left: 12 * cw, top: 0, width: cw, height: m.height }).png().toFile(out)
console.log(`✓ 第 12 格 → ${out}（${cw}×${m.height}）`)
