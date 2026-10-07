import { describe, it, expect, beforeEach } from "vitest";
import {
  recordTurnTouchedPath,
  recordTurnTouchedFilePath,
  clearTurnTouchedPaths,
  collectResultTouchedPaths,
  filterOwnFileChanges,
} from "./turn-touched-paths";

const cwd = process.platform === "win32" ? "C:/workspace" : "/workspace";

describe("turn-touched-paths", () => {
  beforeEach(() => {
    clearTurnTouchedPaths("A");
    clearTurnTouchedPaths("B");
  });

  it("剔除其他会话写入的变更，保留自己的", () => {
    recordTurnTouchedPath("A", { filePath: "outputs/a.txt" }, cwd);
    recordTurnTouchedPath("B", { filePath: "outputs/b.txt" }, cwd);

    const diff = [
      { path: "outputs/a.txt", status: "added" as const },
      { path: "outputs/b.txt", status: "added" as const },
    ];

    expect(filterOwnFileChanges("A", diff)).toEqual([
      { path: "outputs/a.txt", status: "added" },
    ]);
    expect(filterOwnFileChanges("B", diff)).toEqual([
      { path: "outputs/b.txt", status: "added" },
    ]);
  });

  it("严格归属：无人声明的变更（bash 等）不进卡片", () => {
    recordTurnTouchedPath("B", { filePath: "outputs/b.txt" }, cwd);
    const diff = [{ path: "outputs/via-bash.txt", status: "added" as const }];
    expect(filterOwnFileChanges("A", diff)).toEqual([]);
  });

  it("绝对路径归一化，越出 workspace 的路径不记录", () => {
    recordTurnTouchedPath("A", { filePath: `${cwd}/outputs/a.txt` }, cwd);
    recordTurnTouchedPath("A", { filePath: "../outside.txt" }, cwd);
    recordTurnTouchedPath("B", { filePath: "outputs/a.txt" }, cwd);

    // A 声明过 outputs/a.txt（绝对路径写入），因此对 A 可见
    expect(
      filterOwnFileChanges("A", [{ path: "outputs/a.txt", status: "modified" }]),
    ).toHaveLength(1);
  });

  it("记录 file_move/file_copy 的 source 与 destination", () => {
    recordTurnTouchedPath("A", { source: "outputs/old.txt", destination: "outputs/new.txt" }, cwd);
    expect(
      filterOwnFileChanges("A", [
        { path: "outputs/old.txt", status: "deleted" },
        { path: "outputs/new.txt", status: "added" },
      ]),
    ).toHaveLength(2);
  });

  it("并发回合：A 结束回合后不清空归属，B 的 diff 仍剔除 A 的写入", () => {
    recordTurnTouchedPath("A", { filePath: "outputs/a.txt" }, cwd);
    // agent:end 不再调用 clearTurnTouchedPaths（见 bridge-agent-instance-events.ts），
    // 归属应持续到 A 的下一次回合开始或实例销毁，避免串台。
    const diff = [{ path: "outputs/a.txt", status: "added" as const }];
    expect(filterOwnFileChanges("B", diff)).toEqual([]);
  });

  it("未登记路径的实例一律返回空（严格归属）", () => {
    recordTurnTouchedPath("B", { filePath: "outputs/b.txt" }, cwd);
    clearTurnTouchedPaths("B");
    const diff = [{ path: "outputs/b.txt", status: "added" as const }];
    expect(filterOwnFileChanges("A", diff)).toEqual([]);
  });

  it("recordTurnTouchedFilePath 登记工具结果里的产出路径", () => {
    recordTurnTouchedFilePath("A", `${cwd}/outputs/gen.png`, cwd);
    expect(
      filterOwnFileChanges("A", [{ path: "outputs/gen.png", status: "added" }]),
    ).toHaveLength(1);
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
});
