/**
 * Stub for src/utils.ts (CONFIG_DIR only)
 * Windows 客户端使用客户端数据根（默认 ~/.lumii）
 * 已重构：使用 paths.ts 模块中的 resolveClientStateDir
 */
import { resolveClientStateDir } from '../paths'

export const CONFIG_DIR = process.env.MTBOT_STATE_DIR?.trim() || resolveClientStateDir()
