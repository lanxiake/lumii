# 示范宠物素材署名（Shimeji）

`apps/windows/resources/pet-models/demo_shimeji_*` 这几个模型**不是 AI 生成的**，
是从 [AI-desktop-pets](https://github.com/)（本机 `C:\myself\projects\my\open-source\AI-desktop-pets`）
的 `app/src/main/res/drawable-nodpi/` 导入的 Shimeji 精灵表，由
`verify/pet-sprite/characters/import-shimeji.mjs` 裁切打包而成。

## ⚠ 只可用于开发与验证，**不可作为可发布资产**

- Shimeji 精灵表本身多为**二次元同人作品**（原神、JoJo、宝可梦等角色的同人绘），
  上游仓库的 MIT 许可覆盖的是**代码**，不覆盖这些图。
- 即便如此，下游仓库给了逐张的作者署名。署名是**使用条件**，不是可选项。
- 因此：这几个模型可以进仓库用于开发与验证，**发布前必须替换**或有明确授权。
  这与 `apps/windows/resources/pet-models/LICENSE` 里对 Live2D 模型的既有约束是同一类问题。

## 来源与作者

| 模型 | 源文件 | 作者 | 出处 |
| --- | --- | --- | --- |
| `demo_shimeji_caneko` | `shimeji_caneko.png` | uncut-adventure | <https://www.deviantart.com/uncut-adventure/art/Nekotalia-Canada-shimeji-252753686> |
| `demo_shimeji_germouser` | `shimeji_germouser.png` | uncut-adventure | <https://www.deviantart.com/uncut-adventure/art/Nekotalia-Germany-shimeji-257593722> |
| `demo_shimeji_nekojapan` | `shimeji_nekojapan.png` | uncut-adventure | <https://www.deviantart.com/uncut-adventure> |
| `demo_shimeji_skoreacat` | `shimeji_skoreacat.png` | uncut-adventure | <https://www.deviantart.com/uncut-adventure> |
| `demo_shimeji_turkat` | `shimeji_turkat.png` | uncut-adventure | <https://www.deviantart.com/uncut-adventure> |

上表与上游 `app/src/main/java/com/kidspet/app/core/domain/model/SpriteConfig.kt`
里的 `SpriteCredit` 一致。**导入新模型时请一并把署名补进来。**

## 重新生成

```bash
node verify/pet-sprite/characters/build-ipc.mjs          # 先构建工具链 bundle（gitignore，必须先跑）
node verify/pet-sprite/characters/import-shimeji.mjs shimeji_caneko.png --id demo_shimeji_caneko
node verify/pet-sprite/characters/make-patches.mjs apps/windows/resources/pet-models/demo_shimeji_caneko
```
