# create-lumii-extension

Lumii 扩展脚手架。交互式生成扩展骨架，包含 manifest、IPC 注册、事件订阅示例。

## 使用

```bash
pnpm create lumii-extension
# 或
node packages/create-lumii-extension/dist/index.js
```

回答五个问题（ID、名称、描述、作者、是否需要 IPC/事件），生成目录结构：

```
my-extension/
├── main.ts          # 扩展入口（含 manifest + definition）
├── package.json
├── tsconfig.json
├── README.md
└── .gitignore
```

## 开发流程

1. **编译**：`pnpm build` → 产出 `main.js`
2. **部署**：`cp -r . ~/.lumii/extensions/<id>/`
3. **改代码**：`pnpm build && cp main.js ~/.lumii/extensions/<id>/`
4. **热重载**：Lumii 在 1 秒内自动重载（已修改的扩展）

## 日志

扩展日志在主进程日志里，前缀 `[ext:<id>]`：

- 开发模式：`~/.lumii-dev.log`
- 生产模式：`~/.lumii/logs/app/mtbot-*.log`

## 模板内容

- **Manifest**：id/name/version/engines/kind/origin/main
- **IPC 示例**（可选）：`ctx.registerIpc('ext:<id>:hello', handler)`，通道名约定 `ext:<id>:*`
- **事件示例**（可选）：`ctx.on('app:window-ready', handler)`
- **清理**：`ctx.effect(() => ...)` 在卸载时自动执行

## 依赖

生成的扩展依赖 `@mtbot/plugin-core`（workspace 引用）。开发时需在 Lumii monorepo 内或手动安装 plugin-core。
