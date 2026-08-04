"""小红书发布选项：从 JSON 加载定时、内容类型、发布模式等配置。"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class PublishOptions:
    """统一发布选项，CDP pipeline 与 sau CLI 共用。"""

    title: str = ""
    content: str = ""
    schedule: str = ""
    content_type: str = "general"
    publish_mode: str = "image-text"
    account: str = "default"
    tags: list[str] | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any], base_dir: Path | None = None) -> PublishOptions:
        """从字典解析发布选项。"""
        tags = data.get("tags") or []
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.replace("#", " ").split() if t.strip()]

        return cls(
            title=str(data.get("title", "") or ""),
            content=str(
                data.get("content", "")
                or data.get("desc", "")
                or data.get("note", "")
                or ""
            ),
            schedule=str(data.get("schedule", "") or ""),
            content_type=str(data.get("content_type", "general") or "general"),
            publish_mode=str(data.get("publish_mode", "image-text") or "image-text"),
            account=str(data.get("account", "default") or "default"),
            tags=list(tags) if tags else None,
        )

    @classmethod
    def load(
        cls,
        path: Path,
        title_file: Path | None = None,
        content_file: Path | None = None,
    ) -> PublishOptions:
        """从 publish-options.json 加载，可选 title/desc 文件覆盖。"""
        data: dict[str, Any] = {}
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
        opts = cls.from_dict(data, path.parent.resolve())
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
            "schedule": self.schedule or None,
            "content_type": self.content_type,
            "publish_mode": self.publish_mode,
            "tags": self.tags,
            "account": self.account,
        }
