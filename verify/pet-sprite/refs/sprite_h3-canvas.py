"""Transparent source validation and deterministic opaque-canvas staging."""

from __future__ import annotations

import json
from collections import OrderedDict
from collections.abc import Mapping
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from threading import Lock
from typing import Any

from PIL import Image, UnidentifiedImageError

from sprite_h3.errors import PreparationError

type RGBColor = tuple[int, int, int]
type BBox = tuple[int, int, int, int]


class SpriteValidationError(PreparationError, ValueError):
    """Raised when a canonical sprite cannot be used safely."""


def _bbox_dict(bbox: BBox) -> dict[str, int]:
    left, top, right, bottom = bbox
    return {
        "x": left,
        "y": top,
        "width": right - left,
        "height": bottom - top,
    }


@dataclass(frozen=True, slots=True)
class SourceImageInfo:
    """Properties established while validating a canonical source image."""

    path: Path
    width: int
    height: int
    content_bbox: BBox
    alpha_min: int
    alpha_max: int
    sha256: str

    @property
    def size(self) -> tuple[int, int]:
        return (self.width, self.height)

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": self.path.name,
            "sha256": self.sha256,
            "width": self.width,
            "height": self.height,
            "content_bbox": _bbox_dict(self.content_bbox),
            "alpha_range": [self.alpha_min, self.alpha_max],
        }


@dataclass(frozen=True, slots=True)
class PlacementMetadata:
    """The exact crop, resize, and translation used to stage a sprite on the fixed grid."""

    source_bbox: BBox
    resized_size: tuple[int, int]
    translation: tuple[int, int]
    scale_x: float
    scale_y: float
    content_bbox: BBox
    figure_height_ratio: float
    baseline_ratio: float
    reference_figure_height: int
    """Height of the source figure's bounding box in source pixels (the snap's reference)."""
    figure_height: int
    """Height of the staged figure in canvas pixels."""
    scale_source: str = "own-bbox"
    """``own-bbox`` when scaled from this reference; ``anchor`` when the anchor scale was reused."""

    def to_dict(self) -> dict[str, Any]:
        return {
            "mode": "fixed-ratio",
            "source_bbox": _bbox_dict(self.source_bbox),
            "resized_size": {
                "width": self.resized_size[0],
                "height": self.resized_size[1],
            },
            "translation": {"x": self.translation[0], "y": self.translation[1]},
            "scale_x": self.scale_x,
            "scale_y": self.scale_y,
            "scale_source": self.scale_source,
            "content_bbox": _bbox_dict(self.content_bbox),
            "figure_height_ratio": self.figure_height_ratio,
            "baseline_ratio": self.baseline_ratio,
            "reference_figure_height": self.reference_figure_height,
            "figure_height": self.figure_height,
        }


@dataclass(frozen=True, slots=True)
class PreparationMetadata:
    """Neutral, JSON-serializable provenance for an opaque staged image."""

    source: SourceImageInfo
    canvas_size: tuple[int, int]
    background: RGBColor
    baseline: int
    placement: PlacementMetadata

    @property
    def figure_height_ratio(self) -> float:
        return self.placement.figure_height_ratio

    @property
    def baseline_ratio(self) -> float:
        return self.placement.baseline_ratio

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": self.source.to_dict(),
            "canvas": {
                "width": self.canvas_size[0],
                "height": self.canvas_size[1],
                "background": "#" + "".join(f"{channel:02X}" for channel in self.background),
                "figure_height_ratio": self.placement.figure_height_ratio,
                "baseline_ratio": self.placement.baseline_ratio,
                "baseline": self.baseline,
            },
            "placement": self.placement.to_dict(),
        }


@dataclass(slots=True)
class PreparedSprite:
    """An opaque model input, the same placement on a clear canvas, and the transform."""

    image: Image.Image
    transparent: Image.Image
    metadata: PreparationMetadata


def parse_rgb_color(value: str | tuple[int, int, int] | list[int]) -> RGBColor:
    """Parse ``#RRGGBB`` or validate a three-channel RGB value."""

    channels: tuple[int, ...]
    if isinstance(value, str):
        if len(value) != 7 or not value.startswith("#"):
            raise ValueError("background color must use #RRGGBB notation")
        try:
            channels = tuple(int(value[index : index + 2], 16) for index in (1, 3, 5))
        except ValueError as exc:
            raise ValueError("background color must use #RRGGBB notation") from exc
    else:
        channels = tuple(value)
        if len(channels) != 3:
            raise ValueError("RGB colors must have exactly three channels")
    if any(isinstance(channel, bool) or not isinstance(channel, int) for channel in channels):
        raise ValueError("RGB color channels must be integers")
    if any(channel < 0 or channel > 255 for channel in channels):
        raise ValueError("RGB color channels must be between 0 and 255")
    return (channels[0], channels[1], channels[2])


def check_transparency(rgba: Image.Image) -> tuple[BBox, int, int]:
    """The canon rule on an RGBA image: real transparency and a nonempty figure.

    Returns ``(content_bbox, alpha_min, alpha_max)``.
    """

    alpha = rgba.getchannel("A")
    alpha_min, alpha_max = alpha.getextrema()
    if alpha_max == 0:
        raise SpriteValidationError("source sprite is completely transparent")
    if alpha_min == 255:
        raise SpriteValidationError(
            "source sprite is completely opaque; the canonical sprite must have transparency"
        )
    content_bbox = alpha.getbbox()
    if content_bbox is None:
        raise SpriteValidationError("source sprite has no nontransparent pixels")
    return content_bbox, alpha_min, alpha_max


# Decoded facts per source file, keyed by path plus size and mtime so an edited file is
# read again. Every read path (loading a project, listing projects, fitting a figure, the
# workspace check) validates the same handful of PNGs; decoding a 1024x1536 source costs
# ~15 ms and one Roster click used to do it eight times per file.
_INFO_CACHE: OrderedDict[tuple[str, int, int], SourceImageInfo] = OrderedDict()
_INFO_CACHE_LIMIT = 512
_INFO_LOCK = Lock()


def clear_source_info_cache() -> None:
    """Forget every cached validation (tests, or after files change under a kept mtime)."""

    with _INFO_LOCK:
        _INFO_CACHE.clear()


def validate_transparent_png(path: str | Path) -> SourceImageInfo:
    """Validate a readable, nonempty PNG containing real transparency.

    A merely RGBA-encoded but fully opaque rectangle is rejected. This catches
    the common error where a staged or illustrated background is supplied as
    the canonical reusable sprite.

    The result is cached per file (path, size, mtime); a failing file is never cached.
    """

    source_path = Path(path)
    try:
        stat = source_path.stat()
    except OSError:
        stat = None
    if stat is None or not source_path.is_file():
        raise SpriteValidationError(f"source sprite does not exist: {source_path}")
    key = (str(source_path), stat.st_size, stat.st_mtime_ns)
    with _INFO_LOCK:
        cached = _INFO_CACHE.get(key)
        if cached is not None:
            _INFO_CACHE.move_to_end(key)
            return cached
    info = _validate_transparent_png(source_path)
    with _INFO_LOCK:
        _INFO_CACHE[key] = info
        while len(_INFO_CACHE) > _INFO_CACHE_LIMIT:
            _INFO_CACHE.popitem(last=False)
    return info


def _validate_transparent_png(source_path: Path) -> SourceImageInfo:
    try:
        with Image.open(source_path) as opened:
            if opened.format != "PNG":
                raise SpriteValidationError("source sprite must be a PNG file")
            if opened.width <= 0 or opened.height <= 0:
                raise SpriteValidationError("source sprite dimensions must be nonzero")
            has_alpha = "A" in opened.getbands() or "transparency" in opened.info
            if not has_alpha:
                raise SpriteValidationError("source sprite PNG must contain an alpha channel")
            rgba = opened.convert("RGBA")
            rgba.load()
    except SpriteValidationError:
        raise
    except (OSError, UnidentifiedImageError) as exc:
        raise SpriteValidationError(f"source sprite is not a readable PNG: {source_path}") from exc

    content_bbox, alpha_min, alpha_max = check_transparency(rgba)

    return SourceImageInfo(
        path=source_path,
        width=rgba.width,
        height=rgba.height,
        content_bbox=content_bbox,
        alpha_min=alpha_min,
        alpha_max=alpha_max,
        sha256=sha256(source_path.read_bytes()).hexdigest(),
    )


def baseline_row(canvas_height: int, baseline_ratio: float) -> int:
    """The canvas row the figure's lowest occupied pixel lands on."""

    return min(canvas_height - 1, max(0, round(baseline_ratio * canvas_height) - 1))


def fit_figure_height_ratio(
    source_path: str | Path,
    *,
    canvas_size: tuple[int, int],
    baseline_ratio: float,
) -> float:
    """The largest ``figure_height_ratio`` (two decimals) at which the source's content box
    fits the canvas at ``baseline_ratio``: bounded by the width and by the rows above the
    baseline. Raises like ``stage_sprite`` for an unusable source or canvas."""

    info = validate_transparent_png(source_path)
    canvas_width, canvas_height = canvas_size
    if canvas_width <= 0 or canvas_height <= 0:
        raise ValueError("canvas dimensions must be positive")
    if not 0 < baseline_ratio <= 1:
        raise ValueError("baseline_ratio must be between 0 (exclusive) and 1")
    source_left, source_top, source_right, source_bottom = info.content_bbox
    content_width = source_right - source_left
    content_height = source_bottom - source_top
    widest = canvas_width * content_height / (content_width * canvas_height)
    tallest = (baseline_row(canvas_height, baseline_ratio) + 1) / canvas_height
    # Floor to two decimals: the rounding in ``stage_sprite`` can still overflow by a pixel
    # exactly at the bound, and a ratio nobody can type into the field is no use.
    largest = int(min(widest, tallest, 0.99) * 100) / 100
    return max(largest, 0.01)


def stage_sprite(
    source_path: str | Path,
    *,
    canvas_size: tuple[int, int],
    background: str | tuple[int, int, int] | list[int],
    figure_height_ratio: float = 0.75,
    baseline_ratio: float = 0.88,
    reference_scale: float | None = None,
    resample: Image.Resampling = Image.Resampling.LANCZOS,
) -> PreparedSprite:
    """Place a validated sprite on a flat opaque key-colour canvas using the fixed grid.

    Only the nontransparent source bounding box participates. It is scaled so its height is
    exactly ``figure_height_ratio * canvas height`` (or by ``reference_scale`` when another
    reference of the same character is the anchor), centred horizontally, and its lowest
    occupied row lands on the baseline at ``baseline_ratio * canvas height``. A figure that
    would not fit is a hard error naming the largest ratio that does.
    """

    info = validate_transparent_png(source_path)
    canvas_width, canvas_height = canvas_size
    if canvas_width <= 0 or canvas_height <= 0:
        raise ValueError("canvas dimensions must be positive")
    for label, value in (
        ("figure_height_ratio", figure_height_ratio),
        ("baseline_ratio", baseline_ratio),
    ):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{label} must be a number")
    if not 0 < figure_height_ratio < 1:
        raise ValueError("figure_height_ratio must be between 0 and 1 (exclusive)")
    if not 0 < baseline_ratio <= 1:
        raise ValueError("baseline_ratio must be between 0 (exclusive) and 1")
    if reference_scale is not None and (
        isinstance(reference_scale, bool)
        or not isinstance(reference_scale, (int, float))
        or reference_scale <= 0
    ):
        raise ValueError("reference_scale must be a positive number")

    key_color = parse_rgb_color(background)
    source_left, source_top, source_right, source_bottom = info.content_bbox
    content_width = source_right - source_left
    content_height = source_bottom - source_top
    if reference_scale is None:
        scale = figure_height_ratio * canvas_height / content_height
        scale_source = "own-bbox"
    else:
        scale = float(reference_scale)
        scale_source = "anchor"
    resized_size = (
        max(1, round(content_width * scale)),
        max(1, round(content_height * scale)),
    )
    effective_baseline = baseline_row(canvas_height, baseline_ratio)
    destination_x = (canvas_width - resized_size[0]) // 2
    destination_y = effective_baseline - resized_size[1] + 1
    if resized_size[0] > canvas_width or destination_y < 0:
        widest = canvas_width * content_height / (content_width * canvas_height)
        tallest = (effective_baseline + 1) / canvas_height
        largest = min(widest, tallest)
        raise ValueError(
            f"the figure does not fit the {canvas_width}x{canvas_height} canvas at "
            f"figure_height_ratio {figure_height_ratio:g} with baseline_ratio "
            f"{baseline_ratio:g}; the largest figure_height_ratio that fits is {largest:.2f}"
        )

    with Image.open(info.path) as opened:
        cropped = opened.convert("RGBA").crop(info.content_bbox)
        resized = cropped.resize(resized_size, resample=resample)

    transparent = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
    transparent.alpha_composite(resized, dest=(destination_x, destination_y))
    staged_rgba = Image.new("RGBA", canvas_size, (*key_color, 255))
    staged_rgba.alpha_composite(resized, dest=(destination_x, destination_y))
    staged = staged_rgba.convert("RGB")

    content_bbox = (
        destination_x,
        destination_y,
        destination_x + resized.width,
        destination_y + resized.height,
    )
    placement = PlacementMetadata(
        source_bbox=info.content_bbox,
        resized_size=resized_size,
        translation=(destination_x, destination_y),
        scale_x=resized.width / content_width,
        scale_y=resized.height / content_height,
        content_bbox=content_bbox,
        figure_height_ratio=figure_height_ratio,
        baseline_ratio=baseline_ratio,
        reference_figure_height=content_height,
        figure_height=resized.height,
        scale_source=scale_source,
    )
    metadata = PreparationMetadata(
        source=info,
        canvas_size=canvas_size,
        background=key_color,
        baseline=effective_baseline,
        placement=placement,
    )
    return PreparedSprite(image=staged, transparent=transparent, metadata=metadata)


def prepare_sprite(
    source_path: str | Path,
    staged_path: str | Path,
    metadata_path: str | Path,
    *,
    canvas_size: tuple[int, int],
    background: str | tuple[int, int, int] | list[int],
    figure_height_ratio: float = 0.75,
    baseline_ratio: float = 0.88,
    reference_scale: float | None = None,
    resample: Image.Resampling = Image.Resampling.LANCZOS,
    keyed_path: str | Path | None = None,
) -> PreparationMetadata:
    """Stage a sprite and write its opaque PNG and neutral JSON metadata.

    ``keyed_path`` additionally receives the same placement on a transparent canvas: the
    review's reference image, comparable with keyed frames without keying anything.
    """

    result = stage_sprite(
        source_path,
        canvas_size=canvas_size,
        background=background,
        figure_height_ratio=figure_height_ratio,
        baseline_ratio=baseline_ratio,
        reference_scale=reference_scale,
        resample=resample,
    )
    staged_output = Path(staged_path)
    metadata_output = Path(metadata_path)
    staged_output.parent.mkdir(parents=True, exist_ok=True)
    metadata_output.parent.mkdir(parents=True, exist_ok=True)
    result.image.save(staged_output, format="PNG", optimize=False)
    if keyed_path is not None:
        keyed_output = Path(keyed_path)
        keyed_output.parent.mkdir(parents=True, exist_ok=True)
        result.transparent.save(keyed_output, format="PNG", optimize=False)
    metadata_output.write_text(
        json.dumps(result.metadata.to_dict(), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return result.metadata


def transparent_staged_from_metadata(
    source_path: str | Path,
    placement: Mapping[str, Any],
    canvas_size: tuple[int, int],
    *,
    resample: Image.Resampling = Image.Resampling.LANCZOS,
) -> Image.Image:
    """Re-apply a recorded ``placement`` (from ``preparation.json``) on a clear canvas."""

    box = placement["source_bbox"]
    left, top = int(box["x"]), int(box["y"])
    source_bbox = (left, top, left + int(box["width"]), top + int(box["height"]))
    size = placement["resized_size"]
    resized_size = (int(size["width"]), int(size["height"]))
    shift = placement["translation"]
    translation = (int(shift["x"]), int(shift["y"]))
    with Image.open(source_path) as opened:
        resized = opened.convert("RGBA").crop(source_bbox).resize(resized_size, resample=resample)
    transparent = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
    transparent.alpha_composite(resized, dest=translation)
    return transparent
