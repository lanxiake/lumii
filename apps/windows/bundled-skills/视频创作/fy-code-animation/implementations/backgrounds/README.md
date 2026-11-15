# 程序背景

React/Remotion、浏览器Canvas2D；独立实现，未运行。输入显式t秒、width/height像素和seed，每帧重建，不依赖requestAnimationFrame或历史粒子状态。方法见 [living-backgrounds](../../recipes/living-backgrounds.md)。

`BackgroundCanvas({t,width,height,draw,dpr=1})` 在同步layout effect清空并调用draw；无异步资源，无私有循环。dpr显式0…3，不读取设备DPR；图像/字体需上层资源等待。同步画布错误调用cancelRender。

| 导出 | 参数/说明 |
|---|---|
| FlowField | lines=100、steps=35、stepLength=6px、period=12s；固定空间积分，每帧重建 |
| ParticleAtmosphere | count=240、mode drift/orbit/gather、radius px、period s；gather需targets每粒一对px坐标及gatherAt/gatherDuration |
| DotGrid | spacing=42px、focus px、eventAt秒、amplitude=6px；事件波闭式衰减 |
| NoiseGradient | 两RGB颜色、cell=24px、octaves=3、period=20s；低分辨率value noise/fBm |
| LightSweep | progress0…1、opacity、angle度、color；CSS光带 |
| Vignette | strength0…1 |
| Grain | count、opacity、drawingsPerSecond；固定seed+绘制拍 |
| readingAttenuation / ReadingZoneMask | x/y与zones，返回0…1；别名是函数，不是React组件 |

zones矩形为屏幕px：`{x,y,width,height,padding?,feather?,floor?}`。只是亮度/alpha遮让，不保证粒子几何避开。世界背景需先转换阅读区，或者在屏幕背景单独使用。

```tsx
<FlowField t={t} width={1920} height={1080} seed="scene-a"
 zones={[{x:160,y:700,width:1400,height:200,floor:.04}]}/>
```

周期通过sin/cos相位闭合；颗粒默认按绘制拍更换，不是连续循环纹理。冻结可传固定t，阅读段可停。计算量、Canvas字体/资源时序和最终编码效果未验证；这些不是流体/体积光求解器，不包含GPU着色器后期。
