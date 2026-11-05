# 录屏采集链路探针

2026-11-05 现场：面板里选窗口点「开始录制」，录制立刻结束、无产物、界面无提示。
这三个裸 Electron 脚本把「窗口源到底断在哪一步」逐段问出来，不依赖正在运行的客户端。

跑法（在仓库根目录）：

```bash
E=node_modules/.pnpm/electron@36.9.5/node_modules/electron/dist/electron.exe

# 1. 每个窗口源能否起 getUserMedia（最直接的判据）
node $E verify/screen-record/probe-windows.cjs [名字子串...]

# 2. 完整链路：getSources → getUserMedia → 画布合成 → MediaRecorder 3s 分片
node $E verify/screen-record/probe-capture.cjs [名字子串，默认 LiteShell]

# 3. GPU 特性状态 + getDisplayMedia 路径
node $E verify/screen-record/probe-wgc.cjs [名字子串]
```

## 当时的结论（别再重复踩）

| 观察 | 含义 |
|---|---|
| 24 个窗口源全部 `NotReadableError: Could not start video source` | 不是某个窗口的问题 |
| `desktopCapturer.getSources` 的缩略图**正常** | 所以面板列得出源、点了才失败 |
| `screen:0:0` 能录 6 秒、拿到分片 | 整屏走的是另一条捕获路径 |
| `gpu_compositing: disabled_software`，DXGI duplicator 初始化失败 | WGC 窗口捕获起不来 |
| `--disable-features=AllowWgcWindowCapturer` 后窗口源立刻可录 | 根因确认 |

对应的修复在 `apps/windows/src/main/index.ts`（**刻意不开** `AllowWgcWindowCapturer`）。
换机器后如果窗口录制又失败，先跑 `probe-wgc.cjs` 看 `gpu_compositing` —— 若不再是
`disabled_software`，可以考虑把 WGC 开回来（代价见那里的注释）。
