# 视频合成背景音乐

将免版权 MP3 放在此目录，在 `publish-options.json` 中配置：

```json
"bgm": {
  "file": "../../assets/bgm/your-track.mp3",
  "volume": 0.15
}
```

合成时由 `compose_douyin_video_with_voice.py --bgm` 以低音量混入旁白。
