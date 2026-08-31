import { describe, expect, it } from "vitest";
import { ensureWikiVaultLayout } from "./wiki-vault-layout.js";

describe("wiki-vault-layout", () => {
  it("创建一级分区与 meta 文件", () => {
    const dirs = new Set<string>();
    const files = new Map<string, string>();
    const fs = {
      joinPath: (...parts: string[]) => parts.join("/"),
      exists: (p: string) => dirs.has(p) || files.has(p),
      mkdir: (p: string) => dirs.add(p),
      writeFile: (p: string, c: string) => files.set(p, c),
    };
    const result = ensureWikiVaultLayout("/ws/wiki", fs);
    expect(result.vaultRoot).toBe("/ws/wiki");
    // v1.1：目录名不带序号前缀
    expect(dirs.has("/ws/wiki/收件箱")).toBe(true);
    expect(dirs.has("/ws/wiki/归档")).toBe(true);
    expect(dirs.has("/ws/wiki/_parking")).toBe(true);
    // 按 v2 树直接生成「大类/小类」两级
    expect(dirs.has("/ws/wiki/工作")).toBe(true);
    expect(dirs.has("/ws/wiki/工作/项目")).toBe(true);
    expect(dirs.has("/ws/wiki/学习/在学")).toBe(true);
    expect(files.has("/ws/wiki/.lumii/wiki-meta.json")).toBe(true);
    // 旧序号前缀目录不再出现
    expect([...dirs].some((d) => /\/\d\d-/.test(d))).toBe(false);
  });

  it("用户自建大类同样按名建目录，小类名的斜杠被安全化", () => {
    const dirs = new Set<string>();
    const files = new Map<string, string>();
    const fs = {
      joinPath: (...parts: string[]) => parts.join("/"),
      exists: (p: string) => dirs.has(p) || files.has(p),
      mkdir: (p: string) => dirs.add(p),
      writeFile: (p: string, c: string) => files.set(p, c),
    };
    ensureWikiVaultLayout("/ws/wiki", fs, {
      version: 2,
      categories: [{ name: "外部协作", subtopics: ["项目/任务资料"] }],
    });
    expect(dirs.has("/ws/wiki/外部协作")).toBe(true);
    // 斜杠不能凭空造出一层嵌套目录
    expect(dirs.has("/ws/wiki/外部协作/项目_任务资料")).toBe(true);
    expect(dirs.has("/ws/wiki/外部协作/项目/任务资料")).toBe(false);
  });
});
