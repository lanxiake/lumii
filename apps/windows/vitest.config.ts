import { defineConfig } from "vitest/config";
import { appPath, workspacePath } from "./paths";

export default defineConfig({
  resolve: {
    alias: {
      // 支持 @/ 路径别名
      // 键带末尾斜杠时值也必须带：path.resolve 会剥掉末尾斜杠，
      // 而别名是前缀字符串替换，"@shared/" -> ".../src/shared" 会拼成 sharedmcp-presets
      "@/": appPath.src + "/",
      "@main/": appPath.main + "/",
      "@renderer/": appPath.renderer + "/",
      "@shared/": appPath.shared + "/",
      // 注意不要带末尾斜杠：path.resolve 会剥掉它，前缀替换后会拼成 assetslogo.png
      "@app-assets": appPath.assets,
      "@mtbot/agent-runtime/browser": workspacePath.agentRuntimeBrowser,
      "@mtbot/agent-runtime/shared": workspacePath.agentRuntimeShared,
      "@mtbot/agent-runtime": workspacePath.agentRuntime,
    },
  },
  test: {
    // 处理 CSS Modules 才会应用上面的 classNameStrategy；默认 false 时样式整体被 stub 掉
    css: { modules: { classNameStrategy: "non-scoped" } },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    /**
     * 限制并行 fork 数。
     *
     * 2026-11-02 实测：默认按 CPU 核数（本机 16）铺满时，全量 5259 条测试**每轮**
     * 都会挂一条，而且是**随机换着挂**——三次分别挂在 `local-bash-hang-settle`
     * （3716ms 撞 3000ms 的时间断言）、`pet-asset-ipc`（临时目录 install 拿不到
     * installedDir）、`workbench-comments`（`EPERM: rename ... .tmp -> .json`）。
     * 三条单跑都稳定通过。
     *
     * 共同点是**满载下的文件系统与调度竞争**：多个 fork 同时 rename 同一个文件、
     * 同时抢临时目录、同时让事件循环延迟。Windows 上 `rename` 到已被占用的目标
     * 直接 EPERM，不像 POSIX 那样原子替换。
     *
     * 限到 6 个 fork 后全量 exit=0（166s，比满载的 130-160s 只慢一点点）。
     * 别为了「跑得更快」把上限调回去——省下的几十秒换来的是每轮都有一条假红，
     * 而假红会让人开始忽略门禁，那比慢更贵。
     */
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: 6,
      },
    },
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    setupFiles: ["./src/test/setup.ts"],
    environment: "jsdom",
    globals: true,
  },
});
