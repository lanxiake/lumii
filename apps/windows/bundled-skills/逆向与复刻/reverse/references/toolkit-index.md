# 逆向工具与知识库索引

**这份是索引，不是教程**。遇到「这个格式怎么解」「这个壳怎么认」「有没有现成工具」时先来这里，
再决定要不要动手。每条都标了**本机有没有**——没有的不假装能跑，写清替代路径。

来源：[morluto/awesome-reverse-engineering](https://github.com/morluto/awesome-reverse-engineering)（精选索引）、
各工具官方文档、以及本仓库自己踩过的坑（标 `〔实测〕`）。

---

## 0. 先查「本机有什么」

```bash
# 一次性盘一遍（Git Bash）
for t in ghidra radare2 r2 rizin rz-bin objdump readelf nm strings binwalk upx \
         jadx apktool frida adb gdb lldb otool codesign; do
  printf '%-10s %s\n' "$t" "$(command -v $t || echo '-')"
done
```

**本机实测基线（2026-11-03）**：

| 有 | 没有 |
|---|---|
| Ghidra 12.1.4（`C:/myself/tools/ghidra_12.1.4_PUBLIC`）、JDK 21 | radare2 / rizin / objdump / readelf / nm / strings / binwalk / upx |
| 托管 Python（`~/.lumii/runtimes/python-embed/python.exe`） | jadx / apktool / frida / adb / gdb / lldb |

**但这不代表「什么都不能做」**：`reverse_probe` 的四个内置后端（APK / AAB / IPA / asar）
本来就是纯 Node，本机零依赖。上面缺的那批是「更深一层」的工具。

---

## 1. 通用二进制（PE / ELF / Mach-O）

| 工具 | 用来做什么 | 本机 | 缺席时 |
|---|---|---|---|
| **Ghidra** | 反汇编 + 反编译 + 调用图 | ✅ | —— |
| `reverse_probe` | 函数数、能力分类、字符串、反编译片段 | ✅ | —— |
| IDA Pro / Free | 交互式反汇编（Ghidra 的商业对手） | ❌ | 用 Ghidra |
| radare2 / rizin | 命令行反汇编、打补丁、脚本化 | ❌ | Ghidra headless 脚本 |
| objdump / readelf / nm | 快速看节表 / 导入导出 / 符号 | ❌ | Ghidra 的 `IMPORTS_ALL` 段 |
| `strings` | 抓字符串 | ❌ | Node 读文件按可打印字节切；`reverse_probe` 的 `STRINGS_OF_INTEREST` |
| binwalk | 扫内嵌文件 / 固件切分 | ❌ | 手工按魔数（见 §5） |
| UPX | 脱 UPX 壳 | ❌ | 先判定（`reverse_probe` 的节名/熵），脱壳超出范围 |

**知识库入口**：
- [Ghidra 官方 docs](https://ghidra-sre.org/) 与 `support/analyzeHeadless` 用法
- [Malware Unicorn RE101/102](https://malwareunicorn.org/) —— 从零到能读反编译
- [Practical Malware Analysis](https://nostarch.com/malware) —— 配套实验（书里的 lab 是 PE）
- [RE for Beginners (Dennis Yurichev)](https://beginners.re/) —— 免费，讲「为什么这样反编译」

---

## 2. Android（APK / AAB / DEX）

| 工具 | 用来做什么 | 本机 | 缺席时 |
|---|---|---|---|
| **`reverse_probe`（内置）** | 包信息 / 权限 / 组件 / dex 字符串池 / **类的方法名** / 加固框架判定 | ✅ | —— |
| jadx | Java/Kotlin **反编译成源码** | ❌ | 只能到方法名层（内置已覆盖）；要读方法体必须装 jadx |
| apktool | 资源反编译 + 重打包 | ❌ | 内置能读 AXML；重打包不做 |
| `aapt2` / `apkanalyzer` | 官方 manifest 解析 | ❌ | 内置 AXML 解析器已覆盖常用字段 |
| bundletool | AAB → APK（安装形态、签名） | ❌ | 内置只做**静态结构**；要看分发后的 split 必须装 |
| frida | 运行时 hook（脱壳、抓解密后的 dex） | ❌ | **脱壳不做**，见下方 |
| adb | 装包 / logcat / 模拟操作 | ❌ | 动态观察样样做不了 |

**知识库入口**：
- [OWASP MASTG](https://mas.owasp.org/MASTG/) —— 移动应用安全测试的**权威手册**，反编译/动态/网络全覆盖
- [Android 官方 DEX 格式](https://source.android.com/docs/core/runtime/dex-format) —— 内置解析器的依据
- [Frida 文档](https://frida.re/docs/home/) —— 动态插桩
- [jadx wiki](https://github.com/skylot/jadx/wiki) —— 反编译失败时怎么办

**加固 / 脱壳的边界**（`〔实测〕` 反复确认过）：
出现 `libjiagu.so` / `libshell*.so` / `libnesec.so` 只说明**疑似加固**。
**脱壳超出范围**——它需要 frida + 反调试对抗 + dump 内存，不是「读一下」的事。
报告里写清「疑似加固 + 依据」，不要试图脱。

---

## 3. iOS（IPA / Mach-O）

| 工具 | 用来做什么 | 本机 | 缺席时 |
|---|---|---|---|
| **`reverse_probe`（内置）** | Info.plist、权限用途、Mach-O 加密状态、框架、描述文件 | ✅ | —— |
| otool / nm | Mach-O 结构 / 符号 | ❌（需 macOS） | 只能到 plist 层 |
| codesign | 签名核验 | ❌（需 macOS） | **恒为 `SIGN_CODE=UNRESOLVED`**，如实写 |
| class-dump / Hopper | ObjC 类结构 / 反汇编 | ❌ | —— |
| frida-ios-dump | 脱壳（App Store 包代码段加密） | ❌ | `ENCRYPTED=yes` 时静态反汇编本来就没意义 |

**知识库入口**：
- [OWASP MASTG — iOS](https://mas.owasp.org/MASTG/iOS/) 
- [Apple Mach-O 格式](https://developer.apple.com/documentation/xcode/) 
- [objc.io 的 Mach-O 系列](https://www.objc.io/issues/6-build-tools/mach-o-executables/)

---

## 4. 桌面壳（Electron / NW.js / PyInstaller / .NET / Flutter）

| 目标 | 认它的依据 | 解它 | 本机 |
|---|---|---|---|
| **Electron** | `resources/app.asar` | **`reverse_probe` 内置**：读头 + 逐条 SHA256 + `extractTo` 解包 + `read` 读单文件 | ✅ |
| NW.js | `nw.pak` / `nw.dll`，JS 在 `package.nw/` | 同 asar 思路（`.pak` 是 v8 快照） | 未实现 |
| PyInstaller | `_MEI` / `PYZ\0` / `pyi-` | pyinstxtractor | ❌ |
| .NET | `BSJB` 签名 | ILSpy / dnSpy | ❌ |
| Flutter | `libflutter.so` / `flutter_windows.dll` | Dart 快照，只能到外观层 | ❌ |
| Unity | `UnityPlayer.dll` / `*_Data/Managed` | AssetStudio / Il2CppDumper | ❌ |

**asar 的两个坑**（`〔实测〕`，`reverse_probe` 已处理）：
1. `dataStart` 是 `8 + u32@4`，不是 `8 + u32@12`；
2. `unpacked:true` 的条目**不在 asar 里**，在同目录 `app.asar.unpacked/`。

**知识库入口**：
- [electron/asar 格式说明](https://github.com/electron/asar)
- [PyInstaller 归档格式](https://github.com/pyinstaller/pyinstaller/blob/develop/PyInstaller/archive/readers.py)
- [dnSpy / ILSpy](https://github.com/icsharpcode/ILSpy)

---

## 5. 格式识别速查（不装工具也能认）

按魔数读头 16 字节（`xxd -l 16`，或用 Node `fs.readFileSync(path).subarray(0,16)`）：

| 魔数 | 是什么 | 下一步 |
|---|---|---|
| `4D 5A` (`MZ`) | Windows PE | Ghidra |
| `7F 45 4C 46` | ELF | Ghidra |
| `CF FA ED FE` / `CA FE BA BE` | Mach-O（后者是 universal） | 内置 / 需 macOS 工具 |
| `50 4B 03 04` (`PK`) | zip 家族：apk/aab/ipa/jar/docx/xpi/asar 容器 | 再看内部结构 |
| `dex\n035` | DEX | 内置 |
| `62 70 6C 69 73 74` (`bplist`) | 二进制 plist | 内置 |
| `FF D8 FF` | JPEG | —— |
| `89 50 4E 47` | PNG | —— |
| `7F 45 4C 46` | ELF | —— |
| `1F 8B` | gzip（常见于内嵌 tar） | zlib 解压 |
| `FD 37 7A 58 5A 00` | XZ | —— |
| `37 7A BC AF 27 1C` | 7z | —— |
| `52 61 72 21` (`Rar!`) | RAR | —— |

**内嵌文件扫描**（没有 binwalk 时）：把整个文件按这些魔数做字节搜索，命中的位置就是可能的起点。

---

## 6. 前端 / JS 逆向

| 工具 | 用来做什么 | 本机 |
|---|---|---|
| `browser_*` 工具组 | 打开页面、抓请求、读 computed style、跑 eval | ✅ |
| Chrome DevTools | Sources / Network / Overrides / 断点 | ✅（浏览器自带） |
| `reverse_probe` 的 Electron 后端 | 解 asar 拿 bundle | ✅ |
| de4js / js-beautify | 解混淆 / 美化 | ❌（可用 Node 侧的 prettier） |
| sourcemap 还原 | 有 `.map` 就能拿回原始源码 | 依赖目标是否带 map |

**知识库入口**：
- [MDN — 浏览器调试](https://developer.mozilla.org/en-US/docs/Tools)
- [javascript-obfuscator 手法](https://github.com/javascript-obfuscator/javascript-obfuscator) —— 知道它怎么混淆才知道怎么读

---

## 7. 遇到困难时的顺序

不要一上来就上重工具。按这个顺序试，**每层都能给出有用结论**：

1. **认格式**（§5 魔数）→ 知道它是什么，这一步 30 秒
2. **看内置能覆盖多少**（`reverse_probe`）→ APK/AAB/IPA/Electron 四类直接出结果
3. **看字符串与导入**（Ghidra / `STRINGS_OF_INTEREST`）→ 常见问题到这就够了
4. **反编译少量函数**（`decompile: N`）→ 需要讲清流程时
5. **全量反编译 + 调用图**（Ghidra GUI）→ 需要深入时，成本高

**卡住时的三个问题**（比换工具更有用）：
- 我是**读不到**，还是**读不懂**？读不到是工具问题，读不懂是知识问题。
- 我需要的结论，**上一层能不能给**？（八成能）
- 我现在的结论**有证据吗**？没有就先别往下走。

---

## 8. 索引之外的硬约束

- **缺工具就报缺什么**，不要自动安装。用户装什么由他决定。
- **不执行来路不明的二进制**。要看动态行为，由用户准备隔离环境（本机无沙箱，见设计 §4）。
- **读不到就写 `UNRESOLVED`**，不猜。半对的结论比没有更糟。
