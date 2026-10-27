/**
 * 解析真 git `--progress` 的 stderr 行（需 LC_ALL=C）。
 *
 * 典型形态：
 *   Receiving objects:  45% (1234/2700), 12.50 MiB | 2.10 MiB/s
 *   Writing objects: 100% (1320/1320), 5.20 MiB | 1.50 MiB/s, done.
 *
 * git 用 `\r` 原地刷新同一行；调用方应先按 `\r`/`\n` 拆段再逐段解析。
 */
import type { SyncTransferProgress } from '../../../../shared/cloud-sync'

/** 体积单位 → 字节（git 近年多用 MiB；兼容 KB/MB/GB 与 KiB/GiB） */
const UNIT_TO_BYTES: Record<string, number> = {
  b: 1,
  byte: 1,
  bytes: 1,
  kb: 1000,
  kib: 1024,
  mb: 1000 ** 2,
  mib: 1024 ** 2,
  gb: 1000 ** 3,
  gib: 1024 ** 3,
}

/**
 * 把 "12.50 MiB" / "2.10 MiB/s" 转成字节（或字节每秒）。
 * @returns 无法识别时返回 undefined
 */
export function parseGitSizeToken(token: string): number | undefined {
  const m = /^\s*([\d.]+)\s*([A-Za-z]+)\s*$/.exec(token.trim())
  if (!m) return undefined
  const n = Number(m[1])
  if (!Number.isFinite(n) || n < 0) return undefined
  const unit = m[2].toLowerCase()
  const mul = UNIT_TO_BYTES[unit]
  if (!mul) return undefined
  return Math.round(n * mul)
}

/**
 * 从单行（或 `\r` 刷新段）解析传输进度。
 * @returns 非进度行返回 null
 */
export function parseGitProgressLine(
  line: string,
  direction: SyncTransferProgress['direction'],
): SyncTransferProgress | null {
  const text = line.replace(/\x1b\[[0-9;]*m/g, '').trim()
  if (!text) return null

  // Counting/Compressing/Resolving 也报百分比，但没有可靠吞吐；仍展示阶段与百分比
  const m =
    /^(Receiving objects|Writing objects|Counting objects|Compressing objects|Resolving deltas):\s+(\d+)%(?:\s+\((\d+)\/(\d+)\))?(?:,\s*([\d.]+\s*[A-Za-z]+))?(?:\s*\|\s*([\d.]+\s*[A-Za-z]+\/s))?/i.exec(
      text,
    )
  if (!m) return null

  const phase = m[1]
  const percent = Number(m[2])
  const objDone = m[3] ? Number(m[3]) : undefined
  const objTotal = m[4] ? Number(m[4]) : undefined
  const sizeToken = m[5]
  const speedToken = m[6]

  const transferredBytes = sizeToken ? parseGitSizeToken(sizeToken) : undefined
  let speedBytesPerSec: number | undefined
  if (speedToken) {
    const bare = speedToken.replace(/\/s$/i, '').trim()
    speedBytesPerSec = parseGitSizeToken(bare)
  }

  let totalBytes: number | undefined
  if (
    transferredBytes != null &&
    percent > 0 &&
    percent < 100 &&
    Number.isFinite(percent)
  ) {
    totalBytes = Math.round(transferredBytes / (percent / 100))
  } else if (transferredBytes != null && percent === 100) {
    totalBytes = transferredBytes
  }

  let etaSeconds: number | undefined
  if (
    totalBytes != null &&
    transferredBytes != null &&
    speedBytesPerSec != null &&
    speedBytesPerSec > 0 &&
    totalBytes > transferredBytes
  ) {
    etaSeconds = Math.ceil((totalBytes - transferredBytes) / speedBytesPerSec)
  } else if (
    objDone != null &&
    objTotal != null &&
    objTotal > objDone &&
    speedBytesPerSec != null &&
    speedBytesPerSec > 0 &&
    transferredBytes != null &&
    objDone > 0
  ) {
    // 无可靠 totalBytes 时，用对象比例粗估剩余字节
    const estTotal = Math.round((transferredBytes / objDone) * objTotal)
    etaSeconds = Math.ceil((estTotal - transferredBytes) / speedBytesPerSec)
    totalBytes = estTotal
  }

  return {
    direction,
    phase,
    percent: Number.isFinite(percent) ? percent : undefined,
    transferredBytes,
    totalBytes,
    speedBytesPerSec,
    etaSeconds,
  }
}

/**
 * 从 stderr chunk 中取出最新一段可解析的进度。
 * git 常用 `\r` 刷新；同一 chunk 可能含多段，取最后成功解析的一条。
 */
export function parseGitProgressChunk(
  chunk: string,
  direction: SyncTransferProgress['direction'],
): SyncTransferProgress | null {
  const parts = chunk.split(/[\r\n]+/).filter((p) => p.trim())
  let last: SyncTransferProgress | null = null
  for (const part of parts) {
    const parsed = parseGitProgressLine(part, direction)
    if (parsed) last = parsed
  }
  return last
}
