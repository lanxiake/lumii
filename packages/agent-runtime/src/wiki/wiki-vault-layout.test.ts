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
    expect(dirs.has("/ws/wiki/00-收件箱")).toBe(true);
    expect(dirs.has("/ws/wiki/01-工作")).toBe(true);
    expect(dirs.has("/ws/wiki/_parking")).toBe(true);
    expect(files.has("/ws/wiki/.lumii/wiki-meta.json")).toBe(true);
  });
});
