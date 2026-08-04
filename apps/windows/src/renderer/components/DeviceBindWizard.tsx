/**
 * DeviceBindWizard - 设备绑定向导（已弃用弹窗流程）
 *
 * 设备绑定与 Gateway 连接改由主进程 gateway-auto-connect 在登录/启动后自动完成。
 * 保留空组件以免破坏 App 装配；如需手动操作请前往「设备管理」页。
 */

import React from 'react'

/** 占位组件：自动绑定已在主进程处理，不再弹出引导 */
export const DeviceBindWizard: React.FC = () => null

export default DeviceBindWizard
