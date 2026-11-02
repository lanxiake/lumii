# 桌面程序逆向（PE / ELF / Mach-O）

**目标确认是桌面可执行文件时加载本参考**。`binary.md` 的 Triage 与加壳判断仍然适用，
这里补桌面端特有的结构与签名核验。缺工具就报缺什么，**不要自动安装**。

## 1. 平台与格式

| 文件头 | 平台 | 后续 |
|---|---|---|
| `4D 5A` (`MZ`) | Windows PE | §2 |
| `7F 45 4C 46` | Linux ELF | §4 |
| `CF FA ED FE` / `CA FE BA BE` | macOS Mach-O | §5 |

## 2. Windows PE

```bash
xxd -l 64 app.exe
ls -l app.exe
```

### 结构观察

| 想做 | 命令 | 读什么 |
|---|---|---|
| 节表 | `objdump -h app.exe` | 节名（`UPX0` 等加壳迹象）、大小与熵 |
| 导入表 | `objdump -p app.exe \| grep -iE 'DLL Name\|Name'` | 大致能力（见下表） |
| 导出表 | `objdump -p app.exe \| grep -A200 'Export'` | 是否被别的程序当库调用 |
| 资源 | `wrestool -l app.exe`（若有） | 图标、版本信息、内嵌文件 |
| 版本信息 | PowerShell `(Get-Item app.exe).VersionInfo` | 公司、产品名、原始文件名 |

导入信号速查：

| 导入 | 含义 |
|---|---|
| `WinHttp*` / `WinInet*` / `ws2_32` | 联网 |
| `CreateProcess*` / `ShellExecute*` | 起子进程 |
| `Crypt*` / `BCrypt*` | 加密/哈希 |
| `RegOpenKey*` / `RegSetValue*` | 注册表持久化 |
| `WriteFile` / `DeleteFile` | 落盘、删痕迹 |
| `IsDebuggerPresent` / `NtQueryInformationProcess` | 反调试 |

### 签名核验（Windows 自带，不需要装东西）

```powershell
Get-AuthenticodeSignature .\app.exe | Format-List Status, SignerCertificate
```

`Status` 不是 `Valid` 就如实写「未通过 Authenticode 验证」，**不要自行推断「一定是恶意的」**。

### .NET 程序

`strings app.exe | grep -E 'mscoree|BSJB|System\.'` 命中即为 .NET。
没有 `ILSpy` / `dnSpy` 时只能做字符串与资源层结论；**不要为了反编译去装工具**。

## 3. Electron / 打包器

| 迹象 | 说明 | 做法 |
|---|---|---|
| `resources/app.asar` | Electron 套壳 | **`reverse_probe` 内置解析（§3.1）**，不需要 `asar` 命令 |
| `nw.pak` / `nw.dll` | NW.js | 同上 |
| 单文件 exe 很小时外挂 `*.dll` 或 `*.pak` | 安装器/自解压 | 先看同目录文件清单，别假设 exe 自包含 |
| `PyInstaller` / `_MEI` 字符串 | Python 打包 | 能看到归档；解包需外部工具 |

**判断「是不是 Electron」的价值很高**：是的话，业务逻辑多半在 `app.asar` 里的 JS，
比啃原生二进制快得多。

### 3.1 是 Electron 就走 `reverse_probe`，别喂 Ghidra

```
reverse_probe({ target: "C:/Program Files/某应用/App.exe" })   // 或直接给 .asar / 安装目录
```

工具会**先看同目录 `resources/app.asar`**，找到就走内置 asar 解析（纯 Node，秒级），
不会去反编译那个 Chromium 外壳。输出：

| 段 | 用途 |
|---|---|
| `APP_NAME` / `APP_VERSION` / `APP_MAIN` / `APP_DESCRIPTION` | 一眼认出这是什么应用、从哪启动 |
| `ENTRIES` / `UNPACKED` / `UNPACKED_DIR` | 包里多少文件、有多少实体在 `app.asar.unpacked/` |
| `APP_FILE_COUNT` + `--- APP_FILES ---` | **业务代码在哪**（已排除 `node_modules`，按体积降序） |
| `APP_SOURCEMAPS` / `DEP_SOURCEMAPS` | 业务代码带不带 sourcemap（**带就能读源码，不带只能读结构**） |
| `BYTES_VERIFIED=n/n` | 逐条目 SHA256，asar 头自带——**解包层唯一的客观判据** |

三条口径（写结论时别越过）：

1. **`BYTES_VERIFIED` 只证明「字节读对了」**，不证明「业务逻辑读懂了」。
   `6988/6988` 与 `80840/80840` 是本机两个真实样本的实测值，而它们的 `APP_SOURCEMAPS` 都是 0。
2. **`BYTES_VERIFIED` 的分母不含 `UNPACKED` 条目**——那些实体不在 asar 里，从 asar 无法校验。
   分子分母不等时，差的**正好就是** unpacked 数（`6988 + 29 = 7017`）。
3. **`APP_SOURCEMAPS=0` 不是失败**，只是「业务代码是压缩产物」。这时能拿到的仍然很多：
   文件结构、依赖清单、字体/图片/配置、字符串常量、IPC 通道名。要读逻辑得靠动态观察。

**`unpacked` 是一个静默坑**：按 asar 内的 offset 去读 unpacked 条目，会读到隔壁条目的字节，
不报错、只是数据是错的。要读它们的实体文件，去 `app.asar.unpacked/<同相对路径>`。

（工具内部另有一个只在 Electron 里出现的坑：Electron 把 `.asar` 注册成虚拟目录，
`fs.openSync` 对 asar 文件本身抛 ENOENT、`statSync` 返回 0。工具已改用 `original-fs` 绕过，
用 `bash` 手写脚本时要注意同样的问题。）

**asar 解出来之后**：`out/` 或 `dist/` 下的 renderer 就是一个能跑的前端。把它当**证据源**
（真实组件结构、真实文案、真实样式）去重建可维护的源码；**直接复用解出的 bundle 等于重打包，
不是复刻**（见设计 `2026-11-02-P3-EXE与APP复刻设计.md` §5）。

## 4. Linux ELF

```bash
readelf -h bin            # 类型、架构、入口
readelf -d bin | head -40 # 动态依赖、RPATH
objdump -T bin | head -40 # 动态符号
strings -n 6 bin | head -200
```

- `readelf` / `objdump` 缺席时，退到 `xxd` + `strings`，并注明结论层级。
- `RPATH` 指向不存在的目录、依赖 `libc` 版本很高，都是可复现性线索。
- 静态链接（无 `.dynamic`）时，依赖信息只能从字符串与符号猜，写清不确定性。

## 5. macOS Mach-O

本机通常缺 `otool` / `codesign`：

- `strings` 可读 `Info.plist`、framework 名、URL scheme。
- 签名与公证（notarization）**未核验就写未核验**，不要给「已签名」这种结论。
- Universal binary（`CA FE BA BE`）先按架构拆开再分析。

## 6. Ghidra 反编译（**有 `reverse_probe` 工具就用，比停在 strings 强得多**）

本机装了 Ghidra、且「逆向工具链」扩展开着时，有一个 `reverse_probe` 工具：

```
reverse_probe({ target: "C:/path/app.exe", decompile: 3 })   // decompile 可省，默认 0
```

输出是**稳定的 `KEY=value` 文本**，直接可抄进 `evidence.md`：

| 段 | 内容 | 用途 |
|---|---|---|
| `FORMAT` / `ARCH` / `IMAGEBASE` / `COMPILER` | 格式与架构 | Triage 第一行的硬证据 |
| `FUNCTIONS` | 函数总数 | 「规模多大 / 值不值得深入」 |
| `CAPABILITY.<类>=N` + `.SAMPLE` | 按能力归类的导入（network / process / registry / crypto / file / debugger / inject / service / clipboard / screenshot / keyboard） | **一句话回答「这程序会做什么」** |
| `--- IMPORTS_ALL ---` | 全量导入表 | 需要精确核对时用 |
| `--- STRINGS_OF_INTEREST ---` | URL / 路径 / 凭据关键词 / 报错文案 | 定位外部服务与配置键 |
| `decompile: N` | 最像业务入口的 N 个函数伪代码 | 需要讲清内部流程时用 |

**没有 `reverse_probe` 时**：说明扩展没开或本机没装 Ghidra。调一次它会如实告诉你缺哪个，
然后按 §7 降级（Triage + strings + 导入表）。**不要**去 `skills/` 里找脚本自己跑——
脚本在插件资产里，不在技能目录。

**一次调用跑完，别分段轮询**。`notepad.exe`（534 KB）约 3 分钟，`certutil.exe`（1.9 MB）约 4 分钟。
**同步等它返回**——`nohup … &` 再 `sleep` 轮询会让 Agent 以为没进展而重跑一遍，
真机上就这么白烧了 4 分钟（两次输出逐字节相同，纯浪费）。

两条经实测校准的口径（**别自己另发明**）：

1. **能力标签是「导入了什么」，不是「它干了什么」**。真机实测时 `VirtualAlloc` 被归进 `inject=1`，
   但反查 `CreateRemoteThread` / `WriteProcessMemory` 命中数都是 0——所以「注入了」这个结论不成立。
   做法：看到可疑标签，**回去在 `IMPORTS_ALL` 段核同族导入**，核不上就只写「导入了 X」。
2. **`decompile` 取的是「最像业务入口」的函数**，已排除 CRT 样板（`__security_check_cookie` 这类
   在真机上引用数最高，不排除就会只看到三个样板函数）。伪代码里的 `FUN_xxx` 是 Ghidra 未识别的名字，
   如实照抄，**不要自己起名**。

耗时参考：`notepad.exe`（534 KB）完整分析约 3 分钟；`certutil.exe`（1.9 MB）约 4 分钟。
**先跑 `decompile: 0`**（多数问题在这一步就有答案），需要流程细节再加大。

## 7. 工具缺席时

| 想做的事 | 需要 | 缺席时 |
|---|---|---|
| 反编译 | Ghidra / IDA / rizin | 停止在字符串、导入表与资源层；**先报缺什么**，别假装做了 |
| 动态调试 | x64dbg / gdb / lldb | 只做外部观察（网络、文件、进程） |
| 解壳 | 调试器 + 手工 | 报告壳类型与依据，不硬做 |
| .NET 反编译 | ILSpy / dnSpy | 只做字符串与元数据层 |
| asar 解包 | 无（`reverse_probe` 内置） | `reverse_probe` 缺席时才退到 `strings` 读资源名，并注明未解包 |

报告要写清「因为缺 X，以下结论基于 Y 层」。
