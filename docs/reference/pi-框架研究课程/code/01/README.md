# 第 01 篇实验：仓库考古与分层测绘

两个零依赖脚本（Node >= 20），对 pi 仓库的本地克隆做只读分析，复现第 01 篇里的全部 git 数字与分层表。

## 前置条件

一个 pi 仓库的本地克隆（只读即可，脚本不写任何文件）：

```bash
git clone --filter=blob:none https://github.com/earendil-works/pi /path/to/pi
```

脚本默认路径为课程研究克隆 `C:/Users/75791/.lumii/workspace/temp/pi-course-research/pi`；其它路径作参数传入。需要系统 `git` 在 PATH 中。

## 实验一 `01-history-miner.mjs` —— git 考古

验证什么：第 01 篇第 2 节的时间线论断全部可复算——总量（commits/tags/首末提交）、月度提交柱状图（三个波峰：2025-12 / 2026-01 / 2026-08）、各 `packages/*` 首次进入历史的提交（包的出生顺序=战略顺序）、commit 主题词频 top20（工程重心，已滤除 merge/release 等发布自动化噪音词）。

```bash
node 01-history-miner.mjs            # 用默认克隆路径
node 01-history-miner.mjs D:/repos/pi  # 或指定路径
```

真实输出（快照 2026-09-23，本地克隆 HEAD `b313731b`）：

```
==============================================================
仓库：C:\Users\75791\.lumii\workspace\temp\pi-course-research\pi
总提交数：6505    tag 数：319
首次提交：2025-08-09 a74c5da1 Initial monorepo setup with npm workspaces and dual TypeScript configuration
最新提交：2026-09-23 b313731b feat: add JSONL sidecar reclamation
--------------------------------------------------------------
月度提交数：
  2025-08    85  ###
  2025-09    53  ##
  2025-10   129  ####
  2025-11   280  #########
  2025-12   872  ############################
  2026-01  1224  ########################################
  2026-02   377  ############
  2026-03   418  ##############
  2026-04   461  ###############
  2026-05   481  ################
  2026-06   424  ##############
  2026-07   494  ################
  2026-08   889  #############################
  2026-09   318  ##########
--------------------------------------------------------------
各包首次出现的提交（目录首次进入历史的时间）：
  agent            2025-08-09 a74c5da1 Initial monorepo setup with npm workspaces and dual TypeScript configuration
  ai               2025-08-17 f064ea0e feat(ai): Create unified AI package with OpenAI, Anthropic, and Gemini support
  chord            2026-08-28 28b49a6b feat: add Chord runtime foundation
  client           2026-07-31 33bc0a7b feat(client): add runtime-neutral session client
  coding-agent     2025-10-17 ffc9be88 Agent package + coding agent WIP, refactored web-ui prompts
  durable          2026-09-18 08016016 feat(durable): move Pico into dedicated package
  evals            2026-07-25 eafe11fb feat(coding-agent): add vitest eval harness (#7085)
  protocol         2026-07-30 56eb685b feat(protocol): add remote session wire protocol
  server           2026-07-21 8495f9d0 chore: rename orchestrator to server (#6898)
  session-backends 2026-08-05 a80008b9 chore: rename storage package to session-backends
  telemetry        2026-08-05 6b461b75 feat: extract telemetry package
  tui              2025-08-09 a74c5da1 Initial monorepo setup with npm workspaces and dual TypeScript configuration
--------------------------------------------------------------
commit 主题词频 top20（去掉 conventional-commit 前缀与停用词）：
   322  session
   300  tool
   266  section
   252  model
   213  remove
   201  request
   193  cycle
   192  next
   191  models
   189  approve
   181  provider
   173  branch
   167  extension
   165  thinking
   155  compaction
   151  test
   150  api
   148  prompt
   145  contributor
   131  context
==============================================================
```

克隆不存在时的真实行为（退出码 1，给出克隆指引而非堆栈）：

```
[错误] 路径不存在：C:\nope\pi

本实验需要一个 pi 仓库的本地克隆（只读即可）。克隆方法：
  git clone --filter=blob:none https://github.com/earendil-works/pi "C:\nope\pi"
然后把路径作为参数传入：node 01-history-miner.mjs /path/to/pi
```

## 实验二 `02-repo-map.mjs` —— 分层测绘

验证什么：第 01 篇第 4 节的架构论断可复算——扫 `packages/*`（含 `session-backends/sqlite-node` 等嵌套包）的 `package.json`，取 `dependencies`/`peerDependencies` 里的 `@earendil-works/*` 作内部依赖边，做拓扑分层（层 0 = 零 Pi 依赖），并统计各包 `src/` 下 TS 源码文件数与字节数。亲眼确认两件事：`tui` 与 `chord` 都在层 0；`coding-agent` 的体量超过下面所有层之和。

```bash
node 02-repo-map.mjs
```

真实输出（同一快照）：

```
包名                                  src TS  src 体量  层  内部依赖 -> 外部依赖数
tui                                   42     566 KB   0   [无] -> 2
chord                                 34     364 KB   0   [无] -> 1
evals                                  5      54 KB   0   [无] -> 0
telemetry                              6      31 KB   0   [无] -> 0
ai                                   182     857 KB   1   [pi-telemetry] -> 9
protocol                               8      28 KB   1   [chord] -> 1
agent                                117    1120 KB   2   [chord, pi-ai, pi-telemetry] -> 4
durable                               16     158 KB   2   [chord, pi-ai] -> 0
client                                 8      35 KB   2   [chord, pi-protocol] -> 0
coding-agent                         274    2459 KB   3   [chord, pi-agent-core, pi-ai, pi-tui] -> 15
session-backends/sqlite-node          15      68 KB   3   [pi-ai, pi-agent-core] -> 0
server                                16      65 KB   3   [chord, pi-agent-core, pi-protocol] -> 0
coding-agent/install-lock              0       0 KB   4   [pi-coding-agent] -> 0

分层解读：层 0 = 不依赖任何 Pi 包（可独立复用）；层 N = 依赖层 < N 的包。
注意 chord 在层 0 —— 它是独立的应用组合运行时，不依赖任何其它 Pi 包。
```

说明：`install-lock` 是 coding-agent 的锁文件校验辅助子包，无 src，出现在层 4 属正常；文章第 4 节的表已略去它。

## 与文章不一致怎么办

数字以你本机克隆的 HEAD 为准。文章标注快照日期为 2026-09-23；之后仓库继续演进，月度柱状图最后一格和词频会变化——这正是要你自己跑一遍的原因。
