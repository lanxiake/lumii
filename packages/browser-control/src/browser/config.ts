/**
 * Browser configuration types and utilities.
 * Simplified version for browser-control package (no Gateway loadConfig dependency).
 *
 * Windows client provides its own config via buildWindowsBrowserConfig().
 */

// ============================================================================
// Type Definitions
// ============================================================================

export type BrowserProfileConfig = {
  cdpPort?: number;
  cdpUrl?: string;
  driver?: "direct" | "extension";
  color?: string;
};

export type ResolvedBrowserProfile = {
  name: string;
  cdpPort?: number;
  cdpUrl: string;
  cdpIsLoopback: boolean;
  driver: "direct" | "extension";
  color: string;
};

export type ResolvedBrowserConfig = {
  enabled: boolean;
  evaluateEnabled: boolean;
  controlPort: number;
  cdpProtocol: "http" | "https";
  cdpHost: string;
  cdpIsLoopback: boolean;
  remoteCdpTimeoutMs: number;
  remoteCdpHandshakeTimeoutMs: number;
  color: string;
  executablePath: string | undefined;
  headless: boolean;
  noSandbox: boolean;
  attachOnly: boolean;
  defaultProfile: string;
  profiles: Record<string, BrowserProfileConfig>;
};

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_MTBOT_BROWSER_PROFILE_NAME = "mtbot";
export const DEFAULT_BROWSER_DEFAULT_PROFILE_NAME = "chrome";
export const DEFAULT_MTBOT_BROWSER_COLOR = "#4285F4";
export const DEFAULT_MTBOT_BROWSER_ENABLED = false;
export const DEFAULT_BROWSER_EVALUATE_ENABLED = false;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Parse and validate an HTTP(S) URL string.
 * Returns the parsed URL, port number, and normalized URL string.
 */
export function parseHttpUrl(raw: string, label: string) {
  const trimmed = raw.trim();
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must be http(s), got: ${parsed.protocol.replace(":", "")}`);
  }

  const port =
    parsed.port && Number.parseInt(parsed.port, 10) > 0
      ? Number.parseInt(parsed.port, 10)
      : parsed.protocol === "https:"
        ? 443
        : 80;

  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`${label} has invalid port: ${parsed.port}`);
  }

  return {
    parsed,
    port,
    normalized: parsed.toString().replace(/\/$/, ""),
  };
}

/**
 * Resolve a profile by name from the config.
 * Returns null if the profile doesn't exist.
 */
export function resolveProfile(
  resolved: ResolvedBrowserConfig,
  profileName: string,
): ResolvedBrowserProfile | null {
  const profile = resolved.profiles[profileName];
  if (!profile) {
    return null;
  }

  const isExtension = profile.driver === "extension";
  const cdpUrl = profile.cdpUrl ?? `http://127.0.0.1:${profile.cdpPort ?? 0}`;
  let cdpIsLoopback = resolved.cdpIsLoopback;
  try {
    const parsed = new URL(cdpUrl);
    const host = parsed.hostname.toLowerCase();
    cdpIsLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    // 若 URL 解析失败，回退到全局配置，避免中断启动流程。
  }

  return {
    name: profileName,
    cdpPort: profile.cdpPort,
    cdpUrl,
    cdpIsLoopback,
    driver: isExtension ? "extension" : "direct",
    color: profile.color ?? resolved.color,
  };
}
