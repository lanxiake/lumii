/**
 * 浏览器产物落盘接口（注入式）。
 *
 * `/screenshot`、`/pdf`、labels 快照路由产出的是内存 Buffer，需要宿主提供落盘实现；
 * 包内不假设任何目录约定，由宿主在启动浏览器服务时通过 setBrowserMediaStore 注入。
 * 未注入时这些路由返回 "media store not available"。
 */

export interface BrowserMediaStore {
  /** 确保落盘目录存在 */
  ensureMediaDir(): Promise<void>;
  /**
   * 保存媒体缓冲，返回绝对或相对文件路径。
   * `maxBytes` 为调用方给出的体积上限（截图路径已在保存前压缩到限内）。
   */
  saveMediaBuffer(
    buffer: Buffer,
    mime: string,
    prefix: string,
    maxBytes: number,
  ): Promise<{ path: string }>;
}

let mediaStore: BrowserMediaStore | null = null;

/** 注入宿主落盘实现；传 null 清除 */
export function setBrowserMediaStore(store: BrowserMediaStore | null): void {
  mediaStore = store;
}

/** 取当前落盘实现（未注入返回 null） */
export function getBrowserMediaStore(): BrowserMediaStore | null {
  return mediaStore;
}
