/**
 * 回归：SkillWatcher 不得被自己进程写的 index.json 触发重扫。
 *
 * index.json 由 LocalSkillStore 写在被监控的 skills/ 目录内。若 watch 回调不过滤，
 * 「扫描 → 写索引 → watch 事件 → 再扫描」会形成自激循环。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillWatcher } from "./skill-watcher";

let root: string;
let watcher: SkillWatcher | null = null;

/** 取出 fs.watch 注册的回调，直接投喂事件，避免依赖真实文件系统事件时序 */
function captureWatchListener(): (eventType: string, filename: string | null) => void {
  let listener: ((eventType: string, filename: string | null) => void) | null = null;
  vi.spyOn(fs, "watch").mockImplementation(((_dir: unknown, _opts: unknown, cb: unknown) => {
    listener = cb as (eventType: string, filename: string | null) => void;
    return { close: () => {}, on: () => {} } as unknown as fs.FSWatcher;
  }) as unknown as typeof fs.watch);
  return (eventType, filename) => {
    if (!listener) throw new Error("fs.watch 回调未注册");
    listener(eventType, filename);
  };
}

/** 等待超过 SkillWatcher 的 1500ms 防抖窗口，并留出真实 fs 扫描的时间 */
function waitPastDebounce(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2200));
}

describe("SkillWatcher 自写文件过滤", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "lumii-watcher-"));
    fs.mkdirSync(path.join(root, "skills"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await watcher?.stop();
    watcher = null;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("index.json 事件不触发重扫，skill.md 事件仍触发", async () => {
    const emit = captureWatchListener();
    watcher = new SkillWatcher(root);

    const onChanged = vi.fn();
    watcher.setOnSkillsChanged(onChanged);
    await watcher.start();

    // start() 内的初始扫描会回调一次，先归零只观察事件驱动的重扫
    onChanged.mockClear();

    // 本进程自写的索引文件：根层与分类层都应被过滤
    emit("change", "index.json");
    emit("change", "分类A/index.json");
    await waitPastDebounce();
    expect(onChanged).not.toHaveBeenCalled();

    // 真实技能变更仍必须触发重扫
    emit("rename", "my-skill/skill.md");
    await waitPastDebounce();
    expect(onChanged).toHaveBeenCalledTimes(1);
  }, 15000);
});
