/**
 * @mtbot/pet-asset —— 宠物素材工具链
 *
 * 以 CLI 为主要形态（`pet-asset`），同时导出程序化 API，
 * 供未来客户端主进程直接调用（免去再起一个进程）。
 *
 * 判断逻辑全部在 @mtbot/pet-core，本包负责读盘、跑 sharp、落盘。
 */

export * from './paths.js'
export * from './image.js'
export * from './cutout.js'
export * from './io.js'
export * from './commands.js'
