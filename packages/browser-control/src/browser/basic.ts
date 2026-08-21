import { resolveBrowserExecutableForPlatform } from "./chrome.executables.js";
import { createBrowserProfilesService } from "./profiles-service.js";
import type { BrowserRouteContext } from "./server-context.js";
import { getProfileContext, jsonError, toStringOrEmpty } from "./utils.js";
import type { BrowserRouteRegistrar } from "./types.js";

export function registerBrowserBasicRoutes(app: BrowserRouteRegistrar, ctx: BrowserRouteContext) {
  // List all profiles with their status
  app.get("/profiles", async (_req, res) => {
    try {
      const service = createBrowserProfilesService(ctx);
      const profiles = await service.listProfiles();
      res.json({ profiles });
    } catch (err) {
      jsonError(res, 500, String(err));
    }
  });

  // Get status (profile-aware)
  app.get("/", async (req, res) => {
    let current: ReturnType<typeof ctx.state>;
    try {
      current = ctx.state();
    } catch {
      return jsonError(res, 503, "browser server not started");
    }

    const profileCtx = getProfileContext(req, ctx);
    if ("error" in profileCtx) {
      return jsonError(res, profileCtx.status, profileCtx.error);
    }

    const [cdpHttp, cdpReady] = await Promise.all([
      profileCtx.isHttpReachable(300),
      profileCtx.isReachable(600),
    ]);

    const profileState = current.profiles.get(profileCtx.profile.name);
    let detectedBrowser: string | null = null;
    let detectedExecutablePath: string | null = null;
    let detectError: string | null = null;

    try {
      const detected = resolveBrowserExecutableForPlatform(current.resolved, process.platform);
      if (detected) {
        detectedBrowser = detected.kind;
        detectedExecutablePath = detected.path;
      }
    } catch (err) {
      detectError = String(err);
    }

    res.json({
      enabled: current.resolved.enabled,
      profile: profileCtx.profile.name,
      running: cdpReady,
      cdpReady,
      cdpHttp,
      pid: profileState?.running?.pid ?? null,
      cdpPort: profileCtx.profile.cdpPort,
      cdpUrl: profileCtx.profile.cdpUrl,
      chosenBrowser: profileState?.running?.exe.kind ?? null,
      detectedBrowser,
      detectedExecutablePath,
      detectError,
      userDataDir: profileState?.running?.userDataDir ?? null,
      color: profileCtx.profile.color,
      headless: current.resolved.headless,
      noSandbox: current.resolved.noSandbox,
      executablePath: current.resolved.executablePath ?? null,
      attachOnly: current.resolved.attachOnly,
    });
  });

  // Start browser (profile-aware)
  app.post("/start", async (req, res) => {
    const profileCtx = getProfileContext(req, ctx);
    if ("error" in profileCtx) {
      return jsonError(res, profileCtx.status, profileCtx.error);
    }

    try {
      await profileCtx.ensureBrowserAvailable();
      res.json({ ok: true, profile: profileCtx.profile.name });
    } catch (err) {
      jsonError(res, 500, String(err));
    }
  });

  // Stop browser (profile-aware)
  app.post("/stop", async (req, res) => {
    const profileCtx = getProfileContext(req, ctx);
    if ("error" in profileCtx) {
      return jsonError(res, profileCtx.status, profileCtx.error);
    }

    try {
      const result = await profileCtx.stopRunningBrowser();
      res.json({
        ok: true,
        stopped: result.stopped,
        profile: profileCtx.profile.name,
      });
    } catch (err) {
      jsonError(res, 500, String(err));
    }
  });

  // Reset profile (profile-aware)
  app.post("/reset-profile", async (req, res) => {
    const profileCtx = getProfileContext(req, ctx);
    if ("error" in profileCtx) {
      return jsonError(res, profileCtx.status, profileCtx.error);
    }

    try {
      const result = await profileCtx.resetProfile();
      res.json({ ok: true, profile: profileCtx.profile.name, ...result });
    } catch (err) {
      jsonError(res, 500, String(err));
    }
  });

  // POST /profiles/create 与 DELETE /profiles/:name 已移除：
  // 二者依赖随 Gateway 一并删除的配置持久化层，无法工作。
  // profile 现由宿主构造并注入 ResolvedBrowserConfig。
}
