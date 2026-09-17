# 记忆与 Wiki 重构 · 索引

记忆系统（`agent_memories`）与 Wiki 知识库（`wiki_*`）的重构实施记录。设计文档在 [`../../design/记忆设计/`](../../design/记忆设计/)，CLI 测试在 [`../../test/lumii-cli/wiki/`](../../test/lumii-cli/wiki/) 与 [`../../test/lumii-cli/chat/`](../../test/lumii-cli/chat/)。

> 全部 25 篇均已实施完毕（2026-08-24 ～ 09-09）。按演进脉络顺序阅读。

## 一、记忆 P0

| 文档 | 说明 |
| --- | --- |
| [`2026-08-24-memory-p0-implementation.md`](2026-08-24-memory-p0-implementation.md) | 温度分档 + FTS5 全文检索（设计：[`memory-design.md`](../../design/记忆设计/2026-08-24-memory-design.md)） |
| [`2026-08-25-memory-p0-cli-test.md`](2026-08-25-memory-p0-cli-test.md) | 上述特性的 CLI 测试 |

## 二、Wiki 主链（P0 → P3）

| 文档 | 说明 |
| --- | --- |
| [`2026-08-25-wiki-p0-implementation.md`](2026-08-25-wiki-p0-implementation.md) | Wiki P0：基础结构 |
| [`2026-08-25-wiki-p0-cli-test.md`](2026-08-25-wiki-p0-cli-test.md) | P0 CLI 测试 |
| [`2026-08-26-wiki-p1-implementation.md`](2026-08-26-wiki-p1-implementation.md) | P1 |
| [`2026-08-26-wiki-p2-implementation.md`](2026-08-26-wiki-p2-implementation.md) | P2 |
| [`2026-08-26-wiki-ux-fixes-implementation.md`](2026-08-26-wiki-ux-fixes-implementation.md) | UX 修复（默认列表、待整理计数、多媒体误分类等） |

## 三、主题层级与知识图谱

| 文档 | 说明 |
| --- | --- |
| [`2026-08-27-wiki-settings-ui-implementation.md`](2026-08-27-wiki-settings-ui-implementation.md) | Wiki 设置页 UI |
| [`2026-08-27-wiki-topic-hierarchy-p1-implementation.md`](2026-08-27-wiki-topic-hierarchy-p1-implementation.md) | 主题层级 P1（设计：[`topic-hierarchy-redesign`](../../design/记忆设计/2026-08-27-wiki-topic-hierarchy-redesign.md)） |
| [`2026-08-27-wiki-topic-hierarchy-p2-implementation.md`](2026-08-27-wiki-topic-hierarchy-p2-implementation.md) | 主题层级 P2 |
| [`2026-08-27-wiki-knowledge-graph-implementation.md`](2026-08-27-wiki-knowledge-graph-implementation.md) | 知识图谱早期方案 ⚠️ 被下方 graph-phase3 取代 |
| [`2026-08-28-wiki-graph-phase3-implementation.md`](2026-08-28-wiki-graph-phase3-implementation.md) | 图谱 Phase 3（当前模型：资料 + 用途结构 + 实体关系） |
| [`2026-08-27-wiki-auto-synthesis-implementation.md`](2026-08-27-wiki-auto-synthesis-implementation.md) | 综述自动合成 ⚠️ 该功能已于 P2 整体删除，本文仅存档决策史 |

## 四、Vault 与智能资料库

| 文档 | 说明 |
| --- | --- |
| [`2026-08-29-wiki-vault-p0-implementation.md`](2026-08-29-wiki-vault-p0-implementation.md) | Vault P0（引用优先） |
| [`2026-08-31-wiki-intelligent-vault-p1-taxonomy.md`](2026-08-31-wiki-intelligent-vault-p1-taxonomy.md) | 智能资料库 P1：六大类分类法 v2 |
| [`2026-08-31-wiki-intelligent-vault-p2-remove-synthesis.md`](2026-08-31-wiki-intelligent-vault-p2-remove-synthesis.md) | P2：**彻底删除综述合成**（DROP 表，不留审计） |
| [`2026-08-31-wiki-intelligent-vault-p3-remove-pages.md`](2026-08-31-wiki-intelligent-vault-p3-remove-pages.md) | P3：移除页面层 |
| [`2026-08-31-wiki-intelligent-vault-p4-summary-vector.md`](2026-08-31-wiki-intelligent-vault-p4-summary-vector.md) | P4：摘要向量 |
| [`2026-08-31-wiki-intelligent-vault-p5-cataloging.md`](2026-08-31-wiki-intelligent-vault-p5-cataloging.md) | P5：编目 |
| [`2026-08-31-wiki-intelligent-vault-p6-rename.md`](2026-08-31-wiki-intelligent-vault-p6-rename.md) | P6：重命名 |
| [`2026-08-31-wiki-intelligent-vault-p7-rollout.md`](2026-08-31-wiki-intelligent-vault-p7-rollout.md) | P7：上线 |

设计来源：[`2026-08-31-wiki-intelligent-vault-design.md`](../../design/记忆设计/2026-08-31-wiki-intelligent-vault-design.md)。

## 五、库级迁移与多级路径分类

| 文档 | 说明 |
| --- | --- |
| [`2026-09-05-wiki-library-migrate-implementation.md`](2026-09-05-wiki-library-migrate-implementation.md) | Wiki 库级迁移（设计：[`wiki-library-migrate-design.md`](../../design/记忆设计/2026-09-05-wiki-library-migrate-design.md)） |
| [`2026-09-09-wiki-multilevel-path-implementation.md`](2026-09-09-wiki-multilevel-path-implementation.md) | 多级路径分类（Schema V39：`user_path` / `tags` / `description`）实施总结 |
| [`2026-09-09-wiki-multilevel-path-api.md`](2026-09-09-wiki-multilevel-path-api.md) | 上述特性的数据结构与 IPC API 契约 |
| [`2026-09-09-wiki-multilevel-path-progress.md`](2026-09-09-wiki-multilevel-path-progress.md) | 上述特性的分阶段进度 |

> 多级路径分类是目前**唯一记录该已上线特性**的文档组（`grep user_path` 在 `docs/design`、`docs/plans` 其他位置无命中）。

## 相关设计文档

记忆与 Wiki 的设计正本集中在 [`../../design/记忆设计/`](../../design/记忆设计/)，其中：

- 核心设计：[`2026-08-24-memory-design.md`](../../design/记忆设计/2026-08-24-memory-design.md)（含 2026-09-13 修订记录）
- 11 份开源项目参考解构：各项目子目录下的 `设计解构.md` + `源码/README.md`
- 场景记忆：[`2026-09-12-scene-memory-design.md`](../../design/记忆设计/2026-09-12-scene-memory-design.md)
