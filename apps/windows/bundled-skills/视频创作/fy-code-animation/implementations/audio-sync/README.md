# 音频同步纯函数

本目录独立编写，ES module无外部依赖；未执行。它不读取音频、不自动测拍、不生成音乐。方法见 [music-and-sound](../../recipes/music-and-sound.md)。

| 函数 | 契约 |
|---|---|
| secondsToFrame / frameToSeconds | seconds、fps；每个绝对边界round一次 |
| secondsToSample / sampleToSeconds | seconds、sampleRate；样本索引从0计 |
| beatGrid({bpm,offset,start,end,fps?}) | [start,end)内的绝对拍序号与at秒，始终标planned；可附frame |
| tempoCandidates(bpm) | 返回半速/原速/倍速，不判哪一个正确 |
| snapEvents(events,beats,{tolerance,sourceHash}) | beats必须按at递增、measured、同hash且有evidence；只吸附allow_snap=true并在容差/min_at/max_at内的事件 |
| sfxStart(contactAt,peakOffset) | 返回at、preRoll、needsPreRoll；负at不会被悄悄钳位 |

```js
import {beatGrid,sfxStart} from './beat-grid.mjs';
const planned=beatGrid({bpm:92,offset:.2,start:0,end:8,fps:30});
const cue=sfxStart(2,.08); // 1.92s开始，感知峰值对齐2s接触
```

snapEvents保留planned_at/delta/beat_id/evidence；不检查跨事件因果、两事件同拍碰撞或最终读窗，调用方需复核设计。变速音乐用实测列表，不用全局BPM网格冒充测量；换音轨/裁切/速度后使旧测量失效。响度、混音、AAC偏移和尾音没有在这些纯函数里测量。
