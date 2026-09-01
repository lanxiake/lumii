/**
 * titleInfoScore：低信息标题判定
 * 计划：docs/plans/记忆重构/2026-08-31-wiki-intelligent-vault-p6-rename.md Task 2
 */

import { describe, expect, it } from "vitest";
import { isLowInfoTitle, titleInfoScore, LOW_INFO_THRESHOLD, shouldAcceptRenameProposal } from "./wiki-title-score.js";

describe("titleInfoScore", () => {
  it("IMG_1234.jpg → 低", () => {
    expect(titleInfoScore("IMG_1234.jpg", null)).toBeLessThan(LOW_INFO_THRESHOLD);
    expect(isLowInfoTitle("IMG_1234.jpg", null)).toBe(true);
  });

  it("2026年Q3工作汇报.docx → 高", () => {
    expect(titleInfoScore("2026年Q3工作汇报.docx", null)).toBeGreaterThanOrEqual(LOW_INFO_THRESHOLD);
    expect(isLowInfoTitle("2026年Q3工作汇报.docx", null)).toBe(false);
  });

  it("未命名文档.docx → 低", () => {
    expect(titleInfoScore("未命名文档.docx", null)).toBeLessThan(LOW_INFO_THRESHOLD);
  });

  it("纯中文长标题 → 高", () => {
    expect(titleInfoScore("关于二零二六年度部门预算调整方案的说明", null)).toBeGreaterThanOrEqual(
      LOW_INFO_THRESHOLD,
    );
  });

  it("与正文重合度高时分数更高", () => {
    const withCorpus = titleInfoScore("周报", "本周完成了周报撰写与提交，涵盖项目进度与风险");
    const withoutCorpus = titleInfoScore("周报", null);
    expect(withCorpus).toBeGreaterThanOrEqual(withoutCorpus);
  });

  it("纯数字标题 → 低", () => {
    expect(titleInfoScore("20260812", null)).toBeLessThan(LOW_INFO_THRESHOLD);
  });

  it("扫描/微信模式命中 → 低", () => {
    expect(titleInfoScore("微信图片_20260812153000.jpg", null)).toBeLessThan(LOW_INFO_THRESHOLD);
    expect(titleInfoScore("扫描_0001.pdf", null)).toBeLessThan(LOW_INFO_THRESHOLD);
  });
});

describe("shouldAcceptRenameProposal", () => {
  const base = {
    renameTitle: "2026年Q3工作汇报",
    currentTitle: "IMG_1234.jpg",
    titleLocked: false,
    storageMode: "materialized" as const,
    confidence: 0.9,
  };

  it("title_locked 时强制丢弃", () => {
    expect(shouldAcceptRenameProposal({ ...base, titleLocked: true })).toBe(false);
  });

  it("ref 模式默认丢弃", () => {
    expect(shouldAcceptRenameProposal({ ...base, storageMode: "ref" })).toBe(false);
  });

  it("ref 模式在 allowRenameRef=true 时接受", () => {
    expect(shouldAcceptRenameProposal({ ...base, storageMode: "ref", allowRenameRef: true })).toBe(true);
  });

  it("当前标题信息量已够时丢弃", () => {
    expect(shouldAcceptRenameProposal({ ...base, currentTitle: "2026年度部门预算方案说明" })).toBe(false);
  });

  it("confidence 低于阈值时丢弃", () => {
    expect(shouldAcceptRenameProposal({ ...base, confidence: 0.5 })).toBe(false);
  });

  it("无 renameTitle 时丢弃", () => {
    expect(shouldAcceptRenameProposal({ ...base, renameTitle: undefined })).toBe(false);
  });

  it("满足所有条件时接受", () => {
    expect(shouldAcceptRenameProposal(base)).toBe(true);
  });
});
