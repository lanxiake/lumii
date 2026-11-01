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
| `resources/app.asar` | Electron 套壳 | 有 `asar` 命令才解；否则 `strings` 看资源名 |
| `nw.pak` / `nw.dll` | NW.js | 同上 |
| 单文件 exe 很小时外挂 `*.dll` 或 `*.pak` | 安装器/自解压 | 先看同目录文件清单，别假设 exe 自包含 |
| `PyInstaller` / `_MEI` 字符串 | Python 打包 | 能看到归档；解包需外部工具 |

**判断「是不是 Electron」的价值很高**：是的话，业务逻辑多半在 `app.asar` 里的 JS，
比啃原生二进制快得多。

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

## 6. 工具缺席时

| 想做的事 | 需要 | 缺席时 |
|---|---|---|
| 反编译 | Ghidra / IDA / rizin | 停止在字符串、导入表与资源层 |
| 动态调试 | x64dbg / gdb / lldb | 只做外部观察（网络、文件、进程） |
| 解壳 | 调试器 + 手工 | 报告壳类型与依据，不硬做 |
| .NET 反编译 | ILSpy / dnSpy | 只做字符串与元数据层 |
| asar 解包 | `asar` / 7-Zip | `strings` 读资源名，注明未解包 |

报告要写清「因为缺 X，以下结论基于 Y 层」。
