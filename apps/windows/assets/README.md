# Assets 目录

## 必需文件

打包前请确保以下文件存在：

### icon.ico
- 应用图标，用于：
  - 安装程序图标
  - 任务栏图标
  - 桌面快捷方式图标
  - 窗口标题栏（系统）
- **由 `logo.png` 生成**：`pnpm generate:icon`
- 推荐尺寸：256x256 或更大
- 支持的尺寸层级：16x16, 24x24, 32x32, 48x48, 64x64, 128x128, 256x256

### logo.png
- 产品主 Logo（侧栏 / 关于页 / 标题栏 UI）
- 也是生成 `icon.ico` / `icon.png` / `tray-icon.png` 的唯一源图

### tray-icon.png
- 系统托盘专用 32×32 PNG（由 logo.png 生成，托盘缩放到 16px 显示）

### icon.png (可选)
- PNG 格式图标（256×256，由 logo.png 生成）
- 备选托盘 / 窗口图标

### installer-header.bmp (可选)
- 安装程序标题区域图片
- 尺寸：150x57 像素
- 24-bit BMP 格式
- 用于经典安装程序界面的顶部横幅

### installer-sidebar.bmp (可选)
- 安装程序侧边栏图片
- 尺寸：164x314 像素
- 24-bit BMP 格式
- 用于欢迎页和完成页的左侧图片

### uninstaller-sidebar.bmp (可选)
- 卸载程序侧边栏图片
- 尺寸：164x314 像素
- 24-bit BMP 格式
- 如果不提供，将使用 installer-sidebar.bmp

## 创建图标

### 方法一：使用在线工具
可以使用在线工具将 PNG 转换为 ICO：
- https://icoconvert.com/
- https://convertico.com/
- https://redketchup.io/icon-converter

### 方法二：使用 ImageMagick
```bash
# 安装 ImageMagick (Windows)
# 下载地址: https://imagemagick.org/script/download.php

# 生成多分辨率 ICO
magick icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico
```

### 方法三：使用 Sharp (Node.js)
```javascript
const sharp = require('sharp');
const toIco = require('to-ico');

// 生成不同尺寸的 PNG
const sizes = [16, 32, 48, 64, 128, 256];
const pngs = await Promise.all(
  sizes.map(size =>
    sharp('icon.png').resize(size, size).png().toBuffer()
  )
);

// 合并为 ICO
const ico = await toIco(pngs);
fs.writeFileSync('icon.ico', ico);
```

## 创建安装程序图片

### Header 图片 (150x57)
```bash
# 使用 ImageMagick
magick -size 150x57 xc:#1a1a2e \
  -fill "#6366f1" -draw "rectangle 0,50 150,57" \
  -fill white -pointsize 18 -gravity center \
  -annotate +0-5 "MtBot" \
  installer-header.bmp
```

### Sidebar 图片 (164x314)
```bash
# 使用 ImageMagick
magick -size 164x314 gradient:#1a1a2e-#16213e \
  \( icon.png -resize 100x100 \) -gravity north -geometry +0+40 -composite \
  -fill white -pointsize 14 -gravity south \
  -annotate +0+20 "MtBot\nAssistant" \
  installer-sidebar.bmp
```

## 临时开发图标

如果暂时没有正式图标，可以使用以下命令生成临时占位图标：

```bash
# 生成简单的占位符图标 (需要 ImageMagick)
magick -size 256x256 xc:#6366f1 \
  -fill white -pointsize 120 -gravity center \
  -annotate +0+0 "OC" \
  icon.png

magick icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico
```

## 品牌规范

### 主色调
- 主色：#2563EB (Blue)
- 次色：#38BDF8 (Sky)
- 强调：#7DD3FC (Sky lift)
- Logo：`assets/logo.png`（侧栏 / 关于 / 标题栏 UI）
- 系统图标由 Logo 生成：`pnpm generate:icon` → `icon.ico` / `icon.png` / `tray-icon.png`

### 背景色
- 深色背景：#0F172A
- 次深背景：#1E293B

### 文字色
- 主文字：#FFFFFF
- 次文字：#A0AEC0
- 禁用：#4A5568


## 文件清单

构建安装包前，请确保以下文件存在：

| 文件名 | 必需 | 说明 |
|--------|------|------|
| icon.ico | ✅ | 应用图标 |
| icon.png | 可选 | PNG 格式图标 |
| installer-header.bmp | 可选 | 安装程序标题图 |
| installer-sidebar.bmp | 可选 | 安装程序侧边栏图 |
| uninstaller-sidebar.bmp | 可选 | 卸载程序侧边栏图 |

如果可选文件不存在，electron-builder 会使用默认样式。
