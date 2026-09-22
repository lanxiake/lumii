"""Accept chroma-keyed character sources by keying them into the transparent canon.

An upload with real alpha is the canon as-is. An opaque upload is accepted only when its
border ring is one flat, saturated colour — then it is keyed with the pipeline's own keyer and
the detected colour becomes the project's key. Everything downstream keeps reading a
transparent PNG.
"""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from typing import Literal

import numpy as np
from PIL import Image

from .canvas import SpriteValidationError, check_transparency

RING = 2
"""Border ring width in pixels; the only region assumed to be background."""
MIN_SIDE = 8
DETECT_DISTANCE = 16
"""Keyer distance within which a ring pixel counts as the key; tighter than keying's 48."""
DETECT_COVERAGE = 0.99
MIN_SATURATION = 0.5
MIN_VALUE = 0.35
KEY_HARD_THRESHOLD = 48
KEY_SOFT_THRESHOLD = 80
KEY_MINIMUM_ALPHA = 48


@dataclass(frozen=True, slots=True)
class ChromaKeyDetection:
    color: str
    """``#RRGGBB``."""
    border_coverage: float
    saturation: float


@dataclass(frozen=True, slots=True)
class CanonicalSource:
    png: bytes
    """The transparent canon."""
    kind: Literal["transparent", "chroma"]
    detection: ChromaKeyDetection | None
    original_png: bytes | None
    """The opaque upload when ``kind == "chroma"``."""


def _has_real_alpha(image: Image.Image) -> bool:
    if "A" not in image.getbands() and "transparency" not in image.info:
        return False
    alpha_min, alpha_max = image.convert("RGBA").getchannel("A").getextrema()
    return alpha_max > 0 and alpha_min < 255


def detect_chroma_key(image: Image.Image) -> ChromaKeyDetection | None:
    """The flat saturated colour covering ≥ 99 % of the border ring, or ``None``."""

    if image.width < MIN_SIDE or image.height < MIN_SIDE:
        return None
    rgb = np.asarray(image.convert("RGB"), dtype=np.int64)
    ring_mask = np.zeros(rgb.shape[:2], dtype=bool)
    ring_mask[:RING, :] = ring_mask[-RING:, :] = True
    ring_mask[:, :RING] = ring_mask[:, -RING:] = True
    ring = rgb[ring_mask]

    packed = (ring[:, 0] << 16) | (ring[:, 1] << 8) | ring[:, 2]
    values, counts = np.unique(packed, return_counts=True)
    mode = int(values[np.argmax(counts)])
    key = np.array([(mode >> 16) & 255, (mode >> 8) & 255, mode & 255], dtype=np.int64)

    distance = np.sqrt(np.sum((ring - key) ** 2, axis=-1))
    coverage = float(np.count_nonzero(distance <= DETECT_DISTANCE) / len(ring))
    if coverage < DETECT_COVERAGE:
        return None

    high, low = int(key.max()), int(key.min())
    value = high / 255
    saturation = 0.0 if high == 0 else (high - low) / high
    if saturation < MIN_SATURATION or value < MIN_VALUE:
        return None
    return ChromaKeyDetection(
        color=f"#{key[0]:02X}{key[1]:02X}{key[2]:02X}",
        border_coverage=coverage,
        saturation=saturation,
    )


def canonicalize_source(content: bytes) -> CanonicalSource:
    """Turn an uploaded PNG into the transparent canon, keying a chroma background if needed."""

    from sprite_h3.processing.background import remove_key_background

    with Image.open(BytesIO(content)) as opened:
        opened.load()
        if _has_real_alpha(opened):
            return CanonicalSource(
                png=content, kind="transparent", detection=None, original_png=None
            )
        detection = detect_chroma_key(opened)
        if detection is None:
            raise SpriteValidationError(
                "background is neither transparent nor a solid chroma key "
                "(a flat, saturated colour on every edge)"
            )
        rgb = opened.convert("RGB")

    keyed = remove_key_background(
        rgb,
        detection.color,
        hard_threshold=KEY_HARD_THRESHOLD,
        soft_threshold=KEY_SOFT_THRESHOLD,
        estimate_color=False,
        minimum_alpha=KEY_MINIMUM_ALPHA,
    ).image
    check_transparency(keyed)
    buffer = BytesIO()
    keyed.save(buffer, format="PNG", optimize=False)
    return CanonicalSource(
        png=buffer.getvalue(), kind="chroma", detection=detection, original_png=content
    )


__all__ = ["CanonicalSource", "ChromaKeyDetection", "canonicalize_source", "detect_chroma_key"]
