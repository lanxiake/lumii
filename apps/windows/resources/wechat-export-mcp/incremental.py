"""增量导出：按上次导出的时间点只导新增消息。

状态落在 `<out_dir>/.export_state.json`（一个导出目录一份），键是**解析后的 talker**
（wxid/群号）而不是用户输入的名字——同一个人写「张三」还是「wxid_...」都得对得上。
"""
import json
import os
import time

STATE_FILE = ".export_state.json"


def load_state(out_dir):
    path = os.path.join(out_dir, STATE_FILE)
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _save(out_dir, state):
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, STATE_FILE)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)            # 写一半崩了也别留下坏状态


def since_of(out_dir, talker):
    """上次导出时间（Unix 秒）；没导过返回 0。"""
    return int((load_state(out_dir).get(talker) or {}).get("last_export_ts") or 0)


def mark(out_dir, talker, messages, export_ts=None):
    """记下这次导出。返回更新后的状态条目（给返回体里带 `incremental` 用）。"""
    ts = int(export_ts or time.time())
    state = load_state(out_dir)
    prev = state.get(talker) or {}
    state[talker] = {
        "last_export_ts": ts,
        "last_export_time": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts)),
        "messages": int(messages or 0),
        "previous_ts": prev.get("last_export_ts", 0),
    }
    _save(out_dir, state)
    return state[talker]
