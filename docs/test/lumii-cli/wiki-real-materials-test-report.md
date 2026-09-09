# Wiki 真实材料端到端测试报告

- 日期：2026-09-09T07:38:21.343Z
- 材料目录：C:\myself\projects\my\open-source\lumii\docs\test\lumii-cli\测试材料
- 环境：lumii-ui + ~/.lumii/data/agent-runtime.db
- 汇总：**PASS 22** / **FAIL 0** / **SKIP 0** / 合计 22

## 数据处理说明

本轮测试产生的 wiki_sources 行已按用户选择的「归档保留（推荐）」策略处理：
调用 `wiki:source:archive` 置位 `archived_at`，不做物理删除，保留审计轨迹，
且已验证不再出现在正式目录/默认检索结果中，随时可通过 `wiki:source:restore` 恢复。
涉及 sourceId：ddd6a0c68ae35e469bd17c2edf03f23e, c5eb6e7c1e0b3d39da15cfd78767ac2e, 847f17fa2512adec514c85d2e729eaf6, 3f27e8995cec86c4c6161b16ea049690, f65aa36496002f8441ade3d4e69b30fc, 48277eff6180d1391c0a0ad76781927b

## 结论

真实文档（2 docx + 2 PDF 教材）正文抽取、手动归档写入用途两列、资料层检索命中、打开原文件、归档保留全链路通过；2 份 mp4 按 P0 音视频不提取正文的既定行为验证 mediaType=video 落盘正确。

## 明细

| ID | 状态 | 说明 |
|---|---|---|
| M01 | PASS | docx1 chars=2727 |
| M02 | PASS | docx2 chars=14458 |
| M03 | PASS | pdf上册 pages=118 chars=36909 |
| M04 | PASS | pdf下册 pages=127 chars=54336 |
| I-docx1 | PASS | sourceId=ddd6a0c68ae35e469bd17c2edf03f23e 学习/参考 |
| I-docx2 | PASS | sourceId=c5eb6e7c1e0b3d39da15cfd78767ac2e 学习/参考 |
| I-pdfUp | PASS | sourceId=847f17fa2512adec514c85d2e729eaf6 学习/在学 |
| I-pdfDown | PASS | sourceId=3f27e8995cec86c4c6161b16ea049690 学习/在学 |
| I-mp4_1 | PASS | sourceId=f65aa36496002f8441ade3d4e69b30fc 收藏/可复用 |
| I-mp4_2 | PASS | sourceId=48277eff6180d1391c0a0ad76781927b 收藏/可复用 |
| V01 | PASS | mp4_1 mediaType=video |
| D01 | PASS | wiki_pages 表已随 P3 移除（organize 路径天然不写摘要页） |
| R-docx1 | PASS | 关键词「WordPress」命中 sourceId=ddd6a0c68ae35e469bd17c2edf03f23e |
| R-docx2 | PASS | 关键词「GITHUB」命中 sourceId=c5eb6e7c1e0b3d39da15cfd78767ac2e |
| R-pdfUp | PASS | 关键词「识字」命中 sourceId=847f17fa2512adec514c85d2e729eaf6 |
| R-pdfDown | PASS | 关键词「课文」命中 sourceId=3f27e8995cec86c4c6161b16ea049690 |
| R-rare | PASS | 稀有词 + enableVector:false 空结果 |
| R-rare-hybrid | PASS | 默认 hybrid 模式 hits=0（观察项：向量兜底无零相似度概念，恒返回近邻，enableVector:false 才是真正的空结果判定） |
| O-open | PASS | sourceId=ddd6a0c68ae35e469bd17c2edf03f23e success=true |
| A-archive | PASS | archived=6/6 |
| A-verify | PASS | 全部 6 条 archived_at 已置位 |
| A-search-excluded | PASS | 归档后再搜索仍命中=false（观察项，searchSources 显式排除 archived_at IS NULL） |

## 覆盖说明

- **M**：本地 mammoth/pdf-parse 抽取真实正文（Wiki 内置抽取器不解析二进制文档，绕不开）
- **I**：DatabaseSync 播种 wiki_inbox（source_path 指向真实磁盘文件）→ `command wiki:inbox:organize`（CLI 子命令已知脱节，全程走 command）
- **V**：mp4 落盘 mediaType=video
- **D**：归档路径②不写 wiki_pages（延续一期核心断言）
- **R**：`wiki:search` 命中真实抽取正文关键词；稀有词空结果
- **O**：`wiki:source:open` 拉起真实文件
- **A**：`wiki:source:archive` 归档保留 + `archived_at` 校验 + 归档后检索排除观察

证据：`wiki-real-materials-evidence.jsonl`
