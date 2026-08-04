# Live2D Cubism Core

此目录用于放置 Live2D 官方的 Cubism Core 运行时。

## 必需文件

```
live2d/
└── live2dcubismcore.min.js
```

## 获取方式

1. 访问 Live2D 官方 Cubism SDK for Web 下载页
2. 下载 SDK 包，取出其中的 `Core/live2dcubismcore.min.js`
3. 放到本目录

## 说明

- `pixi-live2d-display/cubism4` 运行时依赖全局 `window.Live2DCubismCore`
- 渲染进程通过 `cubism-core-loader.ts` 动态注入 `<script src="./live2d/live2dcubismcore.min.js">`
- 文件缺失时宠物模式会显示友好降级提示，不会崩溃
- 该文件遵守 Live2D Proprietary License，分发需遵守其条款

## 打包

`electron-builder.json` 的 `extraResources` 已配置将本目录复制到安装包，
渲染进程在打包后通过相对路径 `./live2d/live2dcubismcore.min.js` 加载。
