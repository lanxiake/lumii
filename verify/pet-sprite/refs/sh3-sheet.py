"""Fixed-cell sprite sheets (``sheet.json`` v3), and review contact sheets.

One shared cell and one shared anchor per sheet. Two layouts slice the same cells:

* ``per-action`` — one texture per action, one row per facing (a per-cell repack is the one-row
  case, an action pack the N-row case). ``columns`` is the number of frames per row, so every
  row must hold the same count.
* ``per-facing`` — one texture per facing, one row per action. Actions differ in length, so
  rows may be ragged: ``columns`` is the widest row and each row records its own frame count,
  ``closed``, ``bounce`` and ``frame_duration_ms``.

Format 3 names where every frame came from: a frame may carry a ``source`` (run,
the run's action and facing, processing revision, source index), the document lists the
distinct sources, and a sheet cut from a character build says which build. A run-local pack
draws every frame from one run, a build draws them from several, and the sheet no longer
implies its run. The source's action is the run's cell name, which an alias or a rename can
detach from the row's action id, so the sheet records it rather than the reader guessing it.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from hashlib import sha256
from pathlib import Path
from typing import Any, Literal

from PIL import Image, ImageDraw

from sprite_h3.models import ALL_FACINGS, Facing

from .background import measure_foreground

SHEET_FORMAT = 3
"""``sheet.json`` schema version written; readers accept :data:`READABLE_SHEET_FORMATS`."""
READABLE_SHEET_FORMATS: tuple[int, ...] = (2, 3)
"""Format 2 lacks the provenance fields only; every field a reader needs exists in both, so the
packs already on disk keep summarizing and measuring."""

SheetLayout = Literal["per-action", "per-facing"]
SHEET_LAYOUTS: tuple[SheetLayout, ...] = ("per-action", "per-facing")


@dataclass(frozen=True, slots=True)
class SheetAnchor:
    """The pivot shared by every frame of the sheet, in cell pixels."""

    x: float
    y: float
    from_bottom: float
    """Rows below the anchor row; the same number in every sheet of a character."""

    def to_dict(self) -> dict[str, float]:
        return {"x": self.x, "y": self.y, "from_bottom": self.from_bottom}


@dataclass(frozen=True, slots=True)
class FrameSource:
    """Where one packed frame came from: a run's cell, its processing revision and the frame
    in it. ``action`` and ``facing`` name the run's own cell; a run-local packer may leave
    them ``None`` and the sheet fills in the row's cell (which is the same cell there)."""

    run: str
    processing_revision: int
    source_index: int
    action: str | None = None
    facing: Facing | None = None


@dataclass(slots=True)
class SheetFrame:
    """A fixed-cell frame with source identity."""

    image: Image.Image
    source_index: int
    input_sha256: str | None = None
    source: FrameSource | None = None
    """The run and revision the frame was pinned from; ``None`` for a run-implicit frame."""

    @classmethod
    def from_path(
        cls, path: str | Path, *, source_index: int, source: FrameSource | None = None
    ) -> SheetFrame:
        input_path = Path(path)
        with Image.open(input_path) as opened:
            image = opened.convert("RGBA")
            image.load()
        return cls(
            image=image,
            source_index=source_index,
            input_sha256=sha256(input_path.read_bytes()).hexdigest(),
            source=source,
        )


@dataclass(slots=True)
class SheetRow:
    """One cell's frames in packed order plus the revisions they came from.

    ``facing`` names the row of a ``per-action`` sheet; ``action`` names the row of a
    ``per-facing`` sheet (where every row shares the sheet's facing). ``closed``/``bounce``/
    ``frame_duration_ms`` are recorded per row when set, which a ``per-facing`` sheet needs
    because its rows are different actions.
    """

    facing: Facing
    frames: Sequence[SheetFrame]
    source: dict[str, Any] = field(default_factory=dict)
    """``{"curation_revision", "processing_revision"}`` as recorded by the packer."""
    action: str | None = None
    closed: bool | None = None
    bounce: bool | None = None
    frame_duration_ms: int | None = None


@dataclass(slots=True)
class SheetResult:
    """A packed image and its engine-neutral metadata document."""

    image: Image.Image
    metadata: dict[str, Any]


def _pixel_hash(image: Image.Image) -> str:
    rgba = image.convert("RGBA")
    digest = sha256()
    digest.update(b"sprite-h3-rgba-v1\0")
    digest.update(rgba.width.to_bytes(8, "big"))
    digest.update(rgba.height.to_bytes(8, "big"))
    digest.update(rgba.tobytes())
    return digest.hexdigest()


def _bbox_dict(bbox: tuple[int, int, int, int] | None) -> dict[str, int] | None:
    if bbox is None:
        return None
    left, top, right, bottom = bbox
    return {
        "x": left,
        "y": top,
        "width": right - left,
        "height": bottom - top,
    }


def _validate_rows(
    rows: Sequence[SheetRow],
    cell_size: tuple[int, int],
    padding: int,
    frame_duration_ms: int,
    closed: bool,
    bounce: bool,
    layout: SheetLayout = "per-action",
) -> int:
    """Check every argument and return the sheet's column count.

    ``per-action`` rows are unique facings of one length; ``per-facing`` rows are unique
    actions of any length, so ``columns`` is the widest row.
    """

    if not rows:
        raise ValueError("at least one row is required")
    cell_width, cell_height = cell_size
    if cell_width <= 0 or cell_height <= 0:
        raise ValueError("cell dimensions must be positive")
    if isinstance(padding, bool) or not isinstance(padding, int) or padding < 0:
        raise ValueError("padding must be a nonnegative integer")
    if (
        isinstance(frame_duration_ms, bool)
        or not isinstance(frame_duration_ms, int)
        or frame_duration_ms <= 0
    ):
        raise ValueError("frame_duration_ms must be a positive integer")
    if type(closed) is not bool or type(bounce) is not bool:
        raise ValueError("closed and bounce must be true or false")
    if layout not in SHEET_LAYOUTS:
        raise ValueError(f"unknown sheet layout: {layout!r}")
    seen: set[str] = set()
    columns = len(rows[0].frames) if layout == "per-action" else max(len(r.frames) for r in rows)
    if columns <= 0:
        raise ValueError("every row needs at least one frame")
    for row in rows:
        if row.facing not in ALL_FACINGS:
            raise ValueError(f"unknown facing: {row.facing!r}")
        if layout == "per-action":
            key = row.facing
            if key in seen:
                raise ValueError(f"facing {row.facing!r} appears twice")
            if len(row.frames) != columns:
                raise ValueError(
                    f"row {row.facing!r} has {len(row.frames)} frames; every row must hold "
                    f"{columns} (one column per frame)"
                )
        else:
            if not isinstance(row.action, str) or not row.action.strip():
                raise ValueError("every row of a per-facing sheet names its action")
            if row.facing != rows[0].facing:
                raise ValueError("every row of a per-facing sheet shares one facing")
            key = row.action
            if key in seen:
                raise ValueError(f"action {row.action!r} appears twice")
            if not row.frames:
                raise ValueError(f"row {row.action!r} has no frames")
            if row.frame_duration_ms is not None and (
                isinstance(row.frame_duration_ms, bool)
                or not isinstance(row.frame_duration_ms, int)
                or row.frame_duration_ms <= 0
            ):
                raise ValueError(f"row {row.action!r} frame_duration_ms must be positive")
        seen.add(key)
        for frame in row.frames:
            if frame.image.size != cell_size:
                raise ValueError(
                    f"frame {frame.source_index} of {row.facing!r} has size {frame.image.size}; "
                    f"expected fixed cell {cell_size}"
                )
            if (
                isinstance(frame.source_index, bool)
                or not isinstance(frame.source_index, int)
                or frame.source_index < 0
            ):
                raise ValueError("source frame indices must be nonnegative integers")
    return columns


def _validate_anchor(anchor: SheetAnchor, cell_size: tuple[int, int]) -> None:
    cell_width, cell_height = cell_size
    if not (0 <= anchor.x < cell_width and 0 <= anchor.y < cell_height):
        raise ValueError("the anchor must lie inside the cell")
    if abs(anchor.from_bottom - (cell_height - 1 - anchor.y)) > 1e-6:
        raise ValueError("anchor.from_bottom must equal cell_height - 1 - anchor.y")


def build_sprite_sheet(
    rows: Sequence[SheetRow],
    *,
    action: str,
    project: str,
    cell_size: tuple[int, int],
    anchor: SheetAnchor,
    figure_height_px: int,
    padding: int = 0,
    frame_duration_ms: int = 42,
    closed: bool = True,
    bounce: bool = False,
    layout: SheetLayout = "per-action",
    facing: Facing | None = None,
    figure_height_px_side: int | None = None,
    build: Mapping[str, Any] | None = None,
) -> SheetResult:
    """Pack already normalized frames without resizing or trimming them.

    ``figure_height_px_side`` records the left/right standing height when the sheet packs
    those facings shorter than ``figure_height_px``.

    ``per-action`` (default): one row per facing of ``action``; ``closed`` and ``bounce`` are
    facts about every row (whether the last stored frame returns to the first, and whether the
    reversed interior was appended). ``per-facing``: one row per action of ``facing``; the
    sheet-level ``closed``/``bounce``/``frame_duration_ms`` are defaults and each row records
    its own. Play-once versus repeat is the engine's runtime decision.

    ``build`` (``{"character", "number"}``) names the character build a sheet was cut from;
    a run-local pack passes nothing and the document records ``null``.
    """

    columns = _validate_rows(rows, cell_size, padding, frame_duration_ms, closed, bounce, layout)
    if build is not None and (
        not isinstance(build.get("character"), str)
        or isinstance(build.get("number"), bool)
        or not isinstance(build.get("number"), int)
    ):
        raise ValueError("build must name a character id and an integer build number")
    _validate_anchor(anchor, cell_size)
    if layout == "per-action" and not action.strip():
        raise ValueError("action name must not be empty")
    if layout == "per-facing":
        if facing is None:
            facing = rows[0].facing
        if facing != rows[0].facing:
            raise ValueError("facing must match the rows of a per-facing sheet")
    if not project.strip():
        raise ValueError("project name must not be empty")
    if isinstance(figure_height_px, bool) or not isinstance(figure_height_px, int):
        raise ValueError("figure_height_px must be an integer")
    if not 0 < figure_height_px <= cell_size[1]:
        raise ValueError("figure_height_px must be positive and fit the cell")
    if figure_height_px_side is not None and (
        isinstance(figure_height_px_side, bool)
        or not isinstance(figure_height_px_side, int)
        or not 0 < figure_height_px_side <= cell_size[1]
    ):
        raise ValueError("figure_height_px_side must be a positive integer that fits the cell")
    cell_width, cell_height = cell_size
    row_count = len(rows)
    sheet_width = columns * cell_width + max(0, columns - 1) * padding
    sheet_height = row_count * cell_height + max(0, row_count - 1) * padding
    sheet = Image.new("RGBA", (sheet_width, sheet_height), (0, 0, 0, 0))
    row_entries: list[dict[str, Any]] = []
    sources: set[tuple[str, int]] = set()

    for row_index, row in enumerate(rows):
        y = row_index * (cell_height + padding)
        frame_entries: list[dict[str, Any]] = []
        for order, frame in enumerate(row.frames):
            x = order * (cell_width + padding)
            rgba = frame.image.convert("RGBA")
            sheet.alpha_composite(rgba, dest=(x, y))
            metrics = measure_foreground(rgba)
            input_sha256 = frame.input_sha256 or _pixel_hash(rgba)
            source: dict[str, Any] | None = None
            if frame.source is not None:
                sources.add((frame.source.run, frame.source.processing_revision))
                source = {
                    "run": frame.source.run,
                    # A run-local packer leaves the cell implicit: it is this row's cell.
                    "action": (
                        frame.source.action
                        if frame.source.action is not None
                        else (row.action if layout == "per-facing" else action)
                    ),
                    "facing": frame.source.facing or row.facing,
                    "processing_revision": frame.source.processing_revision,
                    "source_index": frame.source.source_index,
                    "input_sha256": input_sha256,
                }
            frame_entries.append(
                {
                    "order": order,
                    # Kept beside ``source`` for one release: the review and check readers
                    # still address frames by this run-implicit index.
                    "source_frame_index": frame.source_index,
                    "rect": {
                        "x": x,
                        "y": y,
                        "width": cell_width,
                        "height": cell_height,
                    },
                    "content_bbox": _bbox_dict(metrics.content_bbox),
                    "input_sha256": input_sha256,
                    "source": source,
                }
            )
        entry: dict[str, Any] = {
            "facing": row.facing,
            "row": row_index,
            "frame_order": [frame.source_index for frame in row.frames],
            "source": dict(row.source),
            "frames": frame_entries,
        }
        if layout == "per-facing":
            entry["action"] = row.action
            entry["closed"] = closed if row.closed is None else row.closed
            entry["bounce"] = bounce if row.bounce is None else row.bounce
            entry["frame_duration_ms"] = (
                frame_duration_ms if row.frame_duration_ms is None else row.frame_duration_ms
            )
        row_entries.append(entry)

    metadata: dict[str, Any] = {
        "format": SHEET_FORMAT,
        "layout": layout,
        "action": action if layout == "per-action" else None,
        "facing": facing if layout == "per-facing" else None,
        "project": project,
        "cell": {"width": cell_width, "height": cell_height},
        "padding": padding,
        "frame_duration_ms": frame_duration_ms,
        "closed": closed,
        "bounce": bounce,
        "figure_height_px": figure_height_px,
        "figure_height_px_side": figure_height_px_side,
        "anchor": anchor.to_dict(),
        "sheet": {
            "width": sheet_width,
            "height": sheet_height,
            "columns": columns,
            "rows": row_count,
        },
        "rows": row_entries,
        "mirrors": {},
        "sources": [
            {"run": run, "processing_revision": revision} for run, revision in sorted(sources)
        ],
        "build": (
            None
            if build is None
            else {"character": build["character"], "number": int(build["number"])}
        ),
    }
    return SheetResult(image=sheet, metadata=metadata)


def checkerboard(size: tuple[int, int], tile_size: int = 8) -> Image.Image:
    """The review board behind transparent frames; shared with the compare contact sheet."""

    width, height = size
    image = Image.new("RGB", size, (224, 224, 224))
    draw = ImageDraw.Draw(image)
    alternate = (184, 184, 184)
    for y in range(0, height, tile_size):
        for x in range(0, width, tile_size):
            if (x // tile_size + y // tile_size) % 2:
                draw.rectangle(
                    (x, y, min(width - 1, x + tile_size - 1), min(height - 1, y + tile_size - 1)),
                    fill=alternate,
                )
    return image


def build_contact_sheet(
    rows: Sequence[SheetRow],
    *,
    cell_size: tuple[int, int],
    gap: int = 4,
    label_height: int = 16,
    layout: SheetLayout = "per-action",
) -> Image.Image:
    """Build a checkerboard review image: one labelled row per cell, frame numbers overlaid."""

    columns = _validate_rows(rows, cell_size, gap, 1, True, False, layout)
    if label_height <= 0:
        raise ValueError("label_height must be positive")
    cell_width, cell_height = cell_size
    row_count = len(rows)
    review_width = columns * cell_width + max(0, columns - 1) * gap
    review_height = row_count * (cell_height + label_height) + max(0, row_count - 1) * gap
    review = Image.new("RGB", (review_width, review_height), (32, 32, 32))
    draw = ImageDraw.Draw(review)
    # One rectangle per tile, and the same board under every cell: draw it once, copy per cell.
    checker_template = checkerboard(cell_size).convert("RGBA")
    for row_index, row in enumerate(rows):
        y = row_index * (cell_height + label_height + gap)
        for order, frame in enumerate(row.frames):
            x = order * (cell_width + gap)
            draw.rectangle((x, y, x + cell_width - 1, y + label_height - 1), fill=(20, 20, 20))
            name = row.action if layout == "per-facing" else row.facing
            label = f"{name} #{frame.source_index}" if order == 0 else f"#{frame.source_index}"
            draw.text((x + 3, y + 2), label, fill=(255, 255, 255))
            board = checker_template.copy()
            board.alpha_composite(frame.image.convert("RGBA"))
            review.paste(board.convert("RGB"), (x, y + label_height))
    return review


def pack_sprite_sheet(
    rows: Sequence[SheetRow],
    sheet_path: str | Path,
    metadata_path: str | Path,
    *,
    action: str,
    project: str,
    cell_size: tuple[int, int],
    anchor: SheetAnchor,
    figure_height_px: int,
    padding: int = 0,
    frame_duration_ms: int = 42,
    closed: bool = True,
    bounce: bool = False,
    contact_sheet_path: str | Path | None = None,
    layout: SheetLayout = "per-action",
    facing: Facing | None = None,
    figure_height_px_side: int | None = None,
    build: Mapping[str, Any] | None = None,
) -> SheetResult:
    """Write clean PNG/JSON outputs and, optionally, a labeled contact sheet."""

    result = build_sprite_sheet(
        rows,
        action=action,
        project=project,
        cell_size=cell_size,
        anchor=anchor,
        figure_height_px=figure_height_px,
        padding=padding,
        frame_duration_ms=frame_duration_ms,
        closed=closed,
        bounce=bounce,
        layout=layout,
        facing=facing,
        figure_height_px_side=figure_height_px_side,
        build=build,
    )
    image_output = Path(sheet_path)
    json_output = Path(metadata_path)
    image_output.parent.mkdir(parents=True, exist_ok=True)
    json_output.parent.mkdir(parents=True, exist_ok=True)
    result.metadata["sheet"]["image"] = image_output.name
    result.image.save(image_output, format="PNG", optimize=False)
    json_output.write_text(
        json.dumps(result.metadata, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    if contact_sheet_path is not None:
        contact_output = Path(contact_sheet_path)
        contact_output.parent.mkdir(parents=True, exist_ok=True)
        contact = build_contact_sheet(rows, cell_size=cell_size, layout=layout)
        contact.save(contact_output, format="PNG", optimize=False)
    return result


def read_sheet_document(document: Any) -> dict[str, Any]:
    """Validate a ``sheet.json`` v2 or v3 document's top-level shape; reject anything else.

    The fields every reader uses (``cell``, ``anchor``, ``layout``, ``rows[].action`` and
    ``rows[].frames[].content_bbox``) exist in both formats; v3 only adds provenance.
    """

    if not isinstance(document, dict) or document.get("format") not in READABLE_SHEET_FORMATS:
        readable = " or ".join(str(number) for number in READABLE_SHEET_FORMATS)
        raise ValueError(f"sheet.json must declare format {readable}")
    cell = document.get("cell")
    rows = document.get("rows")
    anchor = document.get("anchor")
    if (
        not isinstance(cell, dict)
        or not isinstance(cell.get("width"), int)
        or not isinstance(cell.get("height"), int)
        or not isinstance(rows, list)
        or not rows
        or not isinstance(anchor, dict)
        or any(not isinstance(anchor.get(key), (int, float)) for key in ("x", "y", "from_bottom"))
    ):
        raise ValueError("sheet.json v2 needs cell{width,height}, anchor{x,y,from_bottom}, rows[]")
    layout = document.get("layout", "per-action")
    if layout not in SHEET_LAYOUTS:
        raise ValueError(f"sheet.json layout must be one of {SHEET_LAYOUTS}")
    for row in rows:
        if (
            not isinstance(row, dict)
            or row.get("facing") not in ALL_FACINGS
            or not isinstance(row.get("frames"), list)
        ):
            raise ValueError("sheet.json rows need a facing and frames")
        if layout == "per-facing" and not isinstance(row.get("action"), str):
            raise ValueError("sheet.json per-facing rows need an action")
    return document


__all__ = [
    "READABLE_SHEET_FORMATS",
    "SHEET_FORMAT",
    "SHEET_LAYOUTS",
    "FrameSource",
    "SheetAnchor",
    "SheetLayout",
    "SheetFrame",
    "SheetResult",
    "SheetRow",
    "build_contact_sheet",
    "build_sprite_sheet",
    "checkerboard",
    "pack_sprite_sheet",
    "read_sheet_document",
]
