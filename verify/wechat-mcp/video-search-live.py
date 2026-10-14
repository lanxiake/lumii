# -*- coding: utf-8 -*-
"""真机：新加的两条**端到端**验一遍（只读，不发送、不碰微信数据）。

1. `attach_video`：48 条视频消息里真能认领回几份 mp4（预期 8，且**大小精确相等**）；
2. `search_messages` 的命中能不能直接交给 `read_image`：搜索一条图片消息 → 拿 `local_id`
   → `image_message(talker, local_id)` 解出图。

跑法：PYTHONIOENCODING=utf-8 ~/.lumii/runtimes/python-embed/python.exe video-search-live.py
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.abspath(os.path.join(HERE, "..", "..", "apps", "windows", "resources"))
for _p in (os.path.join(RES, "wechat-mcp"), os.path.join(RES, "wechat-export-mcp")):
    sys.path.insert(0, _p)

import exportcore as X          # noqa: E402
import wechat_core as core      # noqa: E402


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                                            # noqa: BLE001
        pass

    print("① attach_video：真能认领回几份")
    hl = core._video_hardlink()
    print("   video_hardlink_info_v4 → mp4 索引 %d 条" % len(hl))
    vids, got, sizes_ok = 0, 0, 0
    for s in core.sessions():
        tk = s.get("talker")
        if not tk:
            continue
        try:
            rows = X.iter_rows(tk, 0, 0)
        except Exception:                                        # noqa: BLE001
            continue
        batch = [core.msg_dict(ct, lt, c, {}, talker=tk, sender=None, me=None, local_id=lid)
                 for ct, lt, c, _sd, lid in rows if (lt & 0xFFFFFFFF) == 43]
        vids += len(batch)
        core.attach_video(batch)
        for m in batch:
            if m.get("video_path"):
                got += 1
                sizes_ok += os.path.getsize(m["video_path"]) == m.get("video_len")
    print("   视频消息 %d 条 → 认领到 %d 份（%s）；其中大小精确相等 %d"
          % (vids, got, "%d%%" % (100 * got / vids) if vids else "-", sizes_ok))
    assert got == sizes_ok, "有认领回来的文件大小对不上 —— 判据没生效"

    print("\n② search_messages → read_image 这条路")
    hits = core.search_messages("图片", limit=20)["messages"]
    with_id = [h for h in hits if h.get("local_id") is not None]
    print("   搜「图片」命中 %d 条，带 local_id 的 %d 条" % (len(hits), len(with_id)))
    assert hits and len(with_id) == len(hits), "命中仍有丢 local_id 的"
    # 挑一条**真是图片**的命中（带 image_md5）走完整条路：搜索 → local_id → 解密出路径
    pic = [h for h in with_id if h.get("image_md5")]
    print("   其中图片消息 %d 条" % len(pic))
    for h in pic[:3]:
        m, why = core.image_message(h["talker"], h["local_id"])
        print("   命中 %s lid=%s → read_image：%s"
              % (h.get("name"), h["local_id"], (m or {}).get("image_path") or why))
    print("\n判据：① 认领数与大小校验数相等；② 命中的 local_id 能一路走到 read_image（no_key 也算走通）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
