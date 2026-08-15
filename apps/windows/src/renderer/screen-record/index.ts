/**
 * 渲染进程录屏采集桶导出
 */
export { ScreenRecordCapture, type ScreenRecordCaptureDeps, type ScreenRecordCaptureIpc } from './ScreenRecordCapture'
export {
  mixMicIntoDestination,
  pickSupportedMime,
  splitBlobToChunks,
  arrayBufferToBase64,
} from './mix-audio-tracks'
