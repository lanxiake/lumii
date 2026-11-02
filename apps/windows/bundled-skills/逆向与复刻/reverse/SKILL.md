---
name: reverse
description: 弄清一个东西是怎样工作的——网页前端、二进制、脚本、协议、数据结构——产出可复核的分析报告，不重建工程。当用户问「这是怎么实现的」「帮我看看它用了什么」「这段代码在干什么」「这个 exe 做了什么」时使用。要重建/复刻用 clone；要对自有目标做安全验证用 redteam / blueteam。
metadata: { "mtbot": { "emoji": "🔬" } }
---

# 逆向分析

## 什么时候不该用它

- 目标站点/软件明确禁止逆向——先确认授权。
- 目的是**重建**——用 `clone`，它产出工程而不是报告。
- 目的是**找洞**——用 `redteam`，它带范围门槛与证据链契约。
- 只想读一段源码——直接读文件，不用走这套流程。

## 先判目标类型

| 目标 | 走哪条 | 参考 |
|---|---|---|
| 网页 / 前端 JS / 单页应用 | 前端线 | [`references/frontend.md`](references/frontend.md) |
| 桌面可执行（PE / ELF / Mach-O） | 桌面二进制线 | [`references/desktop.md`](references/desktop.md) |
| APK / IPA / AAB | 移动端线 | [`references/mobile.md`](references/mobile.md) |
| 脚本 / 库 / 数据文件 | 通用二进制线 | [`references/binary.md`](references/binary.md) |

**只加载对应当前目标的那一份参考**（移动/桌面各一份，别把三份都塞进上下文）。
判不准就先用 `binary.md` 的 triage（文件头 / 大小 / 字符串）判断它到底是什么，再决定。

## 五步

1. **Triage** —— 它是什么？规模多大？值不值得深入？**这一步的结论往往就足够回答用户。**
2. **Static** —— 不运行它的观察：结构、依赖、常量、字符串、导入表、打包产物。
3. **Dynamic** —— 运行时观察：调用链、网络请求、内存里的真实值、DOM 与 computed style。
4. **Synthesis** —— 把观察整理成「它怎么工作」的解释：数据从哪来、经过什么、到哪去。
5. **Write-up** —— 写进 `analysis/`，每条结论带证据。

**先静后动，能停就停**。读完静态就能回答的问题，不要为了"完整"去跑动态。

## 工具

| 目的 | 工具 | 注意 |
|---|---|---|
| 看文件类型/大小 | `bash`（`file` / `du` / `ls -l`） | Windows 上没有 `file` 就用文件头字节 |
| **反编译二进制** | `reverse_probe`（扩展「逆向工具链」提供） | PE/ELF/Mach-O 走 Ghidra；**`.apk` / `.ipa` / Electron 的 `app.asar` 走内置解析（不需要任何外部工具）**。目标是 Electron 应用时它会自己找同目录的 `app.asar`，别去反编译外壳。没有该工具就按参考降级，别去技能目录里找脚本 |
| 搜字符串 | `grep` | 先搜报错文案、URL、密钥前缀，最快定位 |
| 读源码/反编译产物 | `file_read` | 大文件用 offset/limit 分段 |
| 跑命令观察行为 | `bash` | 沙箱外执行，跑来历不明的二进制要谨慎 |
| 打开网页目标 | `browser_navigate` + `browser_snapshot` | 先断言可访问再继续 |
| 看网络请求 | `browser_requests` | 过滤是 URL 子串 |
| 读响应体与头 | `browser_response_body` / 页面内 `fetch()` | 后者能读已加载资源的 content-type |
| 运行时采样 | `browser_eval` | 结果扁平：对象摊在 `result`，标量在 `result.value` |
| 找前端签名 | `browser_requests` + `grep` | 先定位 JS 文件，再搜函数名 |
| 委托深挖 | `spawn_agent` | 只读分析用 `builtin:explore` |

## 产物

落在 `projects/<slug>/analysis/`（目标不是工程时用 `projects/_reverse/<slug>/analysis/`）：

- `overview.md` —— 目标是什么、怎么工作、关键结论
- `evidence.md` —— 每条结论的证据：命令、原始输出、文件路径与行号
- `assets.md` —— 发现的资源、依赖、外部服务（有的话）

**每条结论必须有出处**。读不到、跑不通就写 `UNRESOLVED` 并说明卡在哪，不许猜。
