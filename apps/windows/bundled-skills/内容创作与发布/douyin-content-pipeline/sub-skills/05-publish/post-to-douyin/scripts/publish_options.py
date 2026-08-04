"""抖音发布选项：从 JSON 加载合集、声明、定时、封面、音乐等配置。"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class MusicOptions:
    """平台曲库音乐（图文/视频发布页选择）。"""

    keyword: str = ""
    pick_index: int = 0


@dataclass
class BgmOptions:
    """视频合成时混入的背景音乐（ffmpeg）。"""

    file: str = ""
    volume: float = 0.18


@dataclass
class PublishOptions:
    """统一发布选项，CDP 与 sau CLI 共用。"""

    title: str = ""
    content: str = ""
    collection: str = ""
    declaration: str = ""
    schedule: str = ""
    cover: str = ""
    music: MusicOptions | None = None
    bgm: BgmOptions | None = None
    tags: list[str] = field(default_factory=list)
    account: str = "default"
    mode: str = "cdp-image"

    @classmethod
    def from_dict(cls, data: dict[str, Any], base_dir: Path | None = None) -> PublishOptions:
        """从字典解析发布选项，相对路径相对于 base_dir。"""
        music_raw = data.get("music")
        music = None
        if isinstance(music_raw, dict) and music_raw.get("keyword"):
            music = MusicOptions(
                keyword=str(music_raw.get("keyword", "")),
                pick_index=int(music_raw.get("pick_index", 0)),
            )
        bgm_raw = data.get("bgm")
        bgm = None
        if isinstance(bgm_raw, dict) and bgm_raw.get("file"):
            bgm_path = str(bgm_raw["file"])
            if base_dir and not Path(bgm_path).is_absolute():
                bgm_path = str((base_dir / bgm_path).resolve())
            bgm = BgmOptions(file=bgm_path, volume=float(bgm_raw.get("volume", 0.18)))

        cover = str(data.get("cover", "") or "")
        if cover and base_dir and not Path(cover).is_absolute():
            cover = str((base_dir / cover).resolve())

        tags = data.get("tags") or []
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.replace("#", " ").split() if t.strip()]

        return cls(
            title=str(data.get("title", "") or ""),
            content=str(data.get("content", "") or data.get("desc", "") or data.get("note", "")),
            collection=str(data.get("collection", "") or ""),
            declaration=str(data.get("declaration", "") or ""),
            schedule=str(data.get("schedule", "") or ""),
            cover=cover,
            music=music,
            bgm=bgm,
            tags=list(tags),
            account=str(data.get("account", "default") or "default"),
            mode=str(data.get("mode", "cdp-image") or "cdp-image"),
        )

    @classmethod
    def load(cls, path: Path, title_file: Path | None = None, content_file: Path | None = None) -> PublishOptions:
        """从 publish-options.json 加载，可选 title/desc 文件覆盖。"""
        base_dir = path.parent.resolve()
        data: dict[str, Any] = {}
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
        opts = cls.from_dict(data, base_dir)
        if title_file and title_file.exists():
            opts.title = title_file.read_text(encoding="utf-8").strip()
        if content_file and content_file.exists():
            opts.content = content_file.read_text(encoding="utf-8").strip()
        return opts

    def to_field_status(self) -> dict[str, Any]:
        """输出各字段配置摘要，供日志打印。"""
        return {
            "title": bool(self.title),
            "content": bool(self.content),
            "collection": self.collection or None,
            "declaration": self.declaration or None,
            "schedule": self.schedule or None,
            "cover": self.cover or None,
            "music": self.music.keyword if self.music else None,
            "bgm": self.bgm.file if self.bgm else None,
            "tags": self.tags or None,
            "mode": self.mode,
        }
