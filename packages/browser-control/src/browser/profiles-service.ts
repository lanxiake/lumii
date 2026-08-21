/**
 * Profile 只读查询服务。
 *
 * createProfile / deleteProfile 已随 Gateway 配置层一并移除：两者依赖
 * loadConfig / writeConfigFile / MtBotConfig / deriveDefaultBrowserCdpPortRange，
 * 这些符号在移除 Gateway 后已不存在，且本包不再自行读写配置文件
 * （profile 由宿主构造并注入 ResolvedBrowserConfig）。
 * 如需恢复动态增删 profile，须先为宿主设计新的持久化层。
 */
import type { BrowserRouteContext, ProfileStatus } from "./server-context.js";

export function createBrowserProfilesService(ctx: BrowserRouteContext) {
  const listProfiles = async (): Promise<ProfileStatus[]> => {
    return await ctx.listProfiles();
  };

  return {
    listProfiles,
  };
}
