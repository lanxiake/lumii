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
// 生成线工具链（P1）：切分 / 地线对齐 / 打包
export * from './slice.js'
export * from './align.js'
export * from './pack.js'
export * from './toolchain.js'
// 生成契约（出图提示词 + 底色推导）
export * from './sheet-prompt.js'
// 出图质量闸门（切图之前判：是不是同一只角色、是不是一段动作、底色安不安全）
export * from './sheetcheck.js'
// 差分取层（把「只改了眼睛」的表情批抠成图层）
export * from './difflayer.js'
