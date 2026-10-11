/**
 * zip 解压（宠物包等资源用）。
 *
 * 用 `jszip`（已是运行时依赖）：几十 MB 的包一次性读入内存可接受，且不必引入新依赖。
 * **解析越界路径**：zip 里的相对路径若靠 `..` 指到目标目录之外，直接拒绝（防 zip-slip）。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'

/**
 * 解压 `zipPath` 到 `destDir`（覆盖同名文件，自动建目录）。
 */
export async function extractZip(zipPath: string, destDir: string): Promise<void> {
  const buf = await fs.readFile(zipPath)
  const zip = await JSZip.loadAsync(buf)
  const root = path.resolve(destDir)
  for (const [rel, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    const out = path.resolve(root, rel)
    // 防 zip-slip：解析后的绝对路径必须落在 root 之内
    if (out !== root && !out.startsWith(root + path.sep)) {
      throw new Error(`zip 内含越界路径：${rel}`)
    }
    await fs.mkdir(path.dirname(out), { recursive: true })
    await fs.writeFile(out, await entry.async('nodebuffer'))
  }
}
