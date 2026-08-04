/**
 * @mtbot/browser-control
 *
 * Browser automation and control module for MtBot.
 * Used by Windows client for local browser control.
 */

// Core types and config
export * from "./browser/config.js";

// Control service
export {
  startBrowserControlServer,
  stopBrowserControlService,
  getBrowserControlState,
  createBrowserControlContext,
} from "./browser/control-service.js";

// Server context
export {
  createBrowserRouteContext,
  type BrowserServerState,
  type BrowserRouteContext,
} from "./browser/server-context.js";

// Chrome management
export {
  isChromeReachable,
  resolveMtBotUserDataDir,
  type RunningChrome,
} from "./browser/chrome.js";

// Playwright session
export {
  getPageForTargetId,
  ensurePageState,
  closePlaywrightBrowserConnection,
  type BrowserConsoleMessage,
  type BrowserPageError,
  type BrowserNetworkRequest,
} from "./browser/pw-session.js";

// Extension relay
export { ensureChromeExtensionRelayServer } from "./browser/extension-relay.js";

// Routes dispatcher
export { createBrowserRouteDispatcher } from "./browser/dispatcher.js";
