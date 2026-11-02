# 移动端逆向（APK / IPA）

**只在目标确认是移动应用时加载本参考**。缺工具就报缺什么，**不要自动安装**。

## 1. 先确认包型

| 文件头 / 扩展名 | 实际是什么 | 走哪条 |
|---|---|---|
| `PK` + `.apk` | Android 应用（本质是 zip） | **先用 `reverse_probe`（§3.0），再按 §2 手工补** |
| `PK` + `.ipa` | iOS 应用（本质是 zip） | §4 |
| `PK` + `.aab` | Android App Bundle | 解包后同 §2，但资源按模块分 |
| `.xapk` / `.apks` | 分包/包裹格式 | 解包后按 APK 处理 |

```bash
xxd -l 16 app.apk          # 确认 PK\x03\x04
unzip -l app.apk | head -40
```

## 2. APK 静态结构

```bash
unzip -o -d apk_unpacked app.apk
ls apk_unpacked
```

关键文件：

| 路径 | 看什么 |
|---|---|
| `AndroidManifest.xml` | 二进制 XML；直接 `strings` 能读权限、activity 名、SDK 版本 |
| `classes*.dex` | Java/Kotlin 字节码（多 dex 时按编号） |
| `lib/<abi>/*.so` | 原生库；`libflutter.so` / `libhermes.so` / `libreactnativejni.so` 直接暴露框架 |
| `assets/` | 内嵌配置、JS bundle、模型、证书 |
| `META-INF/` | 签名信息（v1） |

**不用反编译器也能拿到的结论**：

```bash
# 权限与组件
strings apk_unpacked/AndroidManifest.xml | grep -iE 'permission|activity|service|receiver|provider' | head -40

# 外连与密钥前缀
grep -a -oE 'https?://[a-zA-Z0-9./?=_-]+' apk_unpacked/classes*.dex | sort -u | head -30

# 框架判定
ls apk_unpacked/lib/*/ 2>/dev/null
ls apk_unpacked/assets/ | head -30
```

## 3. 代码层

### 3.0 先用 `reverse_probe`（**不需要装任何工具**）

目标以 `.apk` 结尾时，`reverse_probe` 走**内置 APK 解析**（纯 Node，不依赖 jadx/aapt）：

```
reverse_probe({ target: "C:/path/app.apk", dexLimit: 8 })
```

秒级返回，`KEY=value` 文本可直接抄进 `evidence.md`：

| 段 | 内容 |
|---|---|
| `PACKAGE` / `VERSION_NAME` / `MIN_SDK` / `TARGET_SDK` | 包标识与兼容范围 |
| `PERMISSIONS` / `PERMISSIONS_SENSITIVE` + `--- PERMISSIONS ---` | 全量权限，敏感项单独计数 |
| `COMPONENT.<type>` / `EXPORTED_COMPONENTS` + `--- EXPORTED ---` | 组件数与**对外可见**的组件（攻击面） |
| `DEX_COUNT` / `DEX_READ` / `URL_COUNT` + `--- URLS_IN_DEX ---` | dex 里的外连域名 |
| `CLASS_DESC_COUNT` + `--- CLASSES_SAMPLE ---` | 类名样本（判断用了什么 SDK） |
| `ABIS` / `NATIVE_LIBS` + `--- NATIVE_LIBS ---` | 原生库与 ABI |
| `PACKER_SUSPECT` | 加固**迹象**（命中特征名，不是「一定是壳」） |
| `FRAMEWORK` | Flutter / RN / Unity / Electron 套壳等 |
| `SIGNATURE_FILES` | v1 签名文件（`META-INF/*.RSA` 等） |

**它不做字节码反编译**——`CLASS_DESC_COUNT` 是类名，不是逻辑。要读 Java/Kotlin 代码
仍然需要 jadx（§3.1）。这是刻意的边界：半对的反编译比「没做」更误导。

两个口径：

1. `dexLimit` 默认 8——大包有几十个 dex，全解会慢。`DEX_READ=8/40` 这种写法就是在告诉你
   **只看了前 8 个**，别把「没搜到 URL」当成「没有外连」。
2. `PACKER_SUSPECT` 命中只说明**存在对应特征文件**。写结论时带依据（哪个 `.so`），
   不要说「已加固、无法分析」——本工具本来就没打算脱壳。

### 3.1 需要读代码时（依赖外部工具，缺席就如实说）

| 想做的事 | 需要 | 缺席时 |
|---|---|---|
| 读 manifest 明文（更完整） | `aapt dump xmltree` / `apkanalyzer` | `reverse_probe` 已覆盖常用字段 |
| Java/Kotlin 反编译 | `jadx` | 报告「只有类名与字符串，未反编译」 |
| 原生库符号 | `nm` / `objdump` | 只能看字符串与导入（`reverse_probe` 也可对 `.so` 跑） |
| 验签 | `apksigner verify` / `jarsigner -verify` | 报告未验签，不猜 |

**加固 / 脱壳**：出现 `libjiagu.so`、`libshell*.so`、`libnesec.so`，或 dex 极小而
`assets/` 里带加密 jar——判定为**疑似加固**并写清依据。**脱壳超出范围**，不要尝试。

**JS/跨端框架**：`assets/index.android.bundle`（RN）、`assets/flutter_assets/`（Flutter）、
`assets/app.asar`（Electron 套壳）都按**文本/资源**读，别当二进制硬啃。

## 4. IPA 静态结构

```bash
unzip -l app.ipa | head -40
unzip -o -d ipa_unpacked app.ipa
ls ipa_unpacked/Payload/*.app | head -40
```

| 路径 | 看什么 |
|---|---|
| `Payload/*.app/Info.plist` | 可能是二进制 plist；`strings` 能读键名与 URL scheme |
| `Payload/*.app/PlugIns/` | 扩展（widget / share）各自有 Info.plist |
| `Frameworks/` | 动态库与跨端框架（Flutter / RN / Unity） |
| `embedded.mobileprovision` | 描述文件（团队、权限、有效期） |
| 可执行文件 | Mach-O；`otool -L` / `nm` 需 macOS 工具 |

签名核验在本机通常缺 `codesign`，**如实写「未核验签名」**，不要给假结论。

## 5. 动态观察的边界

移动端动态一般在设备/模拟器上做，本机默认**没有** `adb` / `frida` 之类的通道：

- 先检查 `adb devices` 是否真的可用；不可用就停在静态结论。
- 不要为了「跑起来」建议用户装来源不明的模拟器或提权工具。
- 能在静态层回答的问题（权限、外连域名、框架、加固迹象），不要硬转动态。

## 6. 报告要求

- 每条结论写清**依据的文件与命令**（`unzip -l` 输出、`strings` 命中行）。
- 工具缺席写「因为缺 X，结论停在 Y 层」。
- 读不到的写 `UNRESOLVED`，不猜。
