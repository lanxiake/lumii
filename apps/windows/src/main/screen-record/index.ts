/**
 * 录屏模块桶导出
 */
export {
  createScreenRecordService,
  type ScreenRecordService,
} from './screen-record-service'
export { createRealScreenRecordServiceDeps, parseScreenRecordSettings } from './real-deps'
export { registerScreenRecordIpc } from './screen-record-ipc'
