import fs from 'node:fs'
import path from 'node:path'
import { resolveScreenshotTempDir } from '../workspace-paths'

/**
 * 返回截图临时目录绝对路径。
 * 生产：`{当前工作空间}/temp/screenshots`（缺失自动创建）。
 * @param testRoot 仅测试：在给定根下使用 `temp/screenshots`，便于隔离
 */
export function getScreenshotTempDir(testRoot?: string): string {
  if (testRoot) {
    return path.join(testRoot, 'temp', 'screenshots')
  }
  return resolveScreenshotTempDir()
}

/**
 * 应用启动时清空截图临时目录并重建空目录。
 * 目录级清空，避免历史截图累积占用磁盘。
 *
 * ## 为什么不是直接 rmSync（2026-09-20 改）
 *
 * 原实现是 `rmSync(dir, { recursive: true, force: true })` —— **同步递归删除，
 * 跑在主线程上**。实测（`fs.rmSync`，每文件 100KB）：
 *
 * | 文件数 | 总大小 | 耗时 |
 * | --- | --- | --- |
 * | 2000 | 195MB | 277ms |
 * | 5000 | 488MB | 699ms |
 * | 10000 | 977MB | **1565ms** |
 *
 * 而用户积累的截图完全可能到一万量级。启动时这一下就是**秒级主线程阻塞**——
 * 冻结现场捕获器实测到这里：`unlink@native` 占总样本 61%（约 1.4 秒），
 * 同窗口采样覆盖率只有 4%（主线程不在 JS 里）。
 * 见 docs/fix/2026-09-20-主进程冻结调查与修复.md。
 *
 * ## 现在的做法：rename + 后台删
 *
 * 1. 目录**整体改名**（毫秒级）—— 原目录瞬间从原位置消失，语义与"清空"等价；
 * 2. 立刻建新的空目录；
 * 3. 真正的删除丢到后台（`fs.promises.rm`），**耗时与文件数无关地移出主线程**；
 * 4. 顺带清掉上次遗留的 trash（后台删失败或进程被杀时留下的）。
 *
 * 之所以不直接改成"异步删除原目录"：那样在新目录建好与旧文件删完之间，
 * 若用户立刻截图，可能被误删。先改名则不存在这个窗口。
 */
export function clearScreenshotTempDir(testRoot?: string): void {
  const dir = getScreenshotTempDir(testRoot)

  let trash: string | null = null
  try {
    if (fs.existsSync(dir)) {
      trash = `${dir}.trash-${Date.now()}`
      fs.renameSync(dir, trash)
    }
  } catch {
    // 改名失败（占用等）：退回直接建目录，旧内容留待下次启动清
    trash = null
  }
  fs.mkdirSync(dir, { recursive: true })

  if (trash) {
    void fs.promises.rm(trash, { recursive: true, force: true }).catch(() => {})
  }
  purgeStaleScreenshotTrash(dir)
}

/**
 * 清掉历史遗留的 `*.trash-*` 目录。
 *
 * 只做 `readdirSync`（读目录列表，与文件数无关地快），删除仍走异步 ——
 * 否则又会把删除成本搬回主线程。
 */
function purgeStaleScreenshotTrash(dir: string): void {
  const parent = path.dirname(dir)
  const base = path.basename(dir)
  let entries: string[]
  try {
    entries = fs.readdirSync(parent)
  } catch {
    return
  }
  for (const name of entries) {
    if (!name.startsWith(`${base}.trash-`)) continue
    void fs.promises
      .rm(path.join(parent, name), { recursive: true, force: true })
      .catch(() => {})
  }
}
