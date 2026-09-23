import sharp from 'sharp'
import fs from 'node:fs'
const dir = process.argv[2]
const out = process.argv[3]
const atlas = JSON.parse(fs.readFileSync(`${dir}/atlas.json`, 'utf8'))
const names = process.argv.slice(4)
fs.mkdirSync(out, { recursive: true })
for (const n of names) {
  const fr = atlas.frames[n].frame
  await sharp(`${dir}/atlas.png`).extract({ left: fr.x, top: fr.y, width: fr.w, height: fr.h }).png().toFile(`${out}/${n}.png`)
  console.log(`${out}/${n}.png  ${fr.w}x${fr.h}`)
}
