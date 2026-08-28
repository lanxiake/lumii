import { describe, it, expect, beforeEach } from "vitest";
import {
  recordTurnTouchedPath,
  clearTurnTouchedPaths,
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

  it("无人声明的变更（bash 等）仍归本回合", () => {
    recordTurnTouchedPath("B", { filePath: "outputs/b.txt" }, cwd);
    const diff = [{ path: "outputs/via-bash.txt", status: "added" as const }];
    expect(filterOwnFileChanges("A", diff)).toEqual(diff);
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

  it("clearTurnTouchedPaths 后不再影响其他会话", () => {
    recordTurnTouchedPath("B", { filePath: "outputs/b.txt" }, cwd);
    clearTurnTouchedPaths("B");
    const diff = [{ path: "outputs/b.txt", status: "added" as const }];
    expect(filterOwnFileChanges("A", diff)).toEqual(diff);
  });
});
