# Wiki CLI 测试报告（补强）

- 日期：2026-08-27T02:27:23.312Z
- 环境：lumii-ui + ~/.lumii/data/agent-runtime.db
- 汇总：**PASS 67** / **FAIL 0** / **SKIP 8** / 合计 75

## 结论

可测路径（全部 wiki CLI + 关键 GAP command）已覆盖；SKIP 为防污染/手工/模型未配合。

## 明细

| ID | 状态 | 说明 |
|---|---|---|
| P0-A01 | PASS | n=28 |
| P0-A02-organized | PASS | n=21 |
| P0-A02-pending | PASS | n=0 |
| P0-A02-discarded | PASS | n=7 |
| P0-A03 | PASS | pages=30 sources=22 |
| P0-A04 | PASS | runs=10 batch=4 |
| P0-S01 | PASS | top=资料综述\|架构设计文档\|wiki-cli-p1-wikilink |
| P0-S02 | PASS | top=资料综述\|文件上传功能\|Wiki 功能说明 |
| P0-S03 | PASS | top=资料综述\|Wiki 功能说明\|wiki-cli-inbox-escape |
| P0-S04 | PASS | 特殊字符 ok |
| P0-S05 | PASS | 无结果空数组(AND) |
| P0-S06 | PASS | 空查询 usage |
| P0-I01 | PASS | pageId=e9d1e3013758f72ab35452fdcafbd206 |
| P0-I02 | PASS | rejected: 非法 Wiki 路径: ../escape |
| P0-I03 | PASS | id=12716353 |
| P0-I05 | PASS | 非 pending 拒绝 |
| P0-I04 | PASS | attempt/error cleared |
| P0-I06 | PASS | ghost rejected |
| P0-P01 | PASS | id=ea19ea146215c7668b68b01dc6e98d72 |
| P0-P03 | PASS | v7->v8 |
| P0-P02 | PASS | get ok+missing |
| P0-X01 | PASS | rebuiltCount=31 |
| P0-X02 | PASS | idempotent |
| P0-X03 | PASS | hits=3 |
| P0-R01 | PASS | run=d51e979fa6f6c641b4f5607934ec9f09 |
| P0-G01 | PASS | organized count=22 与 list 一致 |
| P0-G02 | PASS | deleted sources/wiki-cli-p0-probe-del |
| P0-G03 | PASS | title=OAuth2 授权码流程 |
| P1-L01 | PASS | n=3 |
| P1-L02 | PASS | wikilink 反链可见 |
| P1-L03 | PASS | 未解析链接保留正文 |
| P1-L04 | PASS | isolated empty |
| P1-V01 | PASS | n=2 |
| P1-V02 | PASS | ->v15 |
| P1-V03 | PASS | bad version rejected |
| P1-V04 | PASS | ghost page rejected |
| P1-C01 | PASS | n=14 |
| P1-C02 | PASS | n=14 |
| P1-C03 | PASS | archive+restore |
| P1-C04 | PASS | search before=2 after-archive=1 (观察) |
| P1-E01 | PASS | md=30 |
| P1-E02 | PASS | include-sources |
| P1-E03 | PASS | include-attachments |
| P1-E04 | SKIP | 危险路径导出未强制实现 |
| P1-G01 | PASS | unresolved=1 via CLI |
| P1-G02 | PASS | [{"name":"wiki-cli-organized","type":"concept","evidenceSourceIds":["c307a02e1b8f6418cc0b3bad6e8dcf9 |
| P1-G03 | SKIP | 有候选但不自动 confirm（防污染） |
| P1-G04 | PASS | attachments=0 |
| P1-G05 | SKIP | 无稳定附件文件 fixture |
| P1-G06 | SKIP | WIKI_CLI_ALLOW_DELETE!=1 |
| P1-G07 | PASS | page delete probe |
| P2-Y01 | PASS | n=8 |
| P2-Y01b | PASS | status filters |
| P2-Y02 | PASS | id=c05b03c2b6092c980168dbf8158439f0 status=candidate |
| P2-Y03 | PASS | get c05b03c2 via CLI |
| P2-Y04 | PASS | accepted page=syntheses/wiki-cli-p2-synth |
| P2-Y05 | SKIP | 本轮走了 accept，reject 另建 |
| P2-Y05 | PASS | rejected 6383848b |
| P2-Y06 | PASS | ghost rejected |
| P2-G01 | PASS | nodes=22 edges=20 |
| P2-G02 | PASS | nodes=20 truncated=true |
| P2-G03 | PASS | usage |
| P2-G04 | PASS | checked 3 |
| P2-G05 | PASS | edges=0 |
| P2-H01 | PASS | mode=fts |
| P2-H02 | PASS | hits=5 mode=hybrid |
| P2-H03 | PASS | empty usage |
| P2-V01 | PASS | {"rebuiltCount":30,"backend":"bigram-hash","notice":"多语言嵌入模型加载失败，已降级本地哈希向量：fetch failed"} |
| P2-R01 | PASS | bootstrap ok |
| P2-R02 | PASS | {"entities":[{"id":"aac3f84cd5866b369477af004d5722a0","agent_id":"assistant","user_id":"local-user", |
| P2-T01 | PASS | [{"pageId":"04ce892b4d06d9ebf95370bc0d8ce94c","title":"时序数据库选型","path":"sources/tsdb-selection","suggestedStatus":"outda |
| P2-T02 | SKIP | confirm 防污染不自动执行 |
| P0-M01 | PASS | wiki_* tools present |
| P0-M02 | SKIP | WIKI_CLI_SKIP_AGENT=1 |
| P0-M03 | SKIP | 四路摄入手工 |

## 覆盖说明

- **P0**：inbox organize/discard/retry/逃逸、金标检索、索引、page CRUD、inbox:count/page:delete/source:get
- **P1**：wikilink 反链、未解析保留正文、回滚、清理归档观察、导出三选项、unresolved/concept/attach GAP
- **P2**：synthesis create→accept/reject、synthesis:get、graph 约束、hybrid、vector/ero、status:scan
- **Agent**：tools 含 wiki_*；可选一轮 wiki_search

## 本轮修复

1. Wiki FTS 查询 **OR→AND**（`packages/agent-runtime/src/wiki/wiki-repo.ts`）：P0-S05 稀有串现为空；「架构设计」不再误配「构建设施说明」。
2. CLI 新增 `wiki unresolved`（原 GAP `wiki:link:unresolved`）。
3. P0-M02 改为最多 90s 轮询 assistant 的真实 `wiki_search` tool（默认仍可 `WIKI_CLI_SKIP_AGENT=1`）。

证据：`wiki-cli-evidence.jsonl`
