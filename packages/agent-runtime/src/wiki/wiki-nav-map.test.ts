import { describe, expect, it } from "vitest";
import { PARKING_CATEGORY } from "./wiki-topic-tree.js";
import {
  WIKI_NAV_SECTIONS,
  folderSlugForNavId,
  navIdFromLegacyCategory,
  primaryLegacyCategoryForNav,
  vaultDirSegmentsForSource,
} from "./wiki-nav-map.js";

describe("wiki-nav-map", () => {
  it("六大类各自落到正确分区", () => {
    expect(navIdFromLegacyCategory("做事记录")).toBe("work");
    expect(navIdFromLegacyCategory("学习资料")).toBe("study");
    expect(navIdFromLegacyCategory("计划与复盘")).toBe("life");
    expect(navIdFromLegacyCategory("证件凭据")).toBe("life");
    expect(navIdFromLegacyCategory("模板参考")).toBe("collection");
    expect(navIdFromLegacyCategory("随笔创作")).toBe("collection");
  });

  it("主题为空与临时存放归 inbox", () => {
    expect(navIdFromLegacyCategory(null)).toBe("inbox");
    expect(navIdFromLegacyCategory(PARKING_CATEGORY)).toBe("inbox");
  });

  it("用户自建大类兜底到 work", () => {
    expect(navIdFromLegacyCategory("外部协作")).toBe("work");
  });

  it("inbox 与 archived 没有可写入的旧大类", () => {
    expect(primaryLegacyCategoryForNav("inbox")).toBeNull();
    expect(primaryLegacyCategoryForNav("archived")).toBeNull();
    expect(primaryLegacyCategoryForNav("work")).toBe("做事记录");
  });

  it("六个分区顺序与设计一致", () => {
    expect(WIKI_NAV_SECTIONS.map((s) => s.label)).toEqual([
      "收件箱",
      "工作",
      "学习",
      "生活",
      "收藏",
      "归档",
    ]);
  });

  it("vaultDirSegments 反映归档与分类", () => {
    expect(
      vaultDirSegmentsForSource({
        topicCategory: null,
        topicSubtopic: null,
        archivedAt: null,
      }),
    ).toEqual([folderSlugForNavId("inbox")]);
    expect(
      vaultDirSegmentsForSource({
        topicCategory: "做事记录",
        topicSubtopic: "会议聊天记录",
        archivedAt: null,
      }),
    ).toEqual([folderSlugForNavId("work"), "会议聊天记录"]);
    expect(
      vaultDirSegmentsForSource({
        topicCategory: "做事记录",
        topicSubtopic: null,
        archivedAt: "2026-01-01",
      }),
    ).toEqual([folderSlugForNavId("archived")]);
  });
});
