/**
 * Browser control service - simplified for browser-control package.
 * Uses external ResolvedBrowserConfig instead of loadConfig().
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveProfile, type ResolvedBrowserConfig } from "./config.js";
import { ensureChromeExtensionRelayServer } from "./extension-relay.js";
import { type BrowserServerState, createBrowserRouteContext } from "./server-context.js";

let state: BrowserServerState | null = null;
const log = createSubsystemLogger("browser");
const logService = log.child("service");

export function getBrowserControlState(): BrowserServerState | null {
  return state;
}

export function createBrowserControlContext() {
  return createBrowserRouteContext({
    getState: () => state,
  });
}

/**
 * Start browser control service with external config.
 * Windows client calls this with buildWindowsBrowserConfig().
 */
export async function startBrowserControlServer(
  resolved: ResolvedBrowserConfig,
): Promise<BrowserServerState | null> {
  if (state) {
    return state;
  }

  if (!resolved.enabled) {
    return null;
  }

  state = {
    server: null,
    port: resolved.controlPort,
    resolved,
    profiles: new Map(),
  };

  // If any profile uses the Chrome extension relay, start the local relay server eagerly
  // so the extension can connect before the first browser action.
  for (const name of Object.keys(resolved.profiles)) {
    const profile = resolveProfile(resolved, name);
    if (!profile || profile.driver !== "extension") {
      continue;
    }
    await ensureChromeExtensionRelayServer({ cdpUrl: profile.cdpUrl }).catch((err) => {
      logService.warn(`Chrome extension relay init failed for profile "${name}": ${String(err)}`);
    });
  }

  logService.info(
    `Browser control service ready (profiles=${Object.keys(resolved.profiles).length})`,
  );
  return state;
}

export async function stopBrowserControlService(): Promise<void> {
  const current = state;
  if (!current) {
    return;
  }

  const ctx = createBrowserRouteContext({
    getState: () => state,
  });

  try {
    for (const name of Object.keys(current.resolved.profiles)) {
      try {
        await ctx.forProfile(name).stopRunningBrowser();
      } catch {
        // ignore
      }
    }
  } catch (err) {
    logService.warn(`mtbot browser stop failed: ${String(err)}`);
  }

  state = null;

  // Optional: Playwright is not always available (e.g. embedded gateway builds).
  try {
    const mod = await import("./pw-ai.js");
    await mod.closePlaywrightBrowserConnection();
  } catch {
    // ignore
  }
}
