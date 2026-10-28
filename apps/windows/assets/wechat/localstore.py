# -*- coding: utf-8 -*-
"""本地 JSON/JSONL 存储的小工具：原子写 + 跨进程文件锁。

知识库、自动回复规则/草稿/审计都可能同时被 MCP 服务进程和控制台进程写，
所以不能只靠进程内 `threading.Lock`。Windows 用 `msvcrt.locking`，其它平台用 `fcntl`。
数据量都很小，读改写整份文件足够。
"""
import json
import os
import threading

try:
    import msvcrt
except ImportError:                 # pragma: no cover - 非 Windows
    msvcrt = None
try:
    import fcntl
except ImportError:                 # pragma: no cover - Windows
    fcntl = None

_THREAD_LOCK = threading.RLock()


class FileLock:
    """按路径加独占锁；同一进程内再加一层线程锁（Windows 文件锁不阻塞同进程线程）。"""

    def __init__(self, path):
        self.path = path + ".lock"
        self._fh = None

    def __enter__(self):
        _THREAD_LOCK.acquire()
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            self._fh = open(self.path, "a+b")
            if self._fh.tell() == 0:
                self._fh.write(b"\0")
                self._fh.flush()
            self._fh.seek(0)
            if msvcrt:
                msvcrt.locking(self._fh.fileno(), msvcrt.LK_LOCK, 1)
            elif fcntl:
                fcntl.flock(self._fh.fileno(), fcntl.LOCK_EX)
            return self
        except Exception:
            _THREAD_LOCK.release()
            raise

    def __exit__(self, exc_type, exc, tb):
        try:
            if self._fh is not None:
                try:
                    if msvcrt:
                        self._fh.seek(0)
                        msvcrt.locking(self._fh.fileno(), msvcrt.LK_UNLCK, 1)
                    elif fcntl:
                        fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
                finally:
                    self._fh.close()
        finally:
            self._fh = None
            _THREAD_LOCK.release()
        return False


def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


def write_json(path, data):
    """先写临时文件再 `os.replace`，避免读到半截 JSON。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def append_jsonl(path, row):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def read_jsonl(path, limit=0):
    """读 JSONL；坏行跳过。`limit>0` 时只取**最后** limit 行。"""
    if not os.path.isfile(path):
        return []
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                continue
    return rows[-limit:] if limit else rows
