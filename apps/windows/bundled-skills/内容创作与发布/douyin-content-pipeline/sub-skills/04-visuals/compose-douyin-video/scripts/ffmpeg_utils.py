"""ffmpeg 路径解析：优先 PATH，回退 imageio-ffmpeg 内置二进制。"""
from __future__ import annotations

import shutil


def resolve_ffmpeg() -> str:
    """返回可用的 ffmpeg 可执行文件路径。"""
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as exc:
        raise SystemExit(
            "[ERROR] ffmpeg not found. Install ffmpeg or: python -m pip install imageio-ffmpeg"
        ) from exc
