"""Frame-0 snap: one global scale + offset per clip, and the drift metric it exposes.

Frame 0 of an H3 clip reproduces the staged reference, so frame 0 calibrates the whole clip.
The snap maps the frame-0 figure onto the staged reference figure (same height, feet on the
baseline, centred) and applies that single transform to every frame. It is *recorded* here;
pack composes it with the cell fit so pixels are resampled exactly once.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from PIL import Image

from sprite_h3.errors import ProcessingError

from .background import measure_foreground
from .resample import area_resize

type ResampleFilter = Image.Resampling | Literal["area"]

type BBox = tuple[int, int, int, int]
type DriftVerdict = Literal["steady", "motion", "drift"]
type ClipVerdict = Literal["usable", "check", "regenerate"]

CORRECTION_WARN_PERCENT = 5.0
CORRECTION_RED_PERCENT = 15.0
DRIFT_MINIMUM_PERCENT = 5.0
"""A monotonic trend smaller than this (of the frame-0 height) is noise, not drift."""
DRIFT_MONOTONIC_FRACTION = 0.8
"""Share of same-sign consecutive deltas above which a trend counts as monotonic."""
DRIFT_MINIMUM_FRAMES = 4
"""Fewer frames than this cannot distinguish a trend from one motion beat."""


@dataclass(frozen=True, slots=True)
class SnapTransform:
    """``x' = x * scale + dx``, ``y' = y * scale + dy`` in canvas pixels."""

    scale: float
    dx: float
    dy: float
    frame0_bbox: BBox
    reference_bbox: BBox

    @property
    def correction_percent(self) -> float:
        return abs(self.scale - 1.0) * 100.0

    @property
    def anchor(self) -> tuple[float, float]:
        """Frame 0's feet (bottom centre): the source point every resample keeps exact."""

        left, _top, right, bottom = self.frame0_bbox
        return ((left + right) / 2, float(bottom))

    def to_dict(self) -> dict[str, Any]:
        return {
            "scale": self.scale,
            "dx": self.dx,
            "dy": self.dy,
            "correction_percent": round(self.correction_percent, 3),
            "frame0_bbox": bbox_dict(self.frame0_bbox),
            "reference_bbox": bbox_dict(self.reference_bbox),
        }


def bbox_dict(bbox: BBox) -> dict[str, int]:
    left, top, right, bottom = bbox
    return {"x": left, "y": top, "width": right - left, "height": bottom - top}


def bbox_from_dict(value: Any, label: str) -> BBox:
    if not isinstance(value, dict):
        raise ProcessingError(f"{label} must be an object")
    try:
        x, y, width, height = (int(value[key]) for key in ("x", "y", "width", "height"))
    except (KeyError, TypeError, ValueError) as error:
        raise ProcessingError(f"{label} must record x, y, width, height") from error
    if width <= 0 or height <= 0:
        raise ProcessingError(f"{label} must have positive size")
    return (x, y, x + width, y + height)


def measure_figure_bbox(image: Image.Image, *, alpha_threshold: int = 128) -> BBox | None:
    """Bounding box of the keyed figure; ``alpha_threshold`` mirrors the keyer's hard cut."""

    return measure_foreground(image, alpha_threshold=alpha_threshold).content_bbox


def compute_snap(frame0_bbox: BBox, reference_bbox: BBox) -> SnapTransform:
    """Scale frame 0's figure to the reference height; feet to the baseline; centre to centre."""

    f_left, f_top, f_right, f_bottom = frame0_bbox
    r_left, r_top, r_right, r_bottom = reference_bbox
    frame_height = f_bottom - f_top
    reference_height = r_bottom - r_top
    if frame_height <= 0 or reference_height <= 0:
        raise ProcessingError("snap requires a non-empty figure in frame 0 and the reference")
    scale = reference_height / frame_height
    # Continuous coordinates: bottom edge and horizontal centre of each box.
    frame_center = (f_left + f_right) / 2
    reference_center = (r_left + r_right) / 2
    dx = reference_center - frame_center * scale
    dy = r_bottom - f_bottom * scale
    return SnapTransform(
        scale=scale, dx=dx, dy=dy, frame0_bbox=frame0_bbox, reference_bbox=reference_bbox
    )


def transformed_bbox(bbox: BBox, scale: float, dx: float, dy: float) -> tuple[float, ...]:
    """Continuous bounds of ``bbox`` after ``x' = x * scale + dx``."""

    left, top, right, bottom = bbox
    return (left * scale + dx, top * scale + dy, right * scale + dx, bottom * scale + dy)


def apply_transform(
    image: Image.Image,
    *,
    scale: float,
    dx: float,
    dy: float,
    size: tuple[int, int],
    resample: ResampleFilter,
    anchor: tuple[float, float] | None = None,
) -> Image.Image:
    """Resample ``image`` once by ``scale`` and place it at the rounded offset on a clear canvas.

    The resize rounds the scaled size to whole pixels, so the effective scale differs from
    ``scale`` by a hair. ``anchor`` names the source point (frame 0's feet) whose destination
    must be exact; the offset is chosen so that point, not the image origin, lands on target.
    """

    rgba = image.convert("RGBA")
    if scale <= 0:
        raise ProcessingError("transform scale must be positive")
    scaled_size = (max(1, round(rgba.width * scale)), max(1, round(rgba.height * scale)))
    if scaled_size == rgba.size:
        scaled = rgba
    elif resample == "area":
        scaled = area_resize(rgba, scaled_size)
    else:
        scaled = rgba.resize(scaled_size, resample)
    if anchor is None:
        offset = (round(dx), round(dy))
    else:
        effective_x = scaled_size[0] / rgba.width
        effective_y = scaled_size[1] / rgba.height
        offset = (
            round(anchor[0] * scale + dx - anchor[0] * effective_x),
            round(anchor[1] * scale + dy - anchor[1] * effective_y),
        )
    output = Image.new("RGBA", size, (0, 0, 0, 0))
    _paste_clipped(output, scaled, offset)
    return output


def _paste_clipped(target: Image.Image, source: Image.Image, offset: tuple[int, int]) -> None:
    """``alpha_composite`` with a destination that may fall partly outside the target."""

    x, y = offset
    left = max(0, -x)
    top = max(0, -y)
    right = min(source.width, target.width - x)
    bottom = min(source.height, target.height - y)
    if right <= left or bottom <= top:
        return
    cropped = (
        source.crop((left, top, right, bottom))
        if (left, top, right, bottom)
        != (
            0,
            0,
            source.width,
            source.height,
        )
        else source
    )
    target.alpha_composite(cropped, dest=(x + left, y + top))


@dataclass(frozen=True, slots=True)
class DriftSeries:
    """One measured series across the clip and its classification."""

    name: str
    values: tuple[float, ...]
    trend_percent: float
    monotonic_fraction: float
    verdict: DriftVerdict

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "values": list(self.values),
            "trend_percent": round(self.trend_percent, 3),
            "monotonic_fraction": round(self.monotonic_fraction, 3),
            "verdict": self.verdict,
        }


def classify_series(name: str, values: Sequence[float], reference: float) -> DriftSeries:
    """Oscillation is motion; a monotonic trend beyond the minimum is model drift."""

    series = tuple(float(value) for value in values)
    if len(series) < 2 or reference <= 0:
        return DriftSeries(name, series, 0.0, 0.0, "steady")
    deltas = [series[index + 1] - series[index] for index in range(len(series) - 1)]
    signed = [delta for delta in deltas if delta != 0]
    if not signed:
        return DriftSeries(name, series, 0.0, 0.0, "steady")
    positive = sum(delta > 0 for delta in signed)
    monotonic_fraction = max(positive, len(signed) - positive) / len(signed)
    # Least-squares slope over the clip, expressed as total change relative to the reference.
    count = len(series)
    mean_x = (count - 1) / 2
    mean_y = sum(series) / count
    numerator = sum((index - mean_x) * (value - mean_y) for index, value in enumerate(series))
    denominator = sum((index - mean_x) ** 2 for index in range(count))
    slope = numerator / denominator if denominator else 0.0
    trend_percent = slope * (count - 1) / reference * 100.0
    span = (max(series) - min(series)) / reference * 100.0
    if abs(trend_percent) < DRIFT_MINIMUM_PERCENT or count < DRIFT_MINIMUM_FRAMES:
        verdict: DriftVerdict = "steady" if span < DRIFT_MINIMUM_PERCENT else "motion"
    elif monotonic_fraction >= DRIFT_MONOTONIC_FRACTION:
        verdict = "drift"
    else:
        verdict = "motion"
    return DriftSeries(name, series, trend_percent, monotonic_fraction, verdict)


@dataclass(frozen=True, slots=True)
class ClipAssessment:
    """Clip-level answer to "is this usable?" from the snap and the per-frame boxes."""

    snap: SnapTransform
    height: DriftSeries
    center_x: DriftSeries
    verdict: ClipVerdict
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "snap": self.snap.to_dict(),
            "drift": {"height": self.height.to_dict(), "center_x": self.center_x.to_dict()},
            "verdict": self.verdict,
            "reason": self.reason,
        }


def translation_series(frame0_bbox: BBox, frame_bboxes: Sequence[BBox | None]) -> tuple[float, ...]:
    """Per-frame horizontal shift of the whole silhouette relative to frame 0.

    A limb reaching out (punch, hit, wave) moves one edge of the box and therefore its centre,
    but the figure has not gone anywhere. Only when both edges move the same way has the
    silhouette translated; the shared part of that shift is the translation. Frames without a
    figure count as unmoved so the missing-figure rule reports them instead.
    """

    left0, _, right0, _ = frame0_bbox
    series: list[float] = []
    for bbox in frame_bboxes:
        if bbox is None:
            series.append(0.0)
            continue
        left_delta = float(bbox[0] - left0)
        right_delta = float(bbox[2] - right0)
        if left_delta * right_delta <= 0:
            series.append(0.0)
        elif abs(left_delta) < abs(right_delta):
            series.append(left_delta)
        else:
            series.append(right_delta)
    return tuple(series)


def assess_clip(
    snap: SnapTransform,
    frame_bboxes: Sequence[BBox | None],
    *,
    motion_class: str = "static",
) -> ClipAssessment:
    """Combine the correction factor and the drift series into one verdict with a reason."""

    reference_height = snap.frame0_bbox[3] - snap.frame0_bbox[1]
    heights = [0.0 if bbox is None else float(bbox[3] - bbox[1]) for bbox in frame_bboxes]
    centers = [
        float(snap.frame0_bbox[0] + snap.frame0_bbox[2]) / 2
        if bbox is None
        else (bbox[0] + bbox[2]) / 2
        for bbox in frame_bboxes
    ]
    height = classify_series("figure_height", heights, reference_height)
    center = classify_series("center_x", centers, reference_height)
    reasons: list[str] = []
    verdict: ClipVerdict = "usable"
    if height.verdict == "drift" or center.verdict == "drift":
        verdict = "regenerate"
        which = "figure height" if height.verdict == "drift" else "horizontal position"
        trend = height.trend_percent if height.verdict == "drift" else center.trend_percent
        reasons.append(f"{which} trends {trend:+.1f}% across the clip (model drift)")
    correction = snap.correction_percent
    if correction >= CORRECTION_RED_PERCENT:
        verdict = "regenerate" if verdict == "regenerate" else "check"
        reasons.append(f"frame 0 needed a {correction:.1f}% size correction")
    elif correction >= CORRECTION_WARN_PERCENT:
        if verdict == "usable":
            verdict = "check"
        reasons.append(f"frame 0 needed a {correction:.1f}% size correction")
    if motion_class == "static":
        translation = classify_series(
            "translation_x", translation_series(snap.frame0_bbox, frame_bboxes), reference_height
        )
        if translation.verdict != "steady":
            if verdict == "usable":
                verdict = "check"
            reasons.append("a static clip slides sideways as a whole")
    if any(bbox is None for bbox in frame_bboxes):
        verdict = "regenerate"
        reasons.append("at least one frame has no figure after keying")
    if not reasons:
        reasons.append(f"frame 0 matched the reference within {correction:.1f}%")
    return ClipAssessment(
        snap=snap, height=height, center_x=center, verdict=verdict, reason="; ".join(reasons)
    )


__all__ = [
    "CORRECTION_RED_PERCENT",
    "CORRECTION_WARN_PERCENT",
    "ClipAssessment",
    "DriftSeries",
    "SnapTransform",
    "apply_transform",
    "assess_clip",
    "bbox_dict",
    "bbox_from_dict",
    "classify_series",
    "compute_snap",
    "measure_figure_bbox",
    "transformed_bbox",
    "translation_series",
]
