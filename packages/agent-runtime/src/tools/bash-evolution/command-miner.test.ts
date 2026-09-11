/**
 * CommandPatternMiner 单测 — 归一化 / 聚合 / 过滤
 */

import { describe, expect, it } from "vitest";
import {
  hasDedicatedTool,
  mineCommandPatterns,
  normalizeCommand,
  selectHighValuePatterns,
  splitCommandChain,
  type CommandSample,
} from "./command-miner.js";

function samples(count: number, command: string, opts: { error?: boolean; day?: string } = {}): CommandSample[] {
  return Array.from({ length: count }, () => ({
    command,
    isError: opts.error ?? false,
    durationMs: 100,
    createdAt: opts.day ?? "2026-09-08T10:00:00.000Z",
  }));
}

describe("splitCommandChain", () => {
  it("按 && / || / ; / 换行拆分", () => {
    expect(splitCommandChain("cd dir && pnpm build; ls\nnode x.js || exit 1")).toEqual([
      "cd dir",
      "pnpm build",
      "ls",
      "node x.js",
      "exit 1",
    ]);
  });

  it("空白与空段被剔除", () => {
    expect(splitCommandChain("  echo hi  \n\n ")).toEqual(["echo hi"]);
  });
});

describe("normalizeCommand", () => {
  it("引号内容抽象为 {{string}}，git 消息位单独抽象为 {{msg}}", () => {
    expect(normalizeCommand(`git commit -m "fix the bug"`)).toBe("git commit -m {{msg}}");
    expect(normalizeCommand(`echo 'hello world'`)).toBe("echo {{string}}");
  });

  it("路径抽象为 {{path}}（Windows / POSIX / 相对）", () => {
    expect(normalizeCommand("cd C:\\projects\\foo")).toBe("cd {{path}}");
    expect(normalizeCommand("cat /home/user/a.txt")).toBe("cat {{path}}");
    expect(normalizeCommand("rm ./dist/out.js")).toBe("rm {{path}}");
  });

  it("数字参数抽象为 {{num}}，不碰标识符内数字", () => {
    expect(normalizeCommand("sleep 5")).toBe("sleep {{num}}");
    expect(normalizeCommand("pnpm --filter pkg2 build")).toBe("pnpm --filter pkg2 build");
  });

  it("带扩展名的文件 token 抽象为 {{path}}（含相对路径段）", () => {
    expect(normalizeCommand("node scripts/build.js")).toBe("node {{path}}");
    expect(normalizeCommand("git diff package.json")).toBe("git diff {{path}}");
  });

  it("不同参数的同一操作收敛到同一模式", () => {
    const a = normalizeCommand(`pnpm --filter ./apps/windows test --run script1.ts`);
    const b = normalizeCommand(`pnpm --filter ./apps/windows test --run script2.ts`);
    expect(a).toBe(b);
  });
});

describe("hasDedicatedTool", () => {
  it("已有专用工具的命令返回 true", () => {
    expect(hasDedicatedTool("cat {{path}}")).toBe(true);
    expect(hasDedicatedTool("grep -r {{string}} {{path}}")).toBe(true);
    expect(hasDedicatedTool("find . -name {{string}}")).toBe(true);
    expect(hasDedicatedTool("mkdir -p {{path}}")).toBe(true);
  });

  it("无专用工具的命令返回 false", () => {
    expect(hasDedicatedTool("pnpm --filter {{path}} build")).toBe(false);
    expect(hasDedicatedTool("git push origin main")).toBe(false);
  });
});

describe("mineCommandPatterns", () => {
  const base: CommandSample[] = [
    ...samples(8, `pnpm --filter ./apps/windows test --run a.ts`),
    ...samples(8, `pnpm --filter ./apps/windows test --run b.ts`),
    ...samples(6, `git commit -m "wip 1"`, { day: "2026-09-07T08:00:00.000Z" }),
    ...samples(6, `git commit -m "wip 2"`, { day: "2026-09-07T08:00:00.000Z" }),
    ...samples(2, `cat docs/readme.md`),
  ];

  it("聚合同一模式并统计", () => {
    const [top] = mineCommandPatterns(base);
    expect(top?.pattern).toBe("pnpm --filter {{path}} test --run {{path}}");
    expect(top?.count).toBe(16);
    expect(top?.errorRate).toBe(0);
    expect(top?.samples.length).toBeGreaterThan(0);
  });

  it("错误率优先排序：高错误率模式排前", () => {
    const input: CommandSample[] = [
      ...samples(6, `npx vitest run --coverage`, { error: true }),
      ...samples(10, `pnpm run build:release`),
    ];
    const [first, second] = mineCommandPatterns(input, { minSamples: 5 });
    expect(first?.pattern).toBe("npx vitest run --coverage");
    expect(first?.errorRate).toBe(1);
    expect(second?.pattern).toBe("pnpm run build:release");
  });

  it("过滤：样本不足 / 模式过短 / 已有专用工具", () => {
    const input: CommandSample[] = [
      ...samples(3, `pnpm --filter pkg-x release:deploy`), // 样本不足
      ...samples(9, `ls -la`), // 有专用工具且短
      ...samples(9, `cat notes/a.md`), // 有专用工具
    ];
    const result = mineCommandPatterns(input, { minSamples: 5 });
    expect(result).toHaveLength(0);
  });

  it("distinctDays 按日期去重统计", () => {
    const input: CommandSample[] = [
      ...samples(4, `node scripts/cron-job.js --config prod`, { day: "2026-09-06T10:00:00.000Z" }),
      ...samples(4, `node scripts/cron-job.js --config prod`, { day: "2026-09-07T10:00:00.000Z" }),
    ];
    const [p] = mineCommandPatterns(input, { minSamples: 5 });
    expect(p?.count).toBe(8);
    expect(p?.distinctDays).toBe(2);
  });
});

describe("selectHighValuePatterns", () => {
  it("只保留 count>100 并按次数降序取 Top N", () => {
    const patterns = [
      {
        pattern: "pnpm --filter {{path}} build",
        count: 150,
        errorCount: 0,
        errorRate: 0,
        avgDurationMs: 1000,
        distinctDays: 3,
        samples: ["pnpm --filter ./a build"],
      },
      {
        pattern: "git commit -m {{msg}}",
        count: 120,
        errorCount: 1,
        errorRate: 0.01,
        avgDurationMs: 200,
        distinctDays: 2,
        samples: ['git commit -m "x"'],
      },
      {
        pattern: "npx vitest run {{path}}",
        count: 100,
        errorCount: 0,
        errorRate: 0,
        avgDurationMs: 500,
        distinctDays: 2,
        samples: ["npx vitest run a.ts"],
      },
      {
        pattern: "node {{path}}",
        count: 80,
        errorCount: 0,
        errorRate: 0,
        avgDurationMs: 100,
        distinctDays: 1,
        samples: ["node a.js"],
      },
    ];
    const selected = selectHighValuePatterns(patterns, { minCountExclusive: 100, topN: 5 });
    expect(selected.map((p) => p.pattern)).toEqual([
      "pnpm --filter {{path}} build",
      "git commit -m {{msg}}",
    ]);
    expect(selected.every((p) => p.count > 100)).toBe(true);
  });

  it("超过 topN 时截断", () => {
    const patterns = Array.from({ length: 8 }, (_, i) => ({
      pattern: `cmd-${i} --flag {{path}}`,
      count: 200 - i,
      errorCount: 0,
      errorRate: 0,
      avgDurationMs: null,
      distinctDays: 2,
      samples: [`cmd-${i} --flag ./x`],
    }));
    const selected = selectHighValuePatterns(patterns, { minCountExclusive: 100, topN: 5 });
    expect(selected).toHaveLength(5);
    expect(selected[0]?.count).toBe(200);
    expect(selected[4]?.count).toBe(196);
  });
});
