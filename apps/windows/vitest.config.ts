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
      "@mtbot/agent-runtime": workspacePath.agentRuntime,
    },
  },
  test: {
    // 处理 CSS Modules 才会应用上面的 classNameStrategy；默认 false 时样式整体被 stub 掉
    css: { modules: { classNameStrategy: "non-scoped" } },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    setupFiles: ["./src/test/setup.ts"],
    environment: "jsdom",
    globals: true,
  },
});
