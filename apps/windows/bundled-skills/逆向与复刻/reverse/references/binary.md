# 二进制 / 脚本逆向

**本机不一定装了逆向工具**。缺什么就报什么，不要让用户以为「工具坏了」，也**不要自动安装**。

## 1. Triage（大多数问题到这步就有答案）

```bash
# 文件头 + 大小 + 哈希
xxd -l 64 <file>            # Windows PowerShell: Format-Hex -Path <file> -Count 64
ls -l <file>                # PowerShell: Get-Item <file> | Select Length

# 可读字符串（最快定位用途）
strings -n 6 <file> | head -200             # 没有 strings 就用 grep -a 兜底
grep -a -oE 'https?://[a-zA-Z0-9./?=_-]+' <file> | sort -u | head -30
grep -a -oE '[A-Za-z]:\\\\[^"<>|*?]+' <file> | head -20   # Windows 路径
```

文件头判类型（`xxd`/`Format-Hex` 结果的前几字节）：

| 头 | 类型 | 后续 |
|---|---|---|
| `4D 5A` (`MZ`) | Windows PE（exe/dll） | 看导入表、看是否加壳 |
| `7F 45 4C 46` (`\x7fELF`) | Linux ELF | 看 ELF 头与动态段 |
| `CF FA ED FE` / `CA FE BA BE` | Mach-O / Fat | macOS |
| `50 4B 03 04` (`PK`) | ZIP / jar / apk / nupkg | 先解包，别当二进制 |
| `23 21` (`#!`) | 脚本 | 直接读源码 |
| `1F 8B` | gzip | 解压后再判 |
| 无特征 + 熵很高 | 可能加壳/加密 | 见 §3 |

**「`PK` 开头」是最容易搞错的一类**：`.exe` 可能是自解压包，`.jar`/`.apk` 本质是 zip。先解包。

## 2. 结构观察（不开反编译器也能做很多事）

```bash
# 导入/导出（有 objdump 时）
objdump -p <file> | head -60          # PE 导入表
objdump -p <file> | grep -iE 'dll|Name' | head -40

# 节表（看出有没有加壳：UPX0/UPX1 这类名字）
objdump -h <file>

# 符号（未 strip 时有）
nm -C <file> 2>/dev/null | head -60
```

从导入表能读出它**大致会做什么**：`WinHttp*`（联网）、`CreateProcess*`（起子进程）、
`Crypt*`（加密）、`Reg*`（注册表）、`WriteFile` + `DeleteFile`（落盘删痕迹）。

## 3. 加壳 / 混淆的判断

| 迹象 | 含义 |
|---|---|
| 节名 `UPX0` / `.aspack` / `.themida` | 已知壳 |
| 原始大小 ≪ 虚拟大小，且只有一个可执行节 | 常见加壳特征 |
| 导入表极小（只有 `LoadLibrary`/`GetProcAddress`） | 运行时解析 API，典型壳或 loader |

**解壳超出本技能范围**。如实报告「疑似加壳、壳类型 X」，把是否继续交给用户决定；
不要为了"完成"去尝试自动化 unpack —— 那通常需要调试器交互，硬做只会得到假结论。

## 4. 动态观察（谨慎）

跑来历不明的二进制有风险。**先问用户是否允许**，并尽量在隔离环境里做。

```bash
# Windows：看它会连哪（需要目标自己跑起来，别在不信任的文件上直接双击）
netstat -ano | findstr <PID>

# 看它创建了哪些文件（Process Monitor 更直观，但需用户手动装）
```

能观察到的典型信号：外连地址、落盘路径、注册表键、子进程链。

## 5. 工具缺席时怎么办

| 想做的事 | 需要什么 | 缺席时 |
|---|---|---|
| 反编译成伪代码 | Ghidra / IDA / rizin | 只能做字符串与导入表层面的结论，如实说明 |
| 动态调试 | x64dbg / gdb | 只能做运行时外部观察（网络、文件、进程） |
| 解壳 | 调试器 + 手工 | 报告壳类型，不硬做 |

**有 `reverse_probe` 工具就走反编译**（PE / ELF 都行，用法见 [`desktop.md`](desktop.md) §6）：
它会给出函数数、按能力归类的导入、可疑字符串，比 `strings` 猜得准得多。
没有这个工具（扩展没开 / 本机没装 Ghidra）就按 §5 的降级路径走，**并如实说明缺什么**。

**报告里要写清「因为缺 X，以下结论是基于 Y 层面的推断」**——这比给一个漂亮但无依据的结论有用得多。
