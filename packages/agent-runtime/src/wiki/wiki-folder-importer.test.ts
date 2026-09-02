/**
 * WikiFolderImporter 单元测试（临时目录 + 真实 fs）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
import { WikiFolderImporter, type WikiFolderImporterFs } from "./wiki-folder-importer.js";
import { WikiIngestHook } from "./wiki-ingest-hook.js";
import { WikiRepo } from "./wiki-repo.js";

/** Node fs 同步适配器 */
const nodeFsAdapter: WikiFolderImporterFs = {
  statSync(p) {
    try {
      const s = fs.statSync(p);
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
    } catch {
      return null;
    }
  },
  readdirSync(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).map((d) => ({
      name: d.name,
      isFile: d.isFile(),
      isDirectory: d.isDirectory(),
    }));
  },
};

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function mkWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-folder-"));
  tmpDirs.push(root);
  fs.mkdirSync(path.join(root, "outputs"), { recursive: true });
  fs.mkdirSync(path.join(root, "wiki"), { recursive: true });
  fs.writeFileSync(path.join(root, "outputs", "a.md"), "# A", "utf8");
  fs.writeFileSync(path.join(root, "outputs", "b.exe"), "bin", "utf8");
  fs.writeFileSync(path.join(root, "outputs", "script.py"), "print(1)", "utf8");
  fs.writeFileSync(path.join(root, "wiki", "x.md"), "x", "utf8");
  return root;
}

describe("WikiFolderImporter", () => {
  it("scan 列出可导入文件并跳过未知扩展名", () => {
    const root = mkWorkspace();
    const repo = new WikiRepo(createMigratedTestDb());
    const hook = new WikiIngestHook(repo);
    const importer = new WikiFolderImporter(repo, hook, nodeFsAdapter);
    const result = importer.scan({
      agentId: "ag",
      userId: "u",
      dir: path.join(root, "outputs"),
      recursive: true,
      workspaceRoot: root,
    });

    expect(result.summary.importable).toBe(1);
    expect(result.candidates.find((c) => c.title === "a.md")?.skipReason).toBeNull();
    expect(result.candidates.find((c) => c.title === "b.exe")?.skipReason).toBe("ignored:extension");
    expect(result.candidates.find((c) => c.title === "script.py")?.skipReason).toBe("ignored:code-or-script");
  });

  it("scan 不进入 wiki/ 目录", () => {
    const root = mkWorkspace();
    const repo = new WikiRepo(createMigratedTestDb());
    const hook = new WikiIngestHook(repo);
    const importer = new WikiFolderImporter(repo, hook, nodeFsAdapter);
    const result = importer.scan({
      agentId: "ag",
      userId: "u",
      dir: root,
      recursive: true,
      workspaceRoot: root,
    });
    expect(result.candidates.some((c) => c.title === "x.md")).toBe(false);
  });

  it("import 写入 inbox 并跳过已在 Wiki 的路径", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-folder-"));
    tmpDirs.push(root);
    fs.mkdirSync(path.join(root, "outputs"), { recursive: true });
    const repo = new WikiRepo(createMigratedTestDb());
    const hook = new WikiIngestHook(repo);
    hook.ingestOutput("ag", "u", "outputs/existing.md", "existing.md");
    fs.writeFileSync(path.join(root, "outputs", "existing.md"), "old", "utf8");
    fs.writeFileSync(path.join(root, "outputs", "new.md"), "new", "utf8");

    const importer = new WikiFolderImporter(repo, hook, nodeFsAdapter);
    const r = importer.import({
      agentId: "ag",
      userId: "u",
      dir: path.join(root, "outputs"),
      workspaceRoot: root,
    });

    expect(r.imported).toBe(1);
    expect(r.inboxIds).toHaveLength(1);
    expect(repo.listInbox("ag", "u", "pending").some((i) => i.title === "new.md")).toBe(true);
  });

  it("资料删除后 scan 不再把原路径当成已在 Wiki", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-folder-"));
    tmpDirs.push(root);
    fs.mkdirSync(path.join(root, "outputs"), { recursive: true });
    fs.writeFileSync(path.join(root, "outputs", "课本.pdf"), "pdf", "utf8");
    const repo = new WikiRepo(createMigratedTestDb());
    const hook = new WikiIngestHook(repo);
    const importer = new WikiFolderImporter(repo, hook, nodeFsAdapter);
    const opts = {
      agentId: "ag",
      userId: "u",
      dir: path.join(root, "outputs"),
      workspaceRoot: root,
    };

    const first = importer.import(opts);
    expect(first.imported).toBe(1);
    const inbox = repo.listInbox("ag", "u", "pending")[0]!;
    const source = repo.createSource({
      agentId: "ag",
      userId: "u",
      title: inbox.title,
      sourcePath: inbox.source_path ?? undefined,
    });
    repo.markInboxOrganized(inbox.id, source.id);
    expect(importer.scan(opts).summary.importable).toBe(0);

    repo.deleteSources("ag", "u", [source.id]);
    expect(importer.scan(opts).summary.alreadyInWiki).toBe(0);
    expect(importer.scan(opts).summary.importable).toBe(1);
  });
});
