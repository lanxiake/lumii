# 微信 MCP 集成 · CLI E2E 测试报告

- **生成时间**: 2026-10-07T13:45:00.562Z（开始 2026-10-07T13:36:41.445Z）
- **驱动方式**: 全部经 lumii-ui CLI 真实调用（conversation/send/context 等），真实客户端 + 真实 LLM，无 SQL 播种
- **数据库**: C:\Users\Administrator\.lumii\data\agent-runtime.db
- **微信数据**: 微信 4.x 本机库（只读断言走 devcli.py）
- **探针标记**: WM-DRY-1007133641 / WM-REAL-1007133641 / WM-FAIL-1007133641

## 概要

| 指标 | 值 |
|---|---|
| 总数 | 17 |
| 通过 | 17 |
| 失败 | 0 |
| 跳过 | 0 |
| 通过率 | 100.0% |

## 逐条结果

| ID | 状态 | 说明 | 耗时 |
|---|---|---|---|
| WM-01 | ✅ | 10 个 wechat MCP 工具已注册并启用（list_sessions, read_history, poll_new, check_env, send_text, send_file, send_batch, reply_to, search_messages, list_unread） | 0.2s |
| WM-02 | ✅ | 环境正常：进程运行、窗口可见未最小化、尺寸 677,682（比例 0.993，dpi 96） | 0.3s |
| WM-03 | ✅ | Agent 经 list_sessions 读到会话列表（含「文件传输助手」） | 8.4s |
| WM-04 | ✅ | Agent 经 read_history 读到 filehelper 最近消息（含「[非文本消息]」） | 13.8s |
| WM-05 | ✅ | dry-run 校验通过、未发送（基线后新增 0 条；扫描 3 张表命中 0） | 104.9s |
| WM-06 | ✅ | 真发送成功并落库：WM--EAL--007133641 | 74.1s |
| WM-07 | ✅ | 目标不存在时中止且未发出（基线后新增 0 条 + 全库扫描命中 0） | 24.5s |
| WM-10 | ✅ | Agent 经 send_file 发送图片成功并落库（type=3） | 68.8s |
| WM-11 | ✅ | Agent 经 send_file 发送文件成功并落库（type=49） | 49.1s |
| WM-09 | ✅ | 窗口最小化时被拒且无痕：环境前置检查未通过：主窗口已最小化（微信运行=True，可见=True，最小化=True | 16.5s |
| WM-12 | ✅ | Agent 经 list_sessions(query) 定位到「测试微信群」(50313322756@chatroom) | 10.7s |
| WM-13 | ✅ | 目标不存在时返回稳定错误码 target_not_found（Agent 可据此决策） | 10.7s |
| WM-14 | ✅ | 并发互斥生效：持锁时第二次返回 busy（None），释放后可重入 | 1.3s |
| WM-15 | ✅ | Agent 经 send_batch 演练通过、未发送（基线后新增 0 条 + 全库扫描命中 0） | 34.6s |
| WM-16 | ✅ | 群/单聊误开被「头部更像其它会话」反证拦下（双向 fail-closed） | 2.9s |
| WM-17 | ✅ | Agent 经 reply_to 演练通过、未发送（全库扫描命中 0） | 69.3s |
| WM-08 | ✅ | 普通聊天正常（微信工具不影响基础对话） | 6.0s |

## 失败与跳过明细

无。


## 证据

逐条原始证据见 [wechat-mcp-evidence.jsonl](./wechat-mcp-evidence.jsonl)。
