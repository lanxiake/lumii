/**
 * 生成**发布清单** `wechat-toolkits.json` —— 四个小工具 `--check-update` 要读的那个文件。
 *
 * **为什么需要它**：四个产品的版本各自独立（不像 App 有统一的 `v<App版本>` tag），
 * 从 release 的 tag 推不出产品版本。所以在 release 里放一份小清单，客户端读它。
 * 路径固定为 `releases/latest/download/wechat-toolkits.json`（见 mcp_install.MANIFEST_URL）。
 *
 * 用法：`node scripts/build-wechat-toolkits-manifest.mjs`
 * 产物：`resources/dist/wechat-toolkits.json`（根 `.gitignore` 覆盖 `dist/`）
 *
 * 发一次新版要**两步，缺一不可**：
 *   1. 跑本脚本（构建完四个 exe 之后）
 *   2. 把四个 exe **和**这份 json 一起挂到 GitHub release 的 assets 上
 *
 * 只做第 1 步不做第 2 步的话，`--check-update` 会**如实说"拿不到版本清单"**，
 * 不会谎报"已是最新"——这是有意的（见 mcp_install.do_check_update）。
 *
 * 版本号唯一来源是各产品 `server.py` 的 `SERVER_VERSION`（与 exe 内嵌的一致）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WINDOWS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RES_DIR = path.join(WINDOWS_ROOT, 'resources')
const OUT_DIR = path.join(RES_DIR, 'dist')

const PRODUCTS = [
  'wechat-file-mcp',
  'wechat-export-mcp',
  'wechat-recall-mcp',
  'wechat-crm-mcp',
]

function readVersion(product) {
  const src = fs.readFileSync(path.join(RES_DIR, product, 'server.py'), 'utf-8')
  const m = src.match(/^SERVER_VERSION\s*=\s*"([^"]+)"/m)
  if (!m) throw new Error(`${product}/server.py 里找不到 SERVER_VERSION`)
  return m[1]
}

function main() {
  const manifest = {}
  const missing = []
  for (const product of PRODUCTS) {
    const exe = path.join(RES_DIR, product, 'dist', `${product}.exe`)
    if (!fs.existsSync(exe)) {
      missing.push(product)
      continue
    }
    manifest[product] = {
      version: readVersion(product),
      asset: `${product}.exe`,
      bytes: fs.statSync(exe).size,
    }
  }
  if (missing.length) {
    // 清单指向一个不存在的产物等于骗人，宁可不生成
    console.error(`缺 exe（先构建）：${missing.join(', ')}`)
    process.exit(1)
  }
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const out = path.join(OUT_DIR, 'wechat-toolkits.json')
  fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
  console.log(`[manifest] 产物：${out}`)
  for (const [k, v] of Object.entries(manifest)) {
    console.log(`  ${k.padEnd(20)} v${v.version}  ${(v.bytes / 1048576).toFixed(1)}MB`)
  }
}

main()
