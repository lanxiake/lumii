"""发送端到端对账探针：真发 + **读库逐字比对** + 计时。只发默认靶（文件传输助手）。

为什么需要它：`send_text` 返回 `ok=True` **不等于字都对**。2026-10-14 就是靠这条判据抓到
「每句首字被静默吃掉」——`post_text` 的 PostMessage 恒真、`_wait_new_message` 认的是
`agent_sent` 指纹（指纹在、正文少一个字照样算成功），整条链没有任何一道会报错。
所以「发出去的到底是什么」只能**读库回读**。

用法（默认只打文件传输助手，发给别人得显式加 --talker + --allow-real-talker）：
  set PYTHONIOENCODING=utf-8
  python probe_send_roundtrip.py [-n 3] [-l 154] [--drive] [--tag 前缀]

  --drive  额外用 `run` 驱动真实 Agent 回合（默认不开）——那是另一套 harness 的事，别混进来。

判据：
  ① 逐字一致（`m["text"] == 预期正文`，两边都剥掉 AGENT_MARK、都按 400 字截断）
  ② 不一致时打印**首个不同字符的位置**——首字丢失 vs 中间丢字是两种不同的故障
  ③ 每句实际耗时，和 MCP 文档写的「7–15 秒」对账
"""
import argparse
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent / "apps" / "windows" / "resources" / "wechat-mcp"))

import wechat_core as core      # noqa: E402
import wechat_sender as S       # noqa: E402

SAFE_TALKER = "filehelper"


def probe(talker, name, n, length, tag):
    bad = 0
    for i in range(n):
        body = f"{tag}{i}：" + "中文与English混排0123456789，标点！（测试）" * ((length // 22) + 1)
        body = body[:length]
        plain = core.split_agent_mark(body)[0]
        t0 = time.time()
        ok, detail = S.send_text(body, talker, name, dry_run=False)
        el = time.time() - t0
        time.sleep(1.0)                       # 让落库稳一稳再读
        got = ((core.history(talker, 2).get("messages") or [])[-1].get("text") or "")
        same = got == plain[:400]
        bad += 0 if same else 1
        print(f"#{i} {len(plain):>4}字  发{el:5.2f}s  ok={ok}  一致={same}")
        if not same:
            for j in range(min(len(got), len(plain))):
                if got[j] != plain[j]:
                    print(f"     首个不同 @{j}：期望 {plain[j]!r} 实得 {got[j]!r}"
                          f"   实得开头 {got[:12]!r}")
                    break
            else:
                print(f"     前 {min(len(got), len(plain))} 字全同，长度差 {len(got) - len(plain)}")
            print(f"     detail={detail[:60]}")
    print(f"\n合计 {n} 句，逐字不一致 {bad} 句")
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-n", type=int, default=3)
    ap.add_argument("-l", "--length", type=int, default=154)
    ap.add_argument("--tag", default="对账")
    ap.add_argument("--talker", default=SAFE_TALKER)
    ap.add_argument("--allow-real-talker", action="store_true",
                    help="确认要发给文件传输助手以外的人（不可撤回）")
    a = ap.parse_args()

    if a.talker != SAFE_TALKER and not a.allow_real_talker:
        print(f"拒绝：默认只打 {SAFE_TALKER}（发给自己）。真要发给 {a.talker} 就加 --allow-real-talker")
        return 2
    name = core.names().get(a.talker) or a.talker
    print(f"目标 {name}（{a.talker}）  每句 {a.length} 字 × {a.n}\n")
    return 1 if probe(a.talker, name, a.n, a.length, a.tag) else 0


if __name__ == "__main__":
    sys.exit(main())
