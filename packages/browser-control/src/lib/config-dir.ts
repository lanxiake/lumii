import os from "node:os";
import path from "node:path";

/**
 * Resolve the configuration directory for mtbot.
 * Simplified version for browser-control package (no Gateway dependencies).
 */
export function resolveConfigDir(): string {
  const override = process.env.MTBOT_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  if (override) {
    return override;
  }

  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(home, ".mtbot");
  }
  return path.join(home, ".mtbot");
}

/**
 * Configuration root; can be overridden via MTBOT_STATE_DIR.
 */
export const CONFIG_DIR = resolveConfigDir();
