/**
 * 宠物资产协议的 scheme 名。
 *
 * 核心要在启动期注册这类 scheme 的特权（`protocol-schemes.ts`），插件要注册 handler——
 * 两边都得知道这个名字，所以放 shared，而不是让核心 import 插件的实现。
 */
export const PET_ASSET_SCHEME = 'lumii-pet'
