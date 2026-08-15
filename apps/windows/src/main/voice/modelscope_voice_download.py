#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
使用 ModelScope 官方 SDK 下载语音模型文件。

用法:
  python modelscope_voice_download.py --spec '<json>'

spec 示例:
{
  "modelId": "pengzhendong/silero-vad",
  "cacheDir": "C:/tmp/ms-cache",
  "outDir": "C:/models/vad",
  "files": [{"remote": "v4/silero_vad.onnx", "local": "silero_vad.onnx"}],
  "extractTokensFromConfig": false
}

进度以 JSON 行输出到 stdout：{"event":"progress","file":"...","percent":0.5}
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from typing import Any


def emit(obj: dict[str, Any]) -> None:
    """向 stdout 输出一行 JSON 事件"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def extract_tokens_from_config(config_path: str, tokens_out: str) -> None:
    """从 FunASR/魔搭 config.yaml 的 token_list 生成 sherpa tokens.txt"""
    try:
        import yaml  # type: ignore
    except ImportError:
        # modelscope 通常已带 pyyaml；若无则简易解析
        yaml = None

    token_list = None
    if yaml is not None:
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f)

        def find(obj: Any) -> Any:
            if isinstance(obj, dict):
                if "token_list" in obj and isinstance(obj["token_list"], list):
                    return obj["token_list"]
                for v in obj.values():
                    got = find(v)
                    if got is not None:
                        return got
            return None

        token_list = find(cfg)

    if not token_list:
        raise RuntimeError(f"无法从 {config_path} 提取 token_list")

    with open(tokens_out, "w", encoding="utf-8") as f:
        for t in token_list:
            f.write(f"{t}\n")
    emit({"event": "info", "message": f"已生成 tokens.txt（{len(token_list)} 词）"})


def main() -> int:
    parser = argparse.ArgumentParser(description="ModelScope SDK 语音模型下载")
    parser.add_argument("--spec", required=True, help="JSON 规格字符串")
    args = parser.parse_args()

    try:
        spec = json.loads(args.spec)
    except json.JSONDecodeError as e:
        emit({"event": "error", "message": f"spec JSON 无效: {e}"})
        return 2

    model_id = spec["modelId"]
    cache_dir = spec["cacheDir"]
    out_dir = spec["outDir"]
    files = spec.get("files") or []
    extract_tokens = bool(spec.get("extractTokensFromConfig"))
    mode = spec.get("mode") or ("snapshot" if not files else "files")

    os.makedirs(cache_dir, exist_ok=True)
    os.makedirs(out_dir, exist_ok=True)

    try:
        from modelscope.hub.file_download import model_file_download
    except ImportError:
        emit({"event": "error", "message": "未安装 modelscope，请先 pip install modelscope"})
        return 3

    # 整库快照：用于 Qwen3-TTS 等多文件大模型
    if mode == "snapshot":
        emit({"event": "start", "modelId": model_id, "mode": "snapshot", "percent": 0.02})
        emit({
            "event": "progress",
            "percent": 0.05,
            "message": f"魔搭 snapshot 下载 {model_id}（体积较大，请耐心等待）",
        })
        try:
            from modelscope.hub.snapshot_download import snapshot_download
        except ImportError:
            emit({"event": "error", "message": "modelscope 缺少 snapshot_download"})
            return 3
        try:
            # local_dir 直接落到目标目录，避免二次拷贝
            snapshot_download(
                model_id=model_id,
                cache_dir=cache_dir,
                local_dir=out_dir,
            )
        except Exception as e:
            emit({"event": "error", "message": f"snapshot 下载失败: {e}"})
            return 4
        emit({"event": "done", "outDir": out_dir, "percent": 1.0, "mode": "snapshot"})
        return 0

    total = max(len(files), 1)
    emit({"event": "start", "modelId": model_id, "totalFiles": total})

    config_local_path = None
    for i, item in enumerate(files):
        remote = item["remote"]
        local_name = item.get("local") or os.path.basename(remote)
        emit({
            "event": "progress",
            "file": remote,
            "index": i,
            "totalFiles": total,
            "percent": i / total,
            "message": f"正在从魔搭下载 {remote}",
        })
        try:
            downloaded = model_file_download(
                model_id=model_id,
                file_path=remote,
                cache_dir=cache_dir,
            )
        except Exception as e:
            emit({"event": "error", "message": f"下载失败 {remote}: {e}"})
            return 4

        dest = os.path.join(out_dir, local_name)
        os.makedirs(os.path.dirname(dest) or out_dir, exist_ok=True)
        shutil.copy2(downloaded, dest)
        if local_name == "config.yaml" or remote.endswith("config.yaml"):
            config_local_path = dest
        emit({
            "event": "file_done",
            "file": remote,
            "local": dest,
            "size": os.path.getsize(dest),
            "percent": (i + 1) / total,
        })

    if extract_tokens:
        tokens_out = os.path.join(out_dir, "tokens.txt")
        if not config_local_path or not os.path.exists(config_local_path):
            # 再下一次 config.yaml
            emit({"event": "progress", "message": "提取 tokens：下载 config.yaml", "percent": 0.95})
            cfg_path = model_file_download(
                model_id=model_id,
                file_path="config.yaml",
                cache_dir=cache_dir,
            )
            config_local_path = cfg_path
        extract_tokens_from_config(config_local_path, tokens_out)

    emit({"event": "done", "outDir": out_dir, "percent": 1.0})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
