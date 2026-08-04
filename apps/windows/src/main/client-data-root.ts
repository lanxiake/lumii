import os from "node:os";
import path from "node:path";

/** 设计约定：Lumii 独立版客户端数据根目录名（与原 MtBot 产品彻底隔离，避免冲突） */
export const WINDOWS_CLIENT_DATA_DIRNAME = ".lumii";

/**
 * 展开以 ~ 开头的路径为当前用户主目录下的绝对路径。
 */
function expandUserPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    return path.resolve(trimmed.replace(/^~(?=$|[/\\])/, os.homedir()));
  }
  return path.resolve(trimmed);
}

/** 缓存：进程生命周期内数据根不变，避免重复磁盘检查 */
let _cachedRoot: string | undefined;

/**
 * 解析 Windows 桌面客户端数据根目录（用户文件、配置、日志、RFS 设备根等）。
 * 与网关安装目录（见 `src/config/gateway-install-paths.ts`）完全分离。
 *
 * 优先级：`LUMII_CLIENT_DATA_DIR`（自定义覆盖）→ 默认 `~/.lumii`。
 *
 * 结果在进程级别缓存，避免每次调用都做 fs.existsSync 磁盘检查。
 */
export function resolveWindowsClientDataRoot(): string {
  if (_cachedRoot !== undefined) {
    return _cachedRoot;
  }

  const clientEnv = process.env.LUMII_CLIENT_DATA_DIR?.trim();
  if (clientEnv) {
    _cachedRoot = expandUserPath(clientEnv);
    return _cachedRoot;
  }

  _cachedRoot = path.join(os.homedir(), WINDOWS_CLIENT_DATA_DIRNAME);
  return _cachedRoot;
}
