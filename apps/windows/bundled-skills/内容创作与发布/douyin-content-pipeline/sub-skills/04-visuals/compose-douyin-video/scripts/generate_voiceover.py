#!/usr/bin/env python3
"""根据 narration.json 用 Edge-TTS 为每个分镜生成配音 MP3。"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

import edge_tts


def _audio_duration_seconds(path: Path) -> float:
    """用 ffprobe/ffmpeg 或 mutagen 估算音频时长（秒）。"""
    try:
        from mutagen.mp3 import MP3
        return float(MP3(path).info.length)
    except Exception:
        pass
    try:
        import imageio_ffmpeg
        ffprobe = imageio_ffmpeg.get_ffmpeg_exe().replace("ffmpeg", "ffprobe")
        if not Path(ffprobe).exists():
            raise FileNotFoundError(ffprobe)
    except Exception:
        return 3.0
    import subprocess
    proc = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, check=False,
    )
    if proc.returncode == 0 and proc.stdout.strip():
        return float(proc.stdout.strip())
    return 3.0


async def _synthesize(text: str, voice: str, rate: str, pitch: str, output: Path) -> None:
    """异步调用 Edge-TTS 写入单个 MP3 文件。"""
    communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
    await communicate.save(str(output))


def generate_voiceover(narration_path: Path, output_dir: Path) -> dict:
    """读取 narration.json，批量生成配音并回写时长元数据。"""
    data = json.loads(narration_path.read_text(encoding="utf-8"))
    voice = data.get("voice", "zh-CN-XiaoxiaoNeural")
    rate = data.get("rate", "+0%")
    pitch = data.get("pitch", "+0Hz")
    segments = data.get("segments", [])
    if not segments:
        raise SystemExit("[ERROR] narration.json 缺少 segments")

    output_dir.mkdir(parents=True, exist_ok=True)
    manifest: list[dict] = []

    for seg in segments:
        seg_id = seg.get("segment_id", f"S{len(manifest)+1:02d}")
        text = (seg.get("text") or "").strip()
        if not text:
            raise SystemExit(f"[ERROR] 段落 {seg_id} 缺少 text")
        mp3_path = output_dir / f"{seg_id}.mp3"
        print(f"[voiceover] {seg_id}: {text[:40]}...", file=sys.stderr)
        asyncio.run(_synthesize(text, voice, rate, pitch, mp3_path))
        duration = _audio_duration_seconds(mp3_path)
        manifest.append({
            "segment_id": seg_id,
            "text": text,
            "audio": str(mp3_path.resolve()),
            "duration": round(duration, 3),
            "image": seg.get("image", ""),
        })
        print(f"[OK] {mp3_path.name} ({duration:.2f}s)", file=sys.stderr)

    manifest_path = output_dir / "voice_manifest.json"
    manifest_path.write_text(
        json.dumps({"voice": voice, "segments": manifest}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return {"manifest": str(manifest_path.resolve()), "segments": manifest}


def main() -> None:
    parser = argparse.ArgumentParser(description="Edge-TTS 分镜配音生成")
    parser.add_argument("--narration", required=True, help="narration.json 路径")
    parser.add_argument("--output-dir", required=True, help="配音输出目录")
    args = parser.parse_args()
    result = generate_voiceover(Path(args.narration), Path(args.output_dir))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
