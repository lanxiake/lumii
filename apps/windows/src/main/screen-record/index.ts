/**
 * 录屏模块桶导出
 */
export {
  createScreenRecordService,
  type ScreenRecordService,
  type ScreenRecordServiceDeps,
  type ScreenRecordWriteStream,
} from './screen-record-service'
export { createRealScreenRecordServiceDeps, parseScreenRecordSettings, formatRecordingFilename, markIsLumii } from './real-deps'
export { registerScreenRecordIpc } from './screen-record-ipc'
export { getFreeDiskBytes, extractDriveLetter } from './disk-space'
export { getScreenRecordService, setScreenRecordService } from './accessor'
export { runFfmpeg, webmToMp4 } from './ffmpeg-runner'
