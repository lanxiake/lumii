import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: [],
    // 让 worker 进程带 --experimental-sqlite，使依赖 node:sqlite 的真实 DB 测试可运行
    // （better-sqlite3 原生绑定按 Electron ABI 编译，系统 Node 下无法在 vitest 加载）
    pool: "forks",
    poolOptions: {
      forks: { execArgv: ["--experimental-sqlite"] },
    },
  },
});
