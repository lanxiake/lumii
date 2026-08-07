import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // 让 gateway-client.ts 中的根项目 protocol import 正确解析
      "../../../../src/": path.resolve(__dirname, "../../src/"),
      // 支持 @/ 路径别名
      "@/": path.resolve(__dirname, "./src/"),
      "@main/": path.resolve(__dirname, "./src/main/"),
      "@renderer/": path.resolve(__dirname, "./src/renderer/"),
      "@shared/": path.resolve(__dirname, "./src/shared/"),
      // 注意不要带末尾斜杠：path.resolve 会剥掉它，前缀替换后会拼成 assetslogo.png
      "@app-assets": path.resolve(__dirname, "assets"),
    },
  },
  test: {
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
