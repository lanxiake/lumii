/**
 * 「现在这只宠物是谁」—— 一个判据，一处实现。
 *
 * ---------------------------------------------------------------------------
 * 为什么值得单独一个文件
 * ---------------------------------------------------------------------------
 * 这段逻辑只有两行（在宠物模式 + 取当前模型 ID → `pet:<模型ID>`），
 * 而它在仓库里被**抄了四份**（`pet-task-service` / `bridge` 两处 /
 * `autonomous-ipc` 的 `subjectAgentId`）。抄出来的东西不会一起改：
 * 哪天"当前宠物"的判据变了（比如宠物模式下允许不选模型而回落默认），
 * 改一处漏三处，症状是**某条链把话记到另一只宠物头上**——不报错，
 * 只是那只宠物的经历里多出一条它没做过的事（与 §3.7 的身份隔离同一个坑）。
 *
 * ---------------------------------------------------------------------------
 * 为什么自带 try-catch
 * ---------------------------------------------------------------------------
 * `getStoredModelId()` 读的是持久化设置，在启动早期 / 退出清场期间可能抛
 * （"Database not initialized"）。原先只有 `autonomous-ipc` 那一处包了 catch，
 * 另外三处靠外层兜。这里统一包起来返回 `null`——**拿不到身份就当"现在没有宠物"**，
 * 这比让调用方各自决定"抛了算什么"更安全：任何一条链拿到 null 都会安静地不做，
 * 而不是拿一个错的 agentId 去写。
 */

import { petAgentId } from '@mtbot/pet-core'
import { isPetMode } from './pet-mode-ipc'
import { getStoredModelId } from './pet-mode-store'

/** agentId 前缀（与 `@mtbot/pet-core` 的 `petAgentId` 同源，这里只为文档可读） */
export function currentPetAgentId(): string | null {
  try {
    if (!isPetMode()) return null
    const configId = getStoredModelId()
    return configId ? petAgentId(configId) : null
  } catch {
    return null
  }
}
