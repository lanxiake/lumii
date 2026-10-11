/**
 * 把「移出随包」的宠物打成 zip（供客户端按需下载）。
 *
 * 每只宠物一个包：`pet-<id>.zip`，内含
 *   <id>/**         模型资源（与内置目录同布局）
 *   entry.json      builtin registry 里该条的**原样副本**（modelUrl 前缀就是 <id>/，
 *                   用户目录同布局，条目可直接并入用户 registry.json）
 *
 * 产物：resources/pet-models/dist/pet-<id>.zip（不入库，见 .gitignore）
 * 用法：node scripts/pack-pet-zips.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

const WINDOWS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(WINDOWS_ROOT, 'resources', 'pet-models')
const OUT = path.join(SRC, 'dist')
/** 与 main/plugins/builtin.ts 的 PET_PLUGIN_IDS 保持一致 */
const IDS = ['demo_cartoon_cat', 'ug_official', 'xiaomai']

/**
 * 把目录递归加入 zip，条目名带 `prefix/` 前缀。
 */
function addDir(zip, dir, prefix) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    const rel = `${prefix}/${name}`
    if (fs.statSync(full).isDirectory()) addDir(zip, full, rel)
    else zip.file(rel, fs.readFileSync(full))
  }
}

async function main() {
  const registry = JSON.parse(fs.readFileSync(path.join(SRC, 'registry.json'), 'utf-8'))
  fs.mkdirSync(OUT, { recursive: true })

  for (const id of IDS) {
    const dir = path.join(SRC, id)
    if (!fs.existsSync(dir)) {
      console.warn(`[pack-pet-zips] 跳过：目录不存在 ${dir}`)
      continue
    }
    const entry = registry.models.find((m) => m.id === id)
    if (!entry) {
      throw new Error(`registry.json 里找不到 ${id} 的条目——移出随包前必须先有它`)
    }
    const zip = new JSZip()
    addDir(zip, dir, id)
    zip.file('entry.json', `${JSON.stringify(entry, null, 2)}\n`)
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    const out = path.join(OUT, `pet-${id}.zip`)
    fs.writeFileSync(out, buf)
    console.log(`[pack-pet-zips] ${path.relative(WINDOWS_ROOT, out)}（${(buf.length / 1048576).toFixed(1)} MB）`)
  }
}

try {
  await main()
} catch (err) {
  console.error(`[pack-pet-zips] 失败：${err instanceof Error ? err.message : err}`)
  process.exit(1)
}
