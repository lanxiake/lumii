/**
 * 设备像素与 DIP 坐标换算，供 sendInputEvent 点击使用。
 */

/**
 * 将设备像素坐标换算为 DIP（Device Independent Pixels）。
 * Electron `sendInputEvent` 使用 DIP；capturePage 等 API 可能返回设备像素。
 */
export function devicePixelsToDip(devicePixels: number, scaleFactor: number): number {
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
    return devicePixels
  }
  return devicePixels / scaleFactor
}
