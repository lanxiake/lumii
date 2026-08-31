# Wiki 智能资料库 P6：AI 文件名重命名 Implementation Plan

> **For agentic workers:** 按 Task 顺序实施，每个 Task 走「先写失败测试 → 跑失败 → 实现 → 跑通 → 提交」。
> 规格：`docs/design/记忆设计/2026-08-31-wiki-intelligent-vault-design.md`（v1.1）§6
> 前置：P1（分类体系 v2）、P5（全库编目 v2，重命名并入其候选管线）

**Goal:** 给低信息标题（`IMG_1234.jpg`、`扫描_0001.pdf`、`未命名文档.docx` 这类）提供 AI 改名提案，用户手动改过的标题永久锁定不再提案；`ref` 模式文件默认不提案（避免库内显示名与磁盘文件名双名）。默认关闭，作为编目候选的可选附加项。

**Non-goals：** 不做批量强制改名；不做图片/音视频内容识别改名（§6.4 无正文资料策略未覆盖到改名，只覆盖分类）。

---

## 0. 前置事实（实施前核对，勿凭记忆）

- `wiki:source:rename` 现状：`apps/windows/src/main/ipc/agent-runtime/wiki-commands.ts:675-688`，纯手动、直接接受用户传入标题，调 `bridge.wikiRepo.renameSource`。
- `wiki_sources.storage_mode`（P0 已加）：`'ref' | 'materialized' | 'native'`，决定改名要不要动磁盘文件。
- 全代码库当前没有 `titleInfoScore` / `isLowInfoTitle` 等任何标题信息量判定逻辑，是全新模块。
- P5 的编目候选结构（`wiki:reclassify:*`）已在 P5 计划中扩展了 `renameTitle?` 字段，本期只需实现「产出 renameTitle」与「应用 renameTitle」两侧，不重新设计候选管线。

---

## Task 1：`title_locked` 列与手动改名联动

- V26 迁移追加 `wiki_sources.title_locked INTEGER NOT NULL DEFAULT 0`（若 P1 的 V26 已建，此处合并进同一迁移，不再开新版本号）。
- `wiki:source:rename` 成功后置 `title_locked = 1`。
- 测试：手动改名后该 source 不再出现在下一步 Task 2 的候选产出里。

## Task 2：`titleInfoScore(title, corpus)` 打分模块

新文件 `packages/agent-runtime/src/wiki/wiki-title-score.ts`：

- 特征：标题与正文（`summary` 优先，无则 `extracted_text` 前 300 字）词重合度；标题中实义词占比（去停用词后剩余 token 数）；相机/扫描/微信模式匹配（作为一项特征而非独立白名单，权重不过半）；纯数字/纯 ASCII+数字前缀；标题长度 ≤2。
- 输出 0–1 分数，`< 0.4` 视为低信息（阈值先写常量，不做配置项）。
- 单测覆盖：`IMG_1234.jpg`→低、`2026年Q3工作汇报.docx`→高、`未命名文档.docx`→低、纯中文长标题→高。

## Task 3：改名提案产出（并入 P5 编目候选）

- 在 P5 内容轮的 LLM 输出 schema 里已有 `renameTitle?` 字段（P5 计划已定义）；本任务实现「是否接受该字段」的服务端校验：
  - `title_locked = 1` → 强制丢弃 renameTitle，不管 LLM 输出了什么。
  - `storage_mode = 'ref'` → 默认丢弃（配置开关关闭时);允许后续开关打开。
  - `titleInfoScore(currentTitle) >= 0.4` → 丢弃（标题本身信息量已够,不需要改）。
  - `confidence < 0.7` → 丢弃。
- `scope='source'` 单文件模式：复用同一管线，只返回一条候选（供「建议标题」按钮使用）。

## Task 4：改名落盘的存储边界

**已核实（facts-taxonomy）：改名去重逻辑目前分散、且实际落盘路径没走 `resolveUniqueFilename`。** `sanitizeFilenameSegment` 定义在 `wiki-exporter.ts:42`，`resolveUniqueFilename` 定义在 `wiki-synthesizer.ts:117`（P2 会删掉 synthesizer 文件——若 P2 先于 P6 落地，这个函数要先搬到一个不依赖 synthesis 的公共位置，比如 `wiki-exporter.ts` 或新建 `wiki-filename-utils.ts`，否则 P6 会拿不到它）。而**当前真正的落盘调用方**（`wiki-commands.ts:636-647`，vault sync 首次写入用）只调了 `sanitizeFilenameSegment`，去重是手写的 `-${i}` 后缀拼接，**并未调用** `resolveUniqueFilename`。所以本 Task 「改磁盘文件名」不是复用一条已验证好的路径，而是要把改名时的去重逐个对齐到 `resolveUniqueFilename` 的语义（或者显式决定沿用手写去重、不引入第二套实现）——先确认这一点再写代码，不要假设「已有」就是「现有调用方已经在用」。

- `materialized` / `native`：改 `title` 列 + 重建该 source 的 FTS 行 + 若已落盘为 `wiki/` 内实体文件，按 `sanitizeFilenameSegment` + `resolveUniqueFilename` 改磁盘文件名 + vault sync。
- `ref`：只改 `wiki_sources.title`（库内显示名），**绝不触碰 `source_path` 指向的用户原文件**；若已生成 `.lumii-ref` 侧车文件，侧车文件名跟随改，源文件不跟随。
- 单测：`ref` 改名后 `source_path` 不变、`fs.stat` 原路径仍可访问；`materialized` 改名后磁盘文件确实改名且旧路径不再存在。

## Task 5：预览 UI

- 复用 P5 的 `WikiReclassifyView` 候选行，新增 `原标题 → 新标题` 列（P5 计划已在其 UI 任务里占位，此处补 reason 展示与逐条勾选改名/不改名的独立勾选框，与「是否移动分类」解耦——用户可以只接受改名不接受移动，反之亦然）。

## Task 6：默认关闭开关

- 全库编目 run 参数增加 `enableRename: boolean`（默认 `false`）；UI 触发编目时提供勾选项，说明文案「同时建议修改低信息文件名（可单独取消）」。

---

## 验证清单

- [ ] `title_locked` 迁移测试
- [ ] `wiki-title-score.test.ts` 覆盖 §上述四个样例
- [ ] `ref` 文件改名后源文件路径与内容均未变（回归测试，防止未来重构破坏此边界）
- [ ] 编目关闭 `enableRename` 时不产出任何 `renameTitle` 字段
