# Wiki CLI 测试报告（补强）

- 日期：2026-09-09T07:40:16.645Z
- 环境：lumii-ui + ~/.lumii/data/agent-runtime.db
- 汇总：**PASS 25** / **FAIL 39** / **SKIP 13** / 合计 77

## 结论

存在 FAIL，见明细；优先修 CLI/handler 与设计不一致处。

## 明细

| ID | 状态 | 说明 |
|---|---|---|
| P0-A01 | PASS | n=100 |
| P0-A02-organized | PASS | n=100 |
| P0-A02-pending | PASS | n=0 |
| P0-A02-discarded | PASS | n=100 |
| P0-A03 | FAIL | page list |
| P0-A04 | PASS | runs=10 batch=0 |
| P0-S01 | FAIL | search |
| P0-S02 | FAIL | search |
| P0-S03 | FAIL | search |
| P0-S04 | PASS | 特殊字符 ok |
| P0-S05 | FAIL | search 崩溃 |
| P0-S06 | PASS | 空查询 usage |
| P0-I01 | FAIL | organize: {"ok":false,"error":"command_failed","message":"大类不存在：做事记录"}
 |
| P0-I02 | PASS | rejected: 整理入口不允许归到临时存放，请在文件列表中操作 |
| P0-I03 | PASS | id=10cdb82e |
| P0-I05 | PASS | 非 pending 拒绝 |
| P0-I04 | PASS | attempt/error cleared |
| P0-I06 | PASS | ghost rejected |
| P0-F01 | FAIL | scan importable |
| P0-P01 | FAIL | 未知命令: wiki page update，跑 lumii-ui help 查看可用命令
 |
| P0-P03 | FAIL | 未知命令: wiki page update，跑 lumii-ui help 查看可用命令
 |
| P0-P02 | FAIL | 无页 |
| P0-X01 | PASS | rebuiltCount=7 |
| P0-X02 | PASS | idempotent |
| P0-X01 | FAIL | 重建后空 |
| P0-X02 | FAIL | 重建后空 |
| P0-X03 | FAIL | 重建后空 |
| P0-R01 | PASS | run=7846a61c6645456352264db5a0ad7eba |
| P0-G01 | FAIL | count=287 list=100 |
| P0-G02 | FAIL | 无删除目标 |
| P0-G03 | SKIP | 无 sourceId |
| P1-L01 | FAIL | 无架构页 |
| P1-L02 | FAIL | 无架构页 |
| P1-L03 | FAIL | 无架构页 |
| P1-L04 | FAIL | Cannot read properties of null (reading 'pageId') |
| P1-V01 | FAIL | 无页 |
| P1-V02 | FAIL | rollback 页 |
| P1-V03 | FAIL | rollback 页 |
| P1-V04 | FAIL | rollback 页 |
| P1-C01 | PASS | n=0 |
| P1-C02 | PASS | n=0 |
| P1-C03 | SKIP | 无 sourceId |
| P1-C04 | SKIP | 无 sourceId |
| P1-E01 | PASS | md=6 |
| P1-E02 | PASS | include-sources |
| P1-E03 | PASS | include-attachments |
| P1-E04 | SKIP | 危险路径导出未强制实现 |
| P1-G01 | FAIL | 未知命令: wiki unresolved，跑 lumii-ui help 查看可用命令
 |
| P1-G02 | FAIL | {"ok":false,"error":"not_exposed"}
 |
| P1-G03 | SKIP | scan failed |
| P1-G04 | FAIL | 无页 |
| P1-G05 | SKIP | list failed |
| P1-G06 | SKIP | WIKI_CLI_ALLOW_DELETE!=1 |
| P1-G07 | FAIL | Cannot read properties of null (reading 'pageId') |
| P2-Y01 | FAIL | list |
| P2-Y01b | FAIL | list |
| P2-Y02 | FAIL | sources<2 |
| P2-Y03 | SKIP | 无 synthesis |
| P2-Y04 | SKIP | 无 create |
| P2-Y05 | SKIP | 无 create |
| P2-Y06 | PASS | ghost rejected |
| P2-G01 | FAIL | 无中心 |
| P2-G02 | FAIL | cat |
| P2-G03 | FAIL | 期望 2 得 5 |
| P2-G04 | FAIL | 无页 |
| P2-G05 | FAIL | 无法准备孤立页 |
| P2-H01 | FAIL | hits 空 |
| P2-H02 | PASS | hits=0 mode=fts |
| P2-H03 | PASS | empty usage |
| P2-V01 | PASS | {"rebuiltCount":6,"summarized":4,"backend":"transformers","notice":null} |
| P2-R01 | PASS | exit=2 未知命令: wiki ero bootstrap，跑 lumii-ui help 查看可用命令
 |
| P2-R02 | FAIL | {"ok":false,"error":"not_exposed"}
 |
| P2-T01 | FAIL | {"ok":false,"error":"not_exposed"}
 |
| P2-T02 | SKIP | scan failed |
| P0-M01 | FAIL | 缺工具 wiki_capture |
| P0-M02 | SKIP | 90s 内未见 wiki_search tool（模型未配合） |
| P0-M03 | SKIP | 四路摄入手工 |

## 覆盖说明

- **P0**：inbox organize/discard/retry、folder scan/import/organize run、金标检索、索引、page CRUD、inbox:count/page:delete/source:get
- **P1**：wikilink 反链、未解析保留正文、回滚、清理归档观察、导出三选项、unresolved/concept/attach GAP
- **P2**：synthesis create→accept/reject、synthesis:get、graph 约束、hybrid、vector/ero、status:scan
- **Agent**：tools 含 wiki_*；可选一轮 wiki_search

证据：`wiki-cli-evidence.jsonl`
