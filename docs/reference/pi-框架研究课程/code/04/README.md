# 第 04 篇实验：harness 上下文账本

三个零依赖脚本（Node ≥20，`node xxx.mjs` 直接跑）。默认仓库路径写死为
`temp/pi-course-research/pi` 的克隆；也可传参覆盖：`node 01-tool-token-census.mjs D:/path/to/pi`。

## 01-tool-token-census.mjs

统计 8 个内置工具的两个注入面（API `tools[]` 的 description+schema；提示词 `<tools>/<rules>` 的
snippet+guidelines），token 估算 = chars/4，并与博客实测的 MCP 数字对比。
description/schema/snippet/guidelines 全部从 `packages/coding-agent/src/core/tools/*.ts` 运行时提取，
不手抄（powershell 复用 bash 工厂，表中以 † 标注按继承计）。

真实输出：

```
pi 内置工具上下文注入普查  (est tokens = chars/4)
取证: C:\Users\75791\.lumii\workspace\temp\pi-course-research\pi\packages\coding-agent\src\core\tools

tool           desc  schema API tok prompt tok   默认
----------------------------------------------------------
read*           303     282     147         17   yes
bash*           248     179     107         32   yes
powershell†     248     179     107         27
edit*           326     690     255        150   yes
write*          127     164      73         19
grep            222     784     252         14
find            186     332     130         12
ls              185     212     100          6
----------------------------------------------------------
默认四工具(read/bash/edit/write)  API 注入 ≈ 582 tok   提示词注入 ≈ 218 tok   合计 ≈ 800 tok
八工具全开                        API 注入 ≈ 1171 tok  提示词注入 ≈ 277 tok   合计 ≈ 1448 tok

MCP 对比（2025-11-02 博客实测，tools 数组固定注入）：
  Playwright MCP      21 tools ≈ 13693 tok（占 ~200k 窗口 6.8%）
  Chrome DevTools MCP 26 tools ≈ 17978 tok（占 9.0%）
  作者 browser-ctl    4 脚本 + README 225 tok（按需读取，非常驻）

pi 默认四工具合计是 Playwright MCP 的 5.8%，Chrome DevTools 的 4.4%
```

注：write/powershell 行的 prompt tok 为运行时提取的 snippet+guidelines 合计
（write 的 snippet 短、guidelines 仅一条；powershell 复用 bash 工厂按继承计）。

## 02-minimal-browser-tools/

按《What if you don't need MCP at all?》复刻的 4 个 CDP 风格脚本（start/nav/eval/screenshot）
+ 英文 README。零依赖：无活动 CDP 端点时打印"真实实现将执行的命令"并以退出码 0 结束
（这正是渐进披露演示：agent 读 README、跑一次、从 stdout 学习）。真实实现只需 puppeteer-core。

演示时用 `CDP_PORT=1`（或任何空闲端口）强制走"无浏览器"分支。真实输出：

```
$ node start.mjs
[start] no CDP endpoint at 127.0.0.1:1 — no Chrome found (set CHROME_PATH).
[start] a real implementation would run:
  <chrome-binary> --remote-debugging-port=1 --user-data-dir=...\chrome-profile --no-first-run --headless=new about:blank
[start] then GET /json/version -> webSocketDebuggerUrl, and puppeteer.connect({ browserWSEndpoint }).
exit=0

$ node nav.mjs https://example.com
[nav] no CDP endpoint — run start.mjs first. A real run would execute:
  puppeteer.connect({ browserWSEndpoint: <ws endpoint> })
  page.goto("https://example.com", { waitUntil: "domcontentloaded" }) -> { title, url }
exit=0

$ node eval.mjs "document.title"
[eval] no CDP endpoint — run start.mjs first. A real run would execute:
  Runtime.evaluate(expression, { returnByValue: true }) -> print JSON
  expression: document.title
exit=0

$ node screenshot.mjs page.png
[shot] no CDP endpoint — run start.mjs first. A real run would execute:
  page.screenshot({ path: "...\page.png", fullPage: true }) -> { path }
  (agent reads the file back with the read tool)
exit=0
```

README token 统计（chars/4）：

```
chars=948 est_tokens=237
```

原文 README 实测 225 tokens；本复刻 237，同一量级——这就是替代 13.7k~18k 固定注入的全部成本。

## 03-prompt-inventory.mjs

按 `system-prompt.ts` 的 `buildSystemPromptSections()`/`buildRules()` 逻辑用默认配置重建系统提示词
（各工具 snippet/guidelines 运行时从源码提取），分段统计并逐条列出全部 bullet——"提示词即代码"的
可审计形态。真实输出：

```
pi 默认系统提示词重建清单（buildSystemPromptSections 的默认输出形状）

(untagged) preamble      1 行    27 词  ≈  43 tok
<tools>                  6 行    55 词  ≈  81 tok
<rules>                 10 行   141 词  ≈ 206 tok
<docs>                   8 行   124 词  ≈ 274 tok
(cwd, conditional)       1 行     4 词  ≈   8 tok
----------------------------------------------------------
默认提示词合计 ≈ 604 tok（不含运行时插值与项目上下文）

bullet 逐条清单（可审计面）：
   1. [tools] read: Read file contents
   2. [tools] bash: Execute bash commands (ls, grep, find, etc.)
   3. [tools] edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call
   4. [tools] write: Create or overwrite files
   5. [rules] Use bash for file operations like ls, rg, find
   6. [rules] Use read to examine files instead of cat or sed.
   7. [rules] You can inspect PI_* environment variables for current model and session details.
   8. [rules] Use edit for precise changes (edits[].oldText must match exactly)
   9. [rules] When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls
  10. [rules] Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.
  11. [rules] Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.
  12. [rules] Use write only for new files or complete rewrites.
  13. [rules] Be concise in your responses
  14. [rules] Show file paths clearly when working with files
```
