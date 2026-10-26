import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  recordTurnPreState,
  recordTurnTouchedPath,
  recordTurnTouchedFilePath,
  clearTurnTouchedPaths,
  beginStandaloneTurn,
  collectResultTouchedPaths,
  collectToolEvidence,
  resolveTurnFileChanges,
} from "./turn-touched-paths";

const tempDirs: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumii-touched-"));
  tempDirs.push(dir);
  return dir;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("turn-touched-paths", () => {
  beforeEach(() => {
    clearTurnTouchedPaths("A");
    clearTurnTouchedPaths("B");
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("只保留本实例登记过的路径，其他实例/后台改动直接丢弃", async () => {
    const cwd = makeWorkspace();
    recordTurnTouchedPath("A", "file_write", { filePath: "outputs/a.txt" }, cwd);
    recordTurnTouchedPath("B", "file_write", { filePath: "outputs/b.txt" }, cwd);

    const diff = [
      { path: "outputs/a.txt", status: "added" as const },
      { path: "outputs/b.txt", status: "added" as const },
      { path: "outputs/unclaimed.txt", status: "modified" as const },
    ];

    expect(await resolveTurnFileChanges("A", diff, cwd)).toEqual([
      { path: "outputs/a.txt", status: "added", confidence: "exact", sourceTool: "file_write" },
    ]);
  });

  it("并发子 Agent 的写入只归子回合，不会串进父会话", async () => {
    clearTurnTouchedPaths("parent");
    clearTurnTouchedPaths("child");
    const cwd = makeWorkspace();
    recordTurnTouchedPath("child", "file_write", { filePath: "outputs/child.png" }, cwd);
    // 父回合的 diff 同时看到了子 Agent 的产物与后台噪声
    const parentDiff = [
      { path: "outputs/child.png", status: "added" as const },
      { path: "outputs/noise.png", status: "added" as const },
    ];

    expect(await resolveTurnFileChanges("parent", parentDiff, cwd)).toEqual([]);
    expect(await resolveTurnFileChanges("child", parentDiff, cwd)).toEqual([
      {
        path: "outputs/child.png",
        status: "added",
        confidence: "exact",
        sourceTool: "file_write",
      },
    ]);
  });

  it("bash 命令里点名的路径算本会话产物，并记下来源工具", async () => {
    const cwd = makeWorkspace();
    const diff = [
      { path: "outputs/report.txt", status: "added" as const },
      { path: "outputs/other.txt", status: "modified" as const },
    ];
    const evidence = collectToolEvidence(
      "bash",
      { command: "printf 'ok' > outputs/report.txt" },
      "written",
    );

    expect(await resolveTurnFileChanges("A", diff, cwd, { evidence: [evidence!] })).toEqual([
      { path: "outputs/report.txt", status: "added", confidence: "exact", sourceTool: "bash" },
    ]);
  });

  it("bash 命令点名目录时，目录下的产物整批归属", async () => {
    const cwd = makeWorkspace();
    const diff = [
      { path: "uploads/短剧/第一集/shot-01.png", status: "added" as const },
      { path: "uploads/短剧/第一集/shot-02.png", status: "added" as const },
      { path: "uploads/短剧/第二集/shot-01.png", status: "added" as const },
    ];
    const evidence = collectToolEvidence(
      "bash",
      { command: "node gen.mjs --out-dir uploads/短剧/第一集" },
      "",
    );

    const resolved = await resolveTurnFileChanges("A", diff, cwd, { evidence: [evidence!] });
    expect(resolved.map((entry) => entry.path)).toEqual([
      "uploads/短剧/第一集/shot-01.png",
      "uploads/短剧/第一集/shot-02.png",
    ]);
    expect(resolved.every((entry) => entry.sourceTool === "bash")).toBe(true);
  });

  it("目录名相近不会被前缀误伤，Windows 分隔符与大小写也能匹配", async () => {
    const cwd = makeWorkspace();
    const diff = [
      { path: "Uploads/Ep01/a.png", status: "added" as const },
      { path: "uploads/ep01-extra/b.png", status: "added" as const },
    ];
    const evidence = collectToolEvidence(
      "bash",
      { command: "cp in.png .\\uploads\\ep01\\a.png" },
      "",
    );

    const resolved = await resolveTurnFileChanges("A", diff, cwd, { evidence: [evidence!] });
    expect(resolved).toEqual([
      { path: "Uploads/Ep01/a.png", status: "added", confidence: "exact", sourceTool: "bash" },
    ]);
  });

  it("路径左侧粘连的其他目录名不算命中", async () => {
    const cwd = makeWorkspace();
    const diff = [{ path: "outputs/report.txt", status: "added" as const }];
    const evidence = collectToolEvidence(
      "bash",
      { command: "cp backupoutputs/report.txt outputs/report.txt" },
      "",
    );

    // 证据里虽含 "outputs/report.txt"，但它是 backupoutputs/ 的后缀；仅凭目录命中规则
    // 也不能把 outputs/ 整体吞掉（目录 token 是 outputs，命令里并没有独立出现它）
    const resolved = await resolveTurnFileChanges("A", diff, cwd, { evidence: [evidence!] });
    expect(resolved.map((entry) => entry.path)).toEqual(["outputs/report.txt"]);
    // 反向用例：只提 backupoutputs/ 时不能把 outputs/ 下的文件吸进来
    const wrong = collectToolEvidence("bash", { command: "cat backupoutputs/report.txt" }, "");
    expect(await resolveTurnFileChanges("A", diff, cwd, { evidence: [wrong!] })).toEqual([]);
  });

  it("bash 输出里出现的路径同样可作为证据", async () => {
    const cwd = makeWorkspace();
    const diff = [{ path: "outputs/final.mp4", status: "added" as const }];
    const evidence = collectToolEvidence("bash", { command: "python render.py" }, "saved to outputs/final.mp4");

    expect(await resolveTurnFileChanges("A", diff, cwd, { evidence: [evidence!] })).toEqual([
      { path: "outputs/final.mp4", status: "added", confidence: "exact", sourceTool: "bash" },
    ]);
  });

  it("技能工具的命令文本同样可作为证据", async () => {
    const cwd = makeWorkspace();
    const diff = [
      { path: "outputs/skill-out/result.md", status: "added" as const },
      { path: "outputs/other/result.md", status: "added" as const },
    ];
    const evidence = collectToolEvidence(
      "execute_skill",
      { id: "docgen", args: { outDir: "outputs/skill-out" } },
      "生成完成，写入 outputs/skill-out/result.md",
    );

    const resolved = await resolveTurnFileChanges("A", diff, cwd, { evidence: [evidence!] });
    expect(resolved.map((entry) => entry.path)).toEqual(["outputs/skill-out/result.md"]);
    expect(resolved[0]?.sourceTool).toBe("execute_skill");
  });

  it("读类工具不产生归属证据，其他会话的同名改动不会被吸进来", async () => {
    expect(collectToolEvidence("file_read", { filePath: "outputs/a.txt" }, "content")).toBeUndefined();
    expect(collectToolEvidence("list_dir", { path: "outputs" }, ["outputs/a.txt"])).toBeUndefined();
    expect(collectToolEvidence("grep", { pattern: "x", path: "outputs" }, "outputs/a.txt")).toBeUndefined();

    const cwd = makeWorkspace();
    const diff = [{ path: "outputs/a.txt", status: "modified" as const }];
    expect(await resolveTurnFileChanges("A", diff, cwd, { evidence: [] })).toEqual([]);
  });

  it("被快照忽略的路径（不在起点、不在 diff）用 stat 合成新增", async () => {
    const cwd = makeWorkspace();
    const rel = "uploads/photo.png";
    recordTurnPreState("A", "file_write", { filePath: rel }, cwd);
    fs.mkdirSync(path.join(cwd, "uploads"), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), "png");
    recordTurnTouchedPath("A", "file_write", { filePath: rel }, cwd);

    expect(await resolveTurnFileChanges("A", [], cwd)).toEqual([
      { path: rel, status: "added", confidence: "exact", sourceTool: "file_write" },
    ]);
  });

  it("写入前已存在的忽略路径标 modified", async () => {
    const cwd = makeWorkspace();
    const rel = "uploads/photo.png";
    fs.mkdirSync(path.join(cwd, "uploads"), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), "old");
    recordTurnPreState("A", "file_write", { filePath: rel }, cwd);
    fs.writeFileSync(path.join(cwd, rel), "new");
    recordTurnTouchedPath("A", "file_write", { filePath: rel }, cwd);

    expect(await resolveTurnFileChanges("A", [], cwd)).toEqual([
      { path: rel, status: "modified", confidence: "exact", sourceTool: "file_write" },
    ]);
  });

  it("起点快照里已有、diff 也没报的路径视为未变化", async () => {
    const cwd = makeWorkspace();
    const rel = "tracked.txt";
    fs.writeFileSync(path.join(cwd, rel), "same");
    recordTurnTouchedPath("A", "file_write", { filePath: rel }, cwd);

    const start = new Map([[rel, sha256("same")]]);
    expect(
      await resolveTurnFileChanges("A", [], cwd, {
        snapshotStart: start,
        diffAuthoritative: true,
      }),
    ).toEqual([]);
  });

  it("快照失败时用起点 hash 比对，真正变化的路径仍能报出", async () => {
    const cwd = makeWorkspace();
    const rel = "tracked.txt";
    fs.writeFileSync(path.join(cwd, rel), "new content");
    recordTurnTouchedPath("A", "file_write", { filePath: rel }, cwd);

    const start = new Map([[rel, sha256("old content")]]);
    expect(
      await resolveTurnFileChanges("A", [], cwd, {
        snapshotStart: start,
        diffAuthoritative: false,
      }),
    ).toEqual([
      { path: rel, status: "modified", confidence: "exact", sourceTool: "file_write" },
    ]);
  });

  it("快照失败且文件已删除时标 deleted", async () => {
    const cwd = makeWorkspace();
    const rel = "tracked.txt";
    fs.writeFileSync(path.join(cwd, rel), "old");
    recordTurnPreState("A", "file_write", { filePath: rel }, cwd);
    fs.rmSync(path.join(cwd, rel));
    recordTurnTouchedPath("A", "file_write", { filePath: rel }, cwd);

    const start = new Map([[rel, sha256("old")]]);
    expect(
      await resolveTurnFileChanges("A", [], cwd, {
        snapshotStart: start,
        diffAuthoritative: false,
      }),
    ).toEqual([
      { path: rel, status: "deleted", confidence: "exact", sourceTool: "file_write" },
    ]);
  });

  it("绝对路径归一化，越出 workspace 的路径不记录", async () => {
    const cwd = makeWorkspace();
    recordTurnTouchedPath("A", "file_write", { filePath: `${cwd}/outputs/a.txt` }, cwd);
    recordTurnTouchedPath("A", "file_write", { filePath: "../outside.txt" }, cwd);

    const diff = [{ path: "outputs/a.txt", status: "modified" as const }];
    expect(await resolveTurnFileChanges("A", diff, cwd)).toEqual([
      { path: "outputs/a.txt", status: "modified", confidence: "exact", sourceTool: "file_write" },
    ]);
  });

  it("file_copy 只登记 destination，源文件不会被误报成修改", async () => {
    const cwd = makeWorkspace();
    recordTurnTouchedPath(
      "A",
      "file_copy",
      { source: "outputs/src.txt", destination: "outputs/dst.txt" },
      cwd,
    );
    const diff = [
      { path: "outputs/dst.txt", status: "added" as const },
      { path: "outputs/src.txt", status: "modified" as const },
    ];

    // 源文件出现在 diff 里但没有本会话证据，按「非本会话改动」丢弃
    expect(await resolveTurnFileChanges("A", diff, cwd)).toEqual([
      { path: "outputs/dst.txt", status: "added", confidence: "exact", sourceTool: "file_copy" },
    ]);
  });

  it("file_move 登记 source（删除）与 destination（新增）", async () => {
    const cwd = makeWorkspace();
    fs.mkdirSync(path.join(cwd, "outputs"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "outputs/old.txt"), "x");
    recordTurnPreState(
      "A",
      "file_move",
      { source: "outputs/old.txt", destination: "outputs/new.txt" },
      cwd,
    );
    fs.renameSync(path.join(cwd, "outputs/old.txt"), path.join(cwd, "outputs/new.txt"));
    recordTurnTouchedPath(
      "A",
      "file_move",
      { source: "outputs/old.txt", destination: "outputs/new.txt" },
      cwd,
    );

    expect(await resolveTurnFileChanges("A", [], cwd)).toEqual([
      { path: "outputs/new.txt", status: "added", confidence: "exact", sourceTool: "file_move" },
      { path: "outputs/old.txt", status: "deleted", confidence: "exact", sourceTool: "file_move" },
    ]);
  });

  it("recordTurnTouchedFilePath 登记工具结果里的产出路径", async () => {
    const cwd = makeWorkspace();
    fs.mkdirSync(path.join(cwd, "outputs"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "outputs/gen.png"), "png");
    recordTurnTouchedFilePath("A", `${cwd}/outputs/gen.png`, cwd, "image_generate");

    expect(await resolveTurnFileChanges("A", [], cwd)).toEqual([
      { path: "outputs/gen.png", status: "added", confidence: "exact", sourceTool: "image_generate" },
    ]);
  });

  it("异步唤醒的开轮会清掉上一轮登记，旧文件不会被重复报成变更", async () => {
    const cwd = makeWorkspace();
    const rel = "outputs/prev.txt";
    fs.mkdirSync(path.join(cwd, "outputs"), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), "done");
    recordTurnTouchedPath("A", "file_write", { filePath: rel }, cwd);
    // 没有清理时，stat 合成会把上一轮路径再报一次
    expect((await resolveTurnFileChanges("A", [], cwd)).map((entry) => entry.path)).toEqual([rel]);

    const state: { turnSnapshotStart?: Map<string, string> } = {};
    await beginStandaloneTurn("A", state, async () => new Map([[rel, sha256("done")]]));

    expect(state.turnSnapshotStart?.get(rel)).toBe(sha256("done"));
    expect(await resolveTurnFileChanges("A", [], cwd)).toEqual([]);
  });

  it("异步开轮快照失败时清空起点，但登记表仍然被重置", async () => {
    const cwd = makeWorkspace();
    const rel = "outputs/prev.txt";
    fs.mkdirSync(path.join(cwd, "outputs"), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), "done");
    recordTurnTouchedPath("A", "file_write", { filePath: rel }, cwd);

    const state: { turnSnapshotStart?: Map<string, string> } = {};
    await beginStandaloneTurn("A", state, async () => {
      throw new Error("snapshot failed");
    });

    expect(state.turnSnapshotStart).toBeUndefined();
    expect(await resolveTurnFileChanges("A", [], cwd)).toEqual([]);
  });

  it("没有实例状态时异步开轮安全跳过", async () => {
    let captured = false;
    await beginStandaloneTurn("A", undefined, async () => {
      captured = true;
      return new Map();
    });
    expect(captured).toBe(false);
  });

  it("collectResultTouchedPaths 只认产文件工具，从 details/filePath 取路径", () => {
    expect(
      collectResultTouchedPaths("image_generate", { details: { filePath: "outputs/a.png" } }),
    ).toEqual(["outputs/a.png"]);
    expect(
      collectResultTouchedPaths("speech_generate", { details: { filePath: "x.wav" } }),
    ).toEqual(["x.wav"]);
    // 读类工具带 path 也不登记，避免别的会话改了同一路径重新串进来
    expect(collectResultTouchedPaths("file_read", { path: "a.txt" })).toEqual([]);
    expect(collectResultTouchedPaths("image_generate", undefined)).toEqual([]);
  });

  it("collectResultTouchedPaths 接受 details.artifacts 声明（不要求工具白名单）", () => {
    expect(
      collectResultTouchedPaths("mcp__comfyui__enqueue_workflow", {
        details: {
          artifacts: [
            { kind: "video", path: "outputs/v/a.mp4" },
            { kind: "video", remoteUrl: "http://x/b.mp4" },
          ],
        },
      }),
    ).toEqual(["outputs/v/a.mp4"]);
    expect(
      collectResultTouchedPaths("image_generate", {
        details: {
          filePath: "outputs/a.png",
          artifacts: [{ kind: "image", path: "outputs/a.png" }],
        },
      }),
    ).toEqual(["outputs/a.png"]);
  });
});
