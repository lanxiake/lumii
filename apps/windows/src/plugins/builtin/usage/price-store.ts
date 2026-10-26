/**
 * 用户自定义模型价格的落盘。
 *
 * 落在 `~/.lumii/usage/prices.json`（跟用量记录同一个目录，因为它是「怎么算花费」的一部分）。
 * 形状 `{ [模型前缀]: ModelPriceInput }`，与内置表同一口径（大小写不敏感的最长前缀）。
 *
 * 为什么不用 SQLite：整张表就是几十行、只做「整表读写」，一个 JSON 文件足够了。
 * 为什么在插件的 store 旁边而不是主进程：价格只被用量计算消费，归属地就跟着用量走。
 *
 * 读失败/写坏一律当空表：价格是**可选覆盖**，读不到就退回内置表，
 * 不能因为一个坏文件让用量面板打不开。
 */

import fs from 'node:fs'
import path from 'node:path'
import { resolveWindowsClientDataRoot } from '../../../main/client-data-root'
import {
  getPriceOverrides,
  setPriceOverrides,
  type ModelPriceInput,
} from '../../../shared/model-pricing'

const log = {
  warn: (...a: unknown[]) => console.warn('[UsagePriceStore]', ...a),
}

export function priceOverridesPath(): string {
  return path.join(resolveWindowsClientDataRoot(), 'usage', 'prices.json')
}

/**
 * 启动时载入一次（幂等）：把磁盘上的自定义价灌进 `model-pricing` 的内存单例。
 *
 * 必须在任何 `queryUsage` / `recordUsage` 之前调用，否则第一屏花费会用内置价算出来，
 * 跟用户填的价对不上。插件 apply 里第一时间调用。
 */
export function loadPriceOverrides(filePath = priceOverridesPath()): void {
  try {
    if (!fs.existsSync(filePath)) {
      setPriceOverrides({})
      return
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    setPriceOverrides(parsed)
  } catch (err) {
    log.warn(`自定义价格读取失败，按内置价目表继续（${filePath}）：`, err)
    setPriceOverrides({})
  }
}

/**
 * 整表写回（同时更新内存）。写盘失败**不抛**：内存里那份仍然生效，
 * 只是重启会丢——记 warn 让人看得见。
 */
export function savePriceOverrides(
  raw: unknown,
  filePath = priceOverridesPath(),
): Record<string, ModelPriceInput> {
  setPriceOverrides(raw)
  const current = getPriceOverrides()
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const tmp = `${filePath}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`, 'utf-8')
    fs.renameSync(tmp, filePath)
  } catch (err) {
    log.warn(`自定义价格写盘失败（本次运行内仍生效）：${filePath}`, err)
  }
  return current
}

/** 读当前生效的自定义价（内存视角，含尚未落盘的改动） */
export function readPriceOverrides(): Record<string, ModelPriceInput> {
  return getPriceOverrides()
}
