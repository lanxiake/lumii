"""Border-connected flat-key removal and foreground measurements.

Every operation here is vectorized with NumPy and SciPy's C-implemented
labelling. The arithmetic is integer and deterministic: results are
bit-identical to the original per-pixel reference implementation.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
from PIL import Image
from scipy import ndimage

from sprite_h3.preparation.canvas import parse_rgb_color

type RGBColor = tuple[int, int, int]
type BBox = tuple[int, int, int, int]

_CROSS = ndimage.generate_binary_structure(2, 1)

GENERATED_FRAME_MAXIMUM_KEY_SHIFT = 96
GENERATED_FRAME_SPILL_RADIUS = 16
"""Fixed key-estimation and despill settings shared by processing and its preview."""


def _bbox_dict(bbox: BBox | None) -> dict[str, int] | None:
    if bbox is None:
        return None
    left, top, right, bottom = bbox
    return {
        "x": left,
        "y": top,
        "width": right - left,
        "height": bottom - top,
    }


@dataclass(frozen=True, slots=True)
class FrameMetrics:
    """Geometry and health signals derived only from a frame's alpha."""

    content_bbox: BBox | None
    bottom_row: int | None
    center_x: float | None
    foreground_area: int
    component_count: int
    touches_boundary: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "content_bbox": _bbox_dict(self.content_bbox),
            "bottom_row": self.bottom_row,
            "center_x": self.center_x,
            "foreground_area": self.foreground_area,
            "component_count": self.component_count,
            "touches_boundary": self.touches_boundary,
        }


@dataclass(slots=True)
class BackgroundRemovalResult:
    """A keyed RGBA frame plus reproducible diagnostics."""

    image: Image.Image
    estimated_background: RGBColor
    metrics: FrameMetrics
    removed_pixels: int
    soft_pixels: int
    decontaminated_pixels: int = 0


def _rgba_array(image: Image.Image) -> np.ndarray:
    return np.asarray(image.convert("RGBA"), dtype=np.uint8)


def _border_colors(rgb: np.ndarray, stride: int) -> np.ndarray:
    """Return border samples in the reference scan order as an (N, 3) array."""

    height, width = rgb.shape[:2]
    xs = np.arange(0, width, stride)
    parts = [rgb[0, xs]]
    if height > 1:
        top_bottom = np.empty((2 * len(xs), 3), dtype=rgb.dtype)
        top_bottom[0::2] = rgb[0, xs]
        top_bottom[1::2] = rgb[height - 1, xs]
        parts = [top_bottom]
    ys = np.arange(stride, max(stride, height - 1), stride)
    if len(ys):
        if width > 1:
            sides = np.empty((2 * len(ys), 3), dtype=rgb.dtype)
            sides[0::2] = rgb[ys, 0]
            sides[1::2] = rgb[ys, width - 1]
        else:
            sides = rgb[ys, 0]
        parts.append(sides)
    return np.concatenate(parts, axis=0)


def _median_low(values: np.ndarray) -> int:
    ordered = np.sort(values)
    return int(ordered[(len(ordered) - 1) // 2])


def estimate_background_color(
    image: Image.Image,
    expected_color: str | tuple[int, int, int] | list[int],
    *,
    sample_stride: int = 1,
    maximum_shift: int = 96,
) -> RGBColor:
    """Estimate generated key color from border pixels near the staged key.

    Selecting samples with knowledge of the configured key protects the result
    when a moving subject happens to touch part of the border.
    """

    if image.width <= 0 or image.height <= 0:
        raise ValueError("image dimensions must be positive")
    if isinstance(sample_stride, bool) or not isinstance(sample_stride, int):
        raise ValueError("sample_stride must be a positive integer")
    if sample_stride <= 0:
        raise ValueError("sample_stride must be a positive integer")
    if maximum_shift < 0:
        raise ValueError("maximum_shift must be nonnegative")

    expected = np.asarray(parse_rgb_color(expected_color), dtype=np.int64)
    rgb = _rgba_array(image)[..., :3]
    samples = _border_colors(rgb, sample_stride).astype(np.int64)
    distance_squared = np.sum((samples - expected) ** 2, axis=1)
    selected = samples[distance_squared <= maximum_shift**2]
    if len(selected) == 0:
        # A useful deterministic fallback for severely shifted generations:
        # estimate from the closest quarter rather than one possibly noisy pixel.
        order = np.argsort(distance_squared, kind="stable")
        selected = samples[order[: max(1, len(samples) // 4)]]
    return (
        _median_low(selected[:, 0]),
        _median_low(selected[:, 1]),
        _median_low(selected[:, 2]),
    )


def _label_components(mask: np.ndarray) -> tuple[np.ndarray, int]:
    labels, count = ndimage.label(mask, structure=_CROSS)
    return labels, int(count)


def _border_connected(mask: np.ndarray) -> np.ndarray:
    """Return the four-connected components of ``mask`` that touch any border."""

    labels, count = _label_components(mask)
    if count == 0:
        return np.zeros(mask.shape, dtype=bool)
    border_labels = np.concatenate((labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]))
    lookup = np.zeros(count + 1, dtype=bool)
    lookup[border_labels] = True
    lookup[0] = False
    return lookup[labels]


def measure_foreground(image: Image.Image, *, alpha_threshold: int = 1) -> FrameMetrics:
    """Measure all nontransparent foreground pixels in an image."""

    if alpha_threshold < 1 or alpha_threshold > 255:
        raise ValueError("alpha_threshold must be between 1 and 255")
    alpha = _rgba_array(image)[..., 3]
    return _measure_mask(alpha >= alpha_threshold)


def _measure_mask(mask: np.ndarray) -> FrameMetrics:
    height, width = mask.shape
    rows = np.flatnonzero(mask.any(axis=1))
    if len(rows) == 0:
        return FrameMetrics(
            content_bbox=None,
            bottom_row=None,
            center_x=None,
            foreground_area=0,
            component_count=0,
            touches_boundary=False,
        )
    columns = np.flatnonzero(mask.any(axis=0))
    bbox = (int(columns[0]), int(rows[0]), int(columns[-1]) + 1, int(rows[-1]) + 1)
    area = int(np.count_nonzero(mask))
    column_counts = mask.sum(axis=0, dtype=np.int64)
    x_sum = int(np.dot(column_counts, np.arange(width, dtype=np.int64)))
    _, component_count = _label_components(mask)
    touches_boundary = bool(
        mask[0, :].any()
        or mask[height - 1, :].any()
        or mask[:, 0].any()
        or mask[:, width - 1].any()
    )
    return FrameMetrics(
        content_bbox=bbox,
        bottom_row=bbox[3] - 1,
        center_x=x_sum / area,
        foreground_area=area,
        component_count=component_count,
        touches_boundary=touches_boundary,
    )


def largest_component_bbox(
    image: Image.Image, *, alpha_threshold: int = 1
) -> tuple[BBox, int] | None:
    """Return the largest foreground component's half-open bbox and area."""

    if alpha_threshold < 1 or alpha_threshold > 255:
        raise ValueError("alpha_threshold must be between 1 and 255")
    alpha = _rgba_array(image)[..., 3]
    labels, count = _label_components(alpha >= alpha_threshold)
    if count == 0:
        return None
    areas = np.bincount(labels.ravel(), minlength=count + 1)
    best: tuple[int, int, int, BBox] | None = None
    for label, slices in enumerate(ndimage.find_objects(labels), start=1):
        if slices is None:
            continue
        rows, columns = slices
        bbox: BBox = (columns.start, rows.start, columns.stop, rows.stop)
        # Resolve equal-area noise deterministically by preferring the lower,
        # then leftmost component: feet/subject bodies beat detached particles.
        key = (int(areas[label]), bbox[3], -bbox[0], bbox)
        if best is None or key[:3] > best[:3]:
            best = key
    assert best is not None
    return (best[3], best[0])


def _rounded_ratio(numerator: np.ndarray, denominator: np.ndarray | int) -> np.ndarray:
    """Round half away from zero, matching the integer reference arithmetic."""

    positive = (2 * numerator + denominator) // (2 * denominator)
    negative = -((2 * -numerator + denominator) // (2 * denominator))
    return np.where(numerator >= 0, positive, negative)


def _key_channels(background: RGBColor) -> tuple[list[int], list[int]] | None:
    """Split the key into its dominant channels and the neutral baseline channels.

    Magenta (255, 0, 255) gives ``([0, 2], [1])``; green gives ``([1], [0, 2])``. A grey key
    has no chroma direction and returns ``None``.

    A channel counts as dominant above a quarter of the key range. Half-strength keys such
    as ``#FF0080`` sit exactly on a half-range cutoff: the key *estimated* from a generated
    frame (``(250, 3, 125)``) would drop blue and degrade the matte into a red key that fades
    every skin tone.
    """

    key_minimum = min(background)
    key_range = max(background) - key_minimum
    if key_range < 2:
        return None
    dominant_cutoff = max(1, (key_range + 2) // 4)
    dominant = [
        channel for channel in range(3) if background[channel] - key_minimum >= dominant_cutoff
    ]
    nondominant = [channel for channel in range(3) if channel not in dominant]
    if not dominant or not nondominant:
        return None
    return dominant, nondominant


def chroma_matte(
    rgb: np.ndarray,
    background: RGBColor,
    *,
    tolerance: int,
    alpha_power: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray] | None:
    """Alpha and unmixed colour from how much key chroma each pixel carries.

    A pixel is modelled as ``alpha * foreground + (1 - alpha) * key``. Its key share is the
    excess of the dominant key channels over the neutral baseline (``min(R, B) - G`` for
    magenta), measured against the same excess of the key itself. Foreground colours may carry
    up to ``tolerance`` of that excess (skin, purple highlights) before they start to fade.
    ``alpha = (1 - share) ** alpha_power``: a power above 1 keeps the anti-aliased rim the
    generator painted into the key thin instead of preserving every blended pixel.

    The share is exact when the foreground has no key excess of its own (outlines, greys,
    skin, anything at or below ``tolerance``), which is what sprite edges are made of. A
    saturated non-key colour (pure green against magenta) has negative excess, so its blends
    read as *less* keyed than they are: the error is on the conservative side.

    Returns ``(alpha255, unmixed_rgb, key_share)`` as float arrays, or ``None`` for a key
    with no chroma direction.
    """

    channels = _key_channels(background)
    if channels is None:
        return None
    dominant, nondominant = channels
    key = np.asarray(background, dtype=np.float64)
    rgb = rgb.astype(np.float64)
    color_baseline = rgb[..., nondominant].max(axis=-1)
    key_baseline = key[nondominant].max()
    excess = np.min(
        np.stack([rgb[..., channel] - color_baseline for channel in dominant], axis=-1), axis=-1
    )
    key_excess = float(np.min([key[channel] - key_baseline for channel in dominant]))
    span = key_excess - tolerance
    if span <= 0:
        return None
    share = np.clip((excess - tolerance) / span, 0.0, 1.0)
    alpha = np.round(255.0 * (1.0 - share) ** alpha_power)

    # Unmix the key contribution, then despill whatever joint excess is left above the
    # tolerance. Only the *joint* excess is key chroma: a red shirt has R far above G but
    # B at G, so its excess is zero and it is left alone.
    partial = (share > 0) & (share < 1)
    keep = np.where(partial, 1.0 - share, 1.0)[..., None]
    unmixed = np.where(partial[..., None], (rgb - share[..., None] * key) / keep, rgb)
    residual = np.min(
        np.stack(
            [
                unmixed[..., channel] - unmixed[..., nondominant].max(axis=-1)
                for channel in dominant
            ],
            axis=-1,
        ),
        axis=-1,
    )
    spill = np.clip(residual - tolerance, 0.0, None)
    for channel in dominant:
        unmixed[..., channel] -= spill
    unmixed = np.clip(np.round(unmixed), 0, 255)
    return alpha, unmixed, share


def _key_fraction(
    rgb: np.ndarray, background: RGBColor
) -> tuple[np.ndarray, np.ndarray, int] | None:
    """Estimate the exact fraction of chroma-key spill for every pixel.

    The calculation generalizes the familiar magenta despill expression
    ``min(red, blue) - green``. For a one-channel key such as green, the
    strongest non-key channel is used as the neutral baseline, protecting
    foreground colors such as yellow and cyan. Returns ``(valid, numerator,
    denominator)`` where invalid pixels have no measurable spill.
    """

    channels = _key_channels(background)
    if channels is None:
        return None
    dominant, nondominant = channels

    color_baseline = rgb[..., nondominant].max(axis=-1)
    key_baseline = max(background[channel] for channel in nondominant)
    valid = np.ones(rgb.shape[:2], dtype=bool)
    best_numerator: np.ndarray | None = None
    best_denominator = 0
    for channel in dominant:
        denominator = background[channel] - key_baseline
        numerator = rgb[..., channel] - color_baseline
        if denominator <= 0:
            return None
        valid &= numerator > 0
        numerator = np.minimum(numerator, denominator)
        if best_numerator is None:
            best_numerator = numerator
            best_denominator = denominator
        else:
            better = numerator * best_denominator < best_numerator * denominator
            # Denominators differ per channel only when the key is asymmetric;
            # keep the pair as a common-denominator fraction to stay exact.
            best_numerator = np.where(
                better, numerator * best_denominator, best_numerator * denominator
            )
            best_denominator = best_denominator * denominator
    assert best_numerator is not None
    return (valid, best_numerator, best_denominator)


def remove_key_background(
    image: Image.Image,
    key_color: str | tuple[int, int, int] | list[int],
    *,
    hard_threshold: int = 16,
    soft_threshold: int = 40,
    estimate_color: bool = True,
    maximum_key_shift: int = 96,
    decontaminate: bool = True,
    spill_radius: int = 4,
    remove_enclosed: bool = True,
    minimum_alpha: int = 0,
    matte: str = "distance",
    chroma_tolerance: int = 20,
    alpha_power: float = 2.0,
) -> BackgroundRemovalResult:
    """Remove key-like pixels, keying enclosed pockets by default.

    ``matte="chroma"`` keys every pixel by the share of key chroma it carries (see
    :func:`chroma_matte`): a 2-px gap between an arm and the torso that the generator
    anti-aliased into the key is keyed even though no pixel in it is close to the key colour,
    and the rim gets a thin, despilled alpha ramp. ``hard_threshold`` still clears pixels
    at or below that distance; ``soft_threshold``, ``remove_enclosed`` and ``spill_radius``
    only shape the ``"distance"`` matte described below.

    Pixels at or below ``hard_threshold`` become fully transparent. Selected
    pixels between the hard and soft distances receive a linear soft alpha.
    By default every key-like pixel is background, including pockets fully
    enclosed by the subject (between an arm and the torso, inside hair curls).
    With ``remove_enclosed=False`` only pixels four-connected to the frame
    border are removed and enclosed key-colored details stay untouched. When
    decontamination is enabled, key spill is also unmixed within a limited
    four-connected band just inside the selected background boundary.
    Pixels whose final alpha falls below ``minimum_alpha`` are dropped so
    faint decontaminated haze does not outline the subject.
    """

    if hard_threshold < 0:
        raise ValueError("hard_threshold must be nonnegative")
    if soft_threshold < hard_threshold:
        raise ValueError("soft_threshold must be greater than or equal to hard_threshold")
    if soft_threshold > 442:
        raise ValueError("soft_threshold exceeds the maximum RGB distance")
    if isinstance(spill_radius, bool) or not isinstance(spill_radius, int) or spill_radius < 0:
        raise ValueError("spill_radius must be a nonnegative integer")
    if isinstance(minimum_alpha, bool) or not isinstance(minimum_alpha, int):
        raise ValueError("minimum_alpha must be an integer between 0 and 255")
    if not 0 <= minimum_alpha <= 255:
        raise ValueError("minimum_alpha must be an integer between 0 and 255")
    if matte not in {"distance", "chroma"}:
        raise ValueError("matte must be 'distance' or 'chroma'")
    if isinstance(chroma_tolerance, bool) or not isinstance(chroma_tolerance, int):
        raise ValueError("chroma_tolerance must be an integer between 0 and 255")
    if not 0 <= chroma_tolerance <= 255:
        raise ValueError("chroma_tolerance must be an integer between 0 and 255")
    if isinstance(alpha_power, bool) or not isinstance(alpha_power, (int, float)):
        raise ValueError("alpha_power must be a positive number")
    if not 0 < alpha_power <= 8:
        raise ValueError("alpha_power must be a positive number no greater than 8")
    configured_key = parse_rgb_color(key_color)
    estimated_key = (
        estimate_background_color(image, configured_key, maximum_shift=maximum_key_shift)
        if estimate_color
        else configured_key
    )

    rgba = _rgba_array(image)
    rgb = rgba[..., :3].astype(np.int64)
    original_alpha = rgba[..., 3].astype(np.int64)
    key = np.asarray(estimated_key, dtype=np.int64)
    distance_squared = np.sum((rgb - key) ** 2, axis=-1)

    if matte == "chroma":
        return _remove_by_chroma(
            rgb,
            original_alpha,
            estimated_key,
            distance_squared=distance_squared,
            hard_threshold=hard_threshold,
            tolerance=chroma_tolerance,
            alpha_power=alpha_power,
            minimum_alpha=minimum_alpha,
        )

    candidate = (original_alpha == 0) | (distance_squared <= soft_threshold**2)
    connected = candidate.copy() if remove_enclosed else _border_connected(candidate)

    threshold_span = soft_threshold - hard_threshold
    distance = np.floor(np.sqrt(distance_squared.astype(np.float64))).astype(np.int64)
    # Guard against floating-point sqrt landing one below an exact square.
    distance += (distance + 1) ** 2 <= distance_squared
    distance -= distance**2 > distance_squared
    if threshold_span == 0:
        matte_alpha = np.zeros_like(distance)
    else:
        matte_alpha = np.where(
            distance <= hard_threshold,
            0,
            np.minimum(255, (distance - hard_threshold) * 255 // threshold_span),
        )
    output_alpha = np.where(connected, np.minimum(original_alpha, matte_alpha), original_alpha)

    if decontaminate and spill_radius > 0:
        reach = ndimage.binary_dilation(
            connected, structure=_CROSS, iterations=spill_radius, mask=~connected
        )
        spill_band = reach & ~connected
    else:
        spill_band = np.zeros(connected.shape, dtype=bool)
    affected = connected | spill_band

    if decontaminate:
        # Do not reinterpret a key-like pixel that was explicitly protected by
        # the connected selection (for example, an enclosed magenta detail).
        unmix = affected & ~(spill_band & candidate)
        fraction = _key_fraction(rgb, estimated_key)
        if fraction is not None:
            valid, numerator, denominator = fraction
            spill_alpha = _rounded_ratio(original_alpha * (denominator - numerator), denominator)
            output_alpha = np.where(
                unmix & valid, np.minimum(output_alpha, spill_alpha), output_alpha
            )

    if minimum_alpha > 0:
        output_alpha = np.where(output_alpha < minimum_alpha, 0, output_alpha)
    visible = output_alpha > 0
    decontaminated = visible & affected & (output_alpha < original_alpha) if decontaminate else None
    output_rgb = rgb.copy()
    if decontaminated is not None and decontaminated.any():
        safe_alpha = np.where(visible, output_alpha, 1)
        key_share = (original_alpha - output_alpha)[..., None]
        numerator = rgb * original_alpha[..., None] - key * key_share
        corrected = np.clip(_rounded_ratio(numerator, safe_alpha[..., None]), 0, 255)
        output_rgb = np.where(decontaminated[..., None], corrected, output_rgb)
    output_rgb = np.where(visible[..., None], output_rgb, 0)

    output_array = np.concatenate(
        (output_rgb.astype(np.uint8), output_alpha.astype(np.uint8)[..., None]), axis=-1
    )
    output = Image.fromarray(np.ascontiguousarray(output_array), mode="RGBA")
    return BackgroundRemovalResult(
        image=output,
        estimated_background=estimated_key,
        metrics=_measure_mask(visible),
        removed_pixels=int(np.count_nonzero(~visible)),
        soft_pixels=int(np.count_nonzero(visible & (output_alpha < 255))),
        decontaminated_pixels=(
            0 if decontaminated is None else int(np.count_nonzero(decontaminated))
        ),
    )


def _remove_by_chroma(
    rgb: np.ndarray,
    original_alpha: np.ndarray,
    estimated_key: RGBColor,
    *,
    distance_squared: np.ndarray,
    hard_threshold: int,
    tolerance: int,
    alpha_power: float,
    minimum_alpha: int,
) -> BackgroundRemovalResult:
    """The ``matte="chroma"`` branch of :func:`remove_key_background`."""

    matte = chroma_matte(rgb, estimated_key, tolerance=tolerance, alpha_power=alpha_power)
    if matte is None:
        raise ValueError(
            "the chroma matte needs a saturated key colour; "
            f"{estimated_key} has no chroma direction"
        )
    matte_alpha, unmixed, share = matte
    matte_alpha = np.where(distance_squared <= hard_threshold**2, 0.0, matte_alpha)
    output_alpha = np.minimum(original_alpha, matte_alpha.astype(np.int64))
    if minimum_alpha > 0:
        output_alpha = np.where(output_alpha < minimum_alpha, 0, output_alpha)
    visible = output_alpha > 0
    unmixed_int = unmixed.astype(np.int64)
    decontaminated = visible & ((share > 0) | np.any(unmixed_int != rgb, axis=-1))
    output_rgb = np.where(visible[..., None], unmixed_int, 0)

    output_array = np.concatenate(
        (output_rgb.astype(np.uint8), output_alpha.astype(np.uint8)[..., None]), axis=-1
    )
    output = Image.fromarray(np.ascontiguousarray(output_array), mode="RGBA")
    return BackgroundRemovalResult(
        image=output,
        estimated_background=estimated_key,
        metrics=_measure_mask(visible),
        removed_pixels=int(np.count_nonzero(~visible)),
        soft_pixels=int(np.count_nonzero(visible & (output_alpha < 255))),
        decontaminated_pixels=int(np.count_nonzero(decontaminated)),
    )
