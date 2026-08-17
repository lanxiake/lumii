/**
 * Workspace VCS — 文件系统适配层
 *
 * 为 isomorphic-git 提供 fs 客户端，并对 git index 文件启用「临时文件 + 原子重命名」写入。
 *
 * 原因：isomorphic-git 每次 add/remove 都会整体覆写 index（工作区文件多时该文件可达数百 KB），
 * 若进程在覆写过程中被强杀（开发期 dev:restart、崩溃、关机），磁盘上就会留下截断或零填充的 index，
 * 之后所有 git 操作都会报 `Invalid dircache magic file number`。改为同目录写临时文件再 rename，
 * 同卷 rename 是原子操作，进程随时被杀都只会看到「旧 index」或「新 index」，不会出现半截文件。
 */

import path from 'node:path'
import fsp from 'node:fs/promises'
import type { PromiseFsClient } from 'isomorphic-git'

type WriteFileData = Parameters<typeof fsp.writeFile>[1]
type WriteFileOptions = Parameters<typeof fsp.writeFile>[2]

/** 临时文件后缀，供损坏修复时清理残留 */
export const VCS_TMP_SUFFIX = '.tmp'

/**
 * 原子写入：先写同目录临时文件，再 rename 覆盖目标文件。
 * rename 失败（如被杀毒软件短暂占用）时回退为直接写入，保证功能不受影响。
 */
async function writeFileAtomic(
  filepath: string,
  data: WriteFileData,
  options: WriteFileOptions,
): Promise<void> {
  const tmpPath = `${filepath}.${process.pid}.${Date.now().toString(36)}${VCS_TMP_SUFFIX}`
  try {
    await fsp.writeFile(tmpPath, data, options)
    await fsp.rename(tmpPath, filepath)
    return
  } catch {
    await fsp.rm(tmpPath, { force: true }).catch(() => undefined)
  }
  await fsp.writeFile(filepath, data, options)
}

/**
 * 构造供 isomorphic-git 使用的 fs 客户端：除 index 文件走原子写入外，其余行为与 node:fs/promises 一致。
 *
 * @param indexPath git index 文件的绝对路径（{gitdir}/index）
 */
export function createVcsFs(indexPath: string): PromiseFsClient {
  const normalizedIndexPath = path.resolve(indexPath)

  const writeFile = (
    filepath: string,
    data: WriteFileData,
    options: WriteFileOptions,
  ): Promise<void> =>
    path.resolve(filepath) === normalizedIndexPath
      ? writeFileAtomic(filepath, data, options)
      : fsp.writeFile(filepath, data, options)

  // isomorphic-git 的 PromiseFsClient 类型未声明可选的 rm，此处显式提供以避免其回退到 rmdir 递归删除
  return {
    promises: {
      readFile: fsp.readFile,
      writeFile,
      unlink: fsp.unlink,
      readdir: fsp.readdir,
      mkdir: fsp.mkdir,
      rmdir: fsp.rmdir,
      stat: fsp.stat,
      lstat: fsp.lstat,
      readlink: fsp.readlink,
      symlink: fsp.symlink,
      chmod: fsp.chmod,
      rm: fsp.rm,
    },
  } as unknown as PromiseFsClient
}
