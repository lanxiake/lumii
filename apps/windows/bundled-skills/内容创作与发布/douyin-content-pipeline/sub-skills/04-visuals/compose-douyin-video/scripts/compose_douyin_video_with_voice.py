#!/usr/bin/env python3
"""将分镜图片 + Edge-TTS 配音合成为带旁白的抖音竖版 MP4。"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from compose_douyin_video import quote_concat_path, validate_images
from ffmpeg_utils import resolve_ffmpeg
from generate_voiceover import generate_voiceover

VF = (
    "scale=1080:1920:force_original_aspect_ratio=decrease,"
    "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=#F0EDE6,"
    "setsar=1,format=yuv420p"
)
PAD_SECONDS = 0.35


def _render_segment(ffmpeg: str, image: Path, audio: Path, duration: float, output: Path) -> None:
    """为单张图片 + 单段配音渲染短视频片段。"""
    cmd = [
        ffmpeg, "-y",
        "-loop", "1", "-i", str(image.resolve()),
        "-i", str(audio.resolve()),
        "-vf", VF,
        "-t", f"{duration:.3f}",
        "-r", "30",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
        "-shortest",
        "-movflags", "+faststart",
        str(output.resolve()),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        print(proc.stderr, file=sys.stderr)
        raise SystemExit(f"[ERROR] segment render failed: {output.name}")


def _mix_bgm(ffmpeg: str, video: Path, bgm: Path, volume: float, output: Path) -> None:
    """将背景音乐以较低音量混入已合成视频。"""
    vol = max(0.01, min(volume, 1.0))
    cmd = [
        ffmpeg, "-y",
        "-i", str(video.resolve()),
        "-i", str(bgm.resolve()),
        "-filter_complex",
        f"[1:a]volume={vol}[bgm];[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=2[aout]",
        "-map", "0:v", "-map", "[aout]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        str(output.resolve()),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        print(proc.stderr, file=sys.stderr)
        raise SystemExit("[ERROR] bgm mix failed")


def _concat_segments(ffmpeg: str, segments: list[Path], output: Path) -> None:
    """将多个片段无损拼接为最终 MP4。"""
    with tempfile.TemporaryDirectory(prefix="dy-voice-concat-") as tmp:
        list_path = Path(tmp) / "segments.txt"
        lines = [f"file '{quote_concat_path(p)}'" for p in segments]
        list_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        cmd = [
            ffmpeg, "-y",
            "-f", "concat", "-safe", "0",
            "-i", str(list_path),
            "-c", "copy",
            str(output.resolve()),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if proc.returncode != 0:
            print(proc.stderr, file=sys.stderr)
            raise SystemExit("[ERROR] concat failed")


def compose_with_voice(
    narration_path: Path,
    output: Path,
    voice_dir: Path | None = None,
    skip_tts: bool = False,
    bgm: Path | None = None,
    bgm_volume: float = 0.18,
) -> Path:
    """生成配音并合成带旁白的竖版视频，可选混入背景音乐。"""
    ffmpeg = resolve_ffmpeg()
    base_dir = narration_path.parent.resolve()
    voice_dir = (voice_dir or base_dir / "voice").resolve()
    manifest_path = voice_dir / "voice_manifest.json"

    if skip_tts and manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        items = manifest["segments"]
    else:
        result = generate_voiceover(narration_path, voice_dir)
        items = result["segments"]

    segment_videos: list[Path] = []
    with tempfile.TemporaryDirectory(prefix="dy-voice-seg-") as tmp:
        tmp_path = Path(tmp)
        for i, item in enumerate(items, start=1):
            image_rel = item.get("image") or ""
            image = (base_dir / image_rel).resolve() if image_rel else None
            if image is None or not image.exists():
                raise SystemExit(f"[ERROR] image not found for segment: {item.get('segment_id')}")
            validate_images([str(image)])
            audio = Path(item["audio"]).resolve()
            if not audio.exists():
                raise SystemExit(f"[ERROR] audio not found: {audio}")
            duration = float(item.get("duration", 3)) + PAD_SECONDS
            seg_out = tmp_path / f"seg_{i:02d}.mp4"
            print(f"[compose] segment {i}: {image.name} + {audio.name} ({duration:.2f}s)", file=sys.stderr)
            _render_segment(ffmpeg, image, audio, duration, seg_out)
            segment_videos.append(seg_out)

        output.parent.mkdir(parents=True, exist_ok=True)
        raw_out = output
        if bgm and bgm.exists():
            tmp_video = tmp_path / "raw_concat.mp4"
            _concat_segments(ffmpeg, segment_videos, tmp_video)
            print(f"[compose] mixing bgm: {bgm.name} (volume={bgm_volume})", file=sys.stderr)
            _mix_bgm(ffmpeg, tmp_video, bgm, bgm_volume, raw_out)
        else:
            _concat_segments(ffmpeg, segment_videos, raw_out)

    print(f"[OK] video written to: {output.resolve()}", file=sys.stderr)
    return output.resolve()


def main() -> None:
    parser = argparse.ArgumentParser(description="图片+配音合成抖音竖版视频")
    parser.add_argument("--narration", required=True, help="narration.json 路径")
    parser.add_argument("--output", required=True, help="输出 MP4 路径")
    parser.add_argument("--voice-dir", help="配音缓存目录（默认 narration 同目录/voice）")
    parser.add_argument("--skip-tts", action="store_true", help="跳过 TTS，复用已有 voice_manifest.json")
    parser.add_argument("--bgm", help="背景音乐 MP3（合成时低音量混入）")
    parser.add_argument("--bgm-volume", type=float, default=0.18, help="BGM 音量 0~1")
    args = parser.parse_args()
    compose_with_voice(
        Path(args.narration),
        Path(args.output),
        Path(args.voice_dir) if args.voice_dir else None,
        skip_tts=args.skip_tts,
        bgm=Path(args.bgm) if args.bgm else None,
        bgm_volume=args.bgm_volume,
    )


if __name__ == "__main__":
    main()
