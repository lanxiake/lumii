"""Deterministic frame sampling and bounce-order construction."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

type SelectionStrategy = Literal["all", "uniform", "indices", "stride"]


@dataclass(frozen=True, slots=True)
class SelectionResult[T]:
    """Selected frame values paired with their original zero-based indices."""

    frames: tuple[T, ...]
    source_indices: tuple[int, ...]
    strategy: SelectionStrategy
    bounce: bool


def _validate_nonnegative_integer(value: int, name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} must be a nonnegative integer")


def _uniform_positions(length: int, count: int) -> list[int]:
    if count == 1:
        return [0]
    denominator = count - 1
    # Integer half-up rounding yields stable endpoints without float behavior.
    return [
        (2 * sample * (length - 1) + denominator) // (2 * denominator) for sample in range(count)
    ]


def select_indices(
    frame_count: int,
    strategy: SelectionStrategy,
    *,
    count: int | None = None,
    indices: Sequence[int] | None = None,
    stride: int | None = None,
    drop_first: int = 0,
    drop_last: int = 0,
) -> list[int]:
    """Select source indices after applying deterministic edge drops."""

    if isinstance(frame_count, bool) or not isinstance(frame_count, int) or frame_count <= 0:
        raise ValueError("frame_count must be a positive integer")
    _validate_nonnegative_integer(drop_first, "drop_first")
    _validate_nonnegative_integer(drop_last, "drop_last")
    stop = frame_count - drop_last
    if drop_first >= stop:
        raise ValueError("frame drops leave no eligible frames")
    eligible = list(range(drop_first, stop))

    if strategy == "all":
        return eligible
    if strategy == "uniform":
        if isinstance(count, bool) or not isinstance(count, int) or count <= 0:
            raise ValueError("uniform selection requires a positive count")
        if count > len(eligible):
            raise ValueError("uniform count exceeds the number of eligible frames")
        return [eligible[position] for position in _uniform_positions(len(eligible), count)]
    if strategy == "indices":
        if indices is None or len(indices) == 0:
            raise ValueError("indices selection requires at least one explicit index")
        selected = list(indices)
        if any(isinstance(index, bool) or not isinstance(index, int) for index in selected):
            raise ValueError("source frame indices must be integers")
        if len(set(selected)) != len(selected):
            raise ValueError("source frame indices must be unique")
        if any(index < drop_first or index >= stop for index in selected):
            raise ValueError("source frame index is outside the eligible range")
        return selected
    if strategy == "stride":
        if isinstance(stride, bool) or not isinstance(stride, int) or stride <= 0:
            raise ValueError("stride selection requires a positive stride")
        return eligible[::stride]
    raise ValueError(f"unsupported selection strategy: {strategy}")


def apply_bounce[T](items: Sequence[T], bounce: bool) -> list[T]:
    """Construct playback order without duplicating endpoints.

    With ``bounce`` the reversed interior is appended so repeated playback does not hold
    either endpoint twice; that is what makes an open clip loopable. Without it the stored
    order is the playback order (whether the clip repeats is the engine's runtime decision).
    """

    values = list(items)
    if not values:
        raise ValueError("bounce construction requires at least one frame")
    if type(bounce) is not bool:
        raise ValueError("bounce must be true or false")
    if bounce:
        return values + values[-2:0:-1]
    return values


def packed_cell_count(base_frames: int, bounce: bool) -> int:
    """How many cells :func:`apply_bounce` packs for ``base_frames`` stored frames."""

    if base_frames < 1:
        raise ValueError("packed_cell_count requires at least one frame")
    return len(apply_bounce(range(base_frames), bounce))


def select_frames[T](
    frames: Sequence[T],
    strategy: SelectionStrategy,
    *,
    count: int | None = None,
    indices: Sequence[int] | None = None,
    stride: int | None = None,
    drop_first: int = 0,
    drop_last: int = 0,
    bounce: bool = False,
) -> SelectionResult[T]:
    """Select frame objects and apply the requested playback order."""

    selected_indices = select_indices(
        len(frames),
        strategy,
        count=count,
        indices=indices,
        stride=stride,
        drop_first=drop_first,
        drop_last=drop_last,
    )
    looped_indices = apply_bounce(selected_indices, bounce)
    return SelectionResult(
        frames=tuple(frames[index] for index in looped_indices),
        source_indices=tuple(looped_indices),
        strategy=strategy,
        bounce=bounce,
    )
