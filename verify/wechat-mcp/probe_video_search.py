"""用户要的「搜索」现在到底能不能用：搜「视频」能搜到几条、带不带可播放路径。只读。"""
import sys
sys.path.insert(0, r"C:\myself\projects\my\open-source\lumii\apps\windows\resources\wechat-mcp")
import wechat_core as core

r = core.search_messages("视频", limit=200)
print(f"搜「视频」：count={r['count']} truncated={r['truncated']} scanned={r['scanned_per_talker']}")
ms = r["messages"]
from collections import Counter
print("类型分布：", Counter(m.get("type") for m in ms).most_common(6))
v = [m for m in ms if m.get("type") == 43]
print(f"其中真视频 {len(v)} 条；带 video_path 的 {sum(1 for m in v if m.get('video_path'))} 条")
if v:
    k = v[0]
    print("字段：", sorted(k.keys()))
    for m in v[:4]:
        print(f"  {m.get('name')} | {m.get('sender') or '我'} | {m.get('text')} | "
              f"md5={(m.get('video_md5') or '')[:8]} len={m.get('video_len')} "
              f"path={'有' if m.get('video_path') else '无'}")
