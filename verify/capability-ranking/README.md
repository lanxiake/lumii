# 能力面排序 · 历史回放评测

配套设计：[`../../docs/design/能力面治理/`](../../docs/design/能力面治理/)。

## 这是什么

用本机真实聊天记录（`~/.lumii/data/agent-runtime.db` 的 `messages` 表）**按时间切分回放**，
比较不同"常驻前 N 个能力"策略的 Recall。严格只用该时刻之前的信息，无数据泄漏。

**它不是测试，是评测工具**——人改排序算法时反复跑它，用数字决定该不该加某一项。

## 用法

```bash
node verify/capability-ranking/replay.mjs              # 分组作用域（推荐口径）
node verify/capability-ranking/replay.mjs --global     # 全局作用域对照
node verify/capability-ranking/replay.mjs --by-agent   # 渠道分组 vs 全局热度
node verify/capability-ranking/replay.mjs --curve      # 扫 N 曲线
```

## 它证明了什么（2026-10-29）

| 策略 | N=20（分组） | N=20（全局） |
|---|---|---|
| 纯近期（LRU） | **93.5%** | **92.5%** |
| 初稿的六项加权公式 | 90.6% | 86.1% |

**简单胜过复杂**：频率项、共现项、会话项全都没有正收益，半衰期怎么调都一样。
设计因此被砍成三行规则（见设计 §5.6.4）。

## 局限（必须知道）

回放基于**全量常驻时产生的真实调用**。一旦真的开始裁剪，模型看到的面变了，它可能改用别的做法
（比如 `file_read` 换成 `bash cat`）。所以 **93.5% 是上界**，上线后会更低。
要回答"裁剪到底伤不伤"，必须补 `tool_exposure_log`（设计 §5.7.1 的 P0 项）。
