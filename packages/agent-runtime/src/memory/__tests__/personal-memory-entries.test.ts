/**
 * 个人记忆条目化（P1-2 · 评审 §3.2 方案 B）
 *
 * 问题：`user-memory.md` 每次整理都由 LLM **全量重写**，条目没有身份、没有时间，
 * 无法被单独引用或失效——文档级重写正是评审反模式 #2 在个人记忆上的形态。
 *
 * 本用例锁住「结构字段由 harness 独占」这条纪律：
 * 模型可以任意重写正文，但改不动 id 与创建日期；正文没变的条目身份必须保持。
 */
import { describe, it, expect } from "vitest";
import {
  parsePersonalMemory,
  reconcilePersonalMemory,
  stripPersonalMemoryMeta,
} from "../personal-memory-entries.js";

const NOW = new Date("2026-09-17T10:00:00.000Z");

const SAMPLE = `# 用户记忆

## 基本信息
- 用户是成都的后端工程师 <!--m:a1b2c3d4 2026-08-01-->

## 交互偏好
- 规则：生图必须调用 image_generate <!--m:e5f6a7b8 2026-09-01-->
- 回复要简洁
`;

describe("parsePersonalMemory", () => {
  it("解析出条目及其所属章节、id 与创建日期", () => {
    const { entries } = parsePersonalMemory(SAMPLE);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      id: "a1b2c3d4",
      createdAt: "2026-08-01",
      heading: "基本信息",
      text: "用户是成都的后端工程师",
    });
    expect(entries[2]).toMatchObject({
      id: "",
      createdAt: "",
      heading: "交互偏好",
      text: "回复要简洁", // 迁移前的存量条目：没有元数据
    });
  });
});

describe("reconcilePersonalMemory — 结构字段由 harness 独占", () => {
  it("正文未变的条目沿用旧 id 与创建日期", () => {
    const r = reconcilePersonalMemory(SAMPLE, SAMPLE, NOW);
    expect(r.kept).toBe(3);
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
    expect(r.content).toContain("<!--m:a1b2c3d4 2026-08-01-->");
  });

  it("模型篡改元数据 → 被旧的正确值覆盖（越权写无效，但不抛错）", () => {
    const tampered = SAMPLE.replace("<!--m:a1b2c3d4 2026-08-01-->", "<!--m:deadbeef 1999-01-01-->");
    const r = reconcilePersonalMemory(tampered, SAMPLE, NOW);

    expect(r.content).toContain("<!--m:a1b2c3d4 2026-08-01-->");
    expect(r.content).not.toContain("deadbeef");
    expect(r.kept).toBe(3);
  });

  it("模型删掉元数据 → 被补回", () => {
    const stripped = SAMPLE.replace(" <!--m:a1b2c3d4 2026-08-01-->", "");
    const r = reconcilePersonalMemory(stripped, SAMPLE, NOW);
    expect(r.content).toContain("用户是成都的后端工程师 <!--m:a1b2c3d4 2026-08-01-->");
  });

  it("新增正文 → 分配新 id 与当天日期", () => {
    const next = SAMPLE + "- 规则：交付前先跑 tsc\n";
    const r = reconcilePersonalMemory(next, SAMPLE, NOW);

    expect(r.added).toBe(1);
    expect(r.kept).toBe(3);
    expect(r.content).toMatch(/交付前先跑 tsc <!--m:[0-9a-f]+ 2026-09-17-->/);
  });

  it("消失的正文计入 removed（整理允许删除，但要能被观察到）", () => {
    const next = SAMPLE.replace("- 回复要简洁\n", "");
    const r = reconcilePersonalMemory(next, SAMPLE, NOW);
    expect(r.removed).toBe(1);
    expect(r.content).not.toContain("回复要简洁");
  });

  it("非条目行（标题、空行、正文段落）原样保留", () => {
    const next = "# 用户记忆\n\n一些说明文字。\n\n## 基本信息\n- 条目内容\n";
    const r = reconcilePersonalMemory(next, "", NOW);
    expect(r.content).toContain("# 用户记忆");
    expect(r.content).toContain("一些说明文字。");
    expect(r.content).toContain("## 基本信息");
  });

  it("重复正文明细：旧文档里同文两条也只认一条（避免对账歧义）", () => {
    const dupPrev = "## A\n- 同一条内容\n- 同一条内容\n";
    const r = reconcilePersonalMemory("## A\n- 同一条内容\n", dupPrev, NOW);
    expect(r.kept).toBe(1);
    expect(r.removed).toBe(0); // 去重后只留一条，不算删除
  });
});

describe("stripPersonalMemoryMeta — 注入前剥离", () => {
  it("剥掉元数据注释但保留正文与结构", () => {
    const clean = stripPersonalMemoryMeta(SAMPLE);
    expect(clean).not.toContain("<!--m:");
    expect(clean).toContain("用户是成都的后端工程师");
    expect(clean).toContain("## 交互偏好");
  });

  it("无元数据时原样返回", () => {
    const plain = "## 基本信息\n- 一条普通条目\n";
    expect(stripPersonalMemoryMeta(plain)).toBe(plain);
  });
});
