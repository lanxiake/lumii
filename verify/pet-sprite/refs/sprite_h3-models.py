"""Small immutable domain models for the sprite animation pipeline."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from hashlib import sha256
from pathlib import Path
from typing import Literal

type EffectiveSource = Literal["action", "store", "preset", "template", "workspace", "project"]
type MotionClass = Literal["static", "locomotion", "displacement"]
type Facing = Literal["down", "up", "left", "right", "_"]
type TemplateKind = Literal["figure", "prop"]
type ConsistencyPolicy = Literal["exact", "range", "free"]
type FrameCountPolicy = Literal["exact", "free"]
type ActionOrigin = Literal["template", "character"]

MOTION_CLASSES: tuple[MotionClass, ...] = ("static", "locomotion", "displacement")
FACINGS: tuple[Facing, ...] = ("down", "up", "left", "right")
"""The real facings of a ``figure`` character."""
PROP_FACING: Facing = "_"
"""The single pseudo-facing of a ``prop`` template: one unnamed source, one cell per action.

It is a literal ``_`` everywhere (cell key, ``actions/<action>/_/``, DB rows, routes); the
empty string stays reserved for the action- and facing-level pack rows.
"""
ALL_FACINGS: tuple[Facing, ...] = (*FACINGS, PROP_FACING)
type FacingGroup = Literal["front", "side"]
SIDE_FACINGS: tuple[Facing, ...] = ("left", "right")
"""The facings ``sheet.figure_height_px_side`` applies to."""


def facing_group(facing: Facing) -> FacingGroup:
    """``side`` for left/right, ``front`` for down/up and the prop pseudo-facing.

    The two groups are the two view axes of an angled asset: up and down show the same
    silhouette height, left and right show the other one. A humanoid is as tall from every
    side, so for a character both groups share one height.
    """

    return "side" if facing in SIDE_FACINGS else "front"


TEMPLATE_KINDS: tuple[TemplateKind, ...] = ("figure", "prop")
DEFAULT_TEMPLATE = "default"
"""Every workspace's empty template: ``figure``, no actions, every policy ``free``."""

DEFAULT_FIGURE_HEIGHT_RATIO = 0.75
DEFAULT_BASELINE_RATIO = 0.88
DISPLACEMENT_FIGURE_HEIGHT_RATIO = 0.60
DISPLACEMENT_BASELINE_RATIO = 0.85


def default_closed(motion_class: str) -> bool:
    """Whether a clip of this motion class must return to its starting pose by default."""

    return motion_class != "displacement"


def preset_staging_ratios(motion_class: str) -> tuple[float, float] | None:
    """Staging ratios a motion class forces (only ``displacement`` needs headroom)."""

    if motion_class == "displacement":
        return (DISPLACEMENT_FIGURE_HEIGHT_RATIO, DISPLACEMENT_BASELINE_RATIO)
    return None


@dataclass(frozen=True, slots=True)
class CellKey:
    """One generated cell of a character: an action seen from one facing."""

    action: str
    facing: Facing


@dataclass(frozen=True, slots=True)
class SourceSet:
    """The canonical transparent PNGs of a character, one per facing it provides."""

    images: Mapping[Facing, Path]

    def __post_init__(self) -> None:
        if not self.images:
            raise ValueError("a character needs at least one facing source")
        unknown = sorted(set(self.images) - set(ALL_FACINGS))
        if unknown:
            raise ValueError(f"unknown facing(s): {', '.join(unknown)}")
        if PROP_FACING in self.images and len(self.images) > 1:
            raise ValueError("a prop has exactly one source; it has no facings")

    @property
    def facings(self) -> tuple[Facing, ...]:
        """Facings with a source, in canonical ``FACINGS`` order (a prop: ``("_",)``)."""

        return tuple(facing for facing in ALL_FACINGS if facing in self.images)

    @property
    def is_prop(self) -> bool:
        return PROP_FACING in self.images

    def image(self, facing: Facing) -> Path:
        return self.images[facing]

    @property
    def first(self) -> Path:
        """The first source in ``FACINGS`` order — the character's representative image."""

        return self.images[self.facings[0]]


@dataclass(frozen=True, slots=True)
class CharacterSpec:
    """Project-wide visual identity supplied to the prompt composer."""

    style: str
    identity: str


@dataclass(frozen=True, slots=True)
class ConsistencySpec:
    """A template's ``[consistency]`` policy, enforced by the workspace check only.

    The loader never refuses an override; the check reports mismatches as errors or
    information according to these policies.
    """

    figure_height: ConsistencyPolicy = "free"
    figure_height_range: tuple[int, int] | None = None
    """``(low, high)`` px, present exactly when ``figure_height == "range"``."""
    frame_counts: FrameCountPolicy = "free"


@dataclass(frozen=True, slots=True)
class TemplateRef:
    """The template a resolved project came from; what a run snapshot records."""

    name: str
    kind: TemplateKind = "figure"
    group: str = "characters"
    sha256: str | None = None
    """SHA-256 of ``template.toml`` when loaded from a workspace; ``None`` in tests."""
    consistency: ConsistencySpec = ConsistencySpec()


@dataclass(frozen=True, slots=True)
class PromptComposerSpec:
    """Backend-owned prompt composer selection."""

    composer: str


@dataclass(frozen=True, slots=True)
class EffectiveValue[T]:
    """One resolved inheritable value and the level that supplied it."""

    value: T
    source: EffectiveSource


@dataclass(frozen=True, slots=True)
class ActionStoreSnapshot:
    """Portable immutable provenance copied from an action-store version."""

    id: str
    version: int
    motion_sha256: str
    requested_seconds: float
    base_frames: int
    motion_class: str
    closed: bool
    collection: str = "builtin"
    """``builtin`` or ``user``: the store an entry id is unique within."""


@dataclass(frozen=True, slots=True)
class PromptValidationRow:
    """Typed validation or advisory emitted with a composed prompt."""

    level: Literal["error", "advisory", "info"]
    code: str
    message: str
    target: str


@dataclass(frozen=True, slots=True)
class PromptSegment:
    """One contiguous slice of the composed prompt and where its words came from.

    ``structure`` is the fixed I2VA scaffolding, ``character`` the project's own style and
    identity prose, ``motion`` the action's own prose, and ``derived`` a sentence the composer
    wrote from settings (staging ratio, facing, motion class, ``closed``). The preview shades
    ``derived`` differently so nobody retypes those facts by hand. ``override`` is the whole
    prompt when the action replaces the composed text with its own.
    """

    kind: Literal["structure", "character", "motion", "derived", "override"]
    text: str


@dataclass(frozen=True, slots=True)
class ComposedPrompt:
    """Exact backend prompt plus its composer and content provenance."""

    text: str
    composer: str
    composer_sha256: str
    sha256: str
    validation_rows: tuple[PromptValidationRow, ...]
    segments: tuple[PromptSegment, ...] = ()


@dataclass(frozen=True, slots=True)
class CanvasSpec:
    """Opaque, temporary model-input canvas settings.

    The staged reference is placed on a fixed grid: the figure is scaled so its standing
    height is exactly ``figure_height_ratio`` of the canvas height and its feet rest on the
    row at ``baseline_ratio`` of the canvas height. Both are generation concerns only; they
    decide how much headroom the model gets and never enter pack math.
    """

    width: int = 480
    height: int = 864
    background: str = "#FF00FF"
    figure_height_ratio: float = DEFAULT_FIGURE_HEIGHT_RATIO
    baseline_ratio: float = DEFAULT_BASELINE_RATIO

    @property
    def effective_width(self) -> int:
        return self.width

    @property
    def effective_height(self) -> int:
        return self.height


@dataclass(frozen=True, slots=True)
class VideoSpec:
    """Requested duration plus its normalized H3 generation parameters."""

    requested_seconds: float = 4.0
    fps: int = 24
    frames: int = 107
    seed: int = 0
    cfg_scale: float = 1.0
    # Sampler controls: ``None`` keeps the pinned workflow's own node value.
    sampler_name: str | None = None
    scheduler: str | None = None
    steps: int | None = None

    @property
    def nominal_frames(self) -> int:
        """Frame count before applying H3's ``17k + 5`` grid."""

        import math

        return math.ceil(self.requested_seconds * self.fps)

    @property
    def effective_frames(self) -> int:
        return self.frames

    @property
    def effective_seconds(self) -> float:
        return self.frames / self.fps


@dataclass(frozen=True, slots=True)
class ProcessingSpec:
    """Deterministic alpha recovery and registration settings."""

    remove_background: bool = True
    background_tolerance: int = 48
    background_soft_tolerance: int | None = None
    background_minimum_alpha: int = 48
    background_matte: str = "distance"
    """``chroma`` keys by key share (handles enclosed gaps); ``distance`` by RGB distance."""
    background_chroma_tolerance: int = 20
    """Key chroma a foreground colour may carry before it starts to fade (chroma matte)."""
    background_alpha_power: float = 2.0
    """Rim alpha curve ``(1 - key share) ** power``; above 1 keeps the rim thin."""
    anchor: str = "bottom-center"
    trim_transparent: bool = True


@dataclass(frozen=True, slots=True)
class FrameSelectionSpec:
    """Project fallback for human base-frame selection and playback."""

    base_count: int = 8
    drop_first: int = 0
    drop_last: int = 0


@dataclass(frozen=True, slots=True)
class SheetSpec:
    """Fixed-cell sprite-sheet layout."""

    layout: str = "grid"
    cell_width: int = 128
    cell_height: int = 128
    padding: int = 0
    frame_duration_ms: int = 100
    resample: str = "area"
    bounce: bool = False
    figure_height_px: int = 96
    """Standing figure height in the pack cell; one constant per project."""
    figure_height_px_side: int | None = None
    """Standing height of the left/right facings; ``None`` = ``figure_height_px``.

    A humanoid is as tall from every side and never needs this. An angled, non-flat asset
    (a tank seen top-down at 3/4) is not: its side silhouette is shorter than its front one,
    and fitting both to one height would draw the side view as a bigger object. The two
    heights pin one scale per view axis; the baseline and the cell stay those of the front
    height, so every facing keeps the same feet row. Prompts are composed from the action's
    staging ratio regardless; only staging and the pack fit scale the side facings.
    """

    def figure_height_for(self, facing: Facing) -> int:
        """The standing height this facing packs to."""

        if facing_group(facing) == "side" and self.figure_height_px_side is not None:
            return self.figure_height_px_side
        return self.figure_height_px

    @property
    def tallest_figure_height_px(self) -> int:
        """The taller of the two heights: what every cell must be able to hold."""

        return max(self.figure_height_px, self.figure_height_px_side or 0)

    def facing_scale(self, facing: Facing) -> float:
        """This facing's size relative to the front facings (1.0 for down/up)."""

        return self.figure_height_for(facing) / self.figure_height_px

    def staging_ratio(self, figure_height_ratio: float, facing: Facing) -> float:
        """The canvas share this facing is staged at: the action's ratio, scaled like the cell.

        Staging and pack scale the same way, so one cell fit
        (``figure_height_px / (figure_height_ratio x canvas height)``) serves every facing.
        """

        return figure_height_ratio * self.facing_scale(facing)


@dataclass(frozen=True, slots=True)
class ActionSpec:
    """One independently generated action with all effective values resolved."""

    name: str
    enabled: bool
    motion_file: Path
    motion: str
    store: ActionStoreSnapshot | None
    requested_seconds: EffectiveValue[float]
    base_frames: EffectiveValue[int]
    motion_class: EffectiveValue[str]
    closed: EffectiveValue[bool]
    loop_anchor: EffectiveValue[str]
    """``first`` (I2VA) or ``first-last`` (FL2VA: the staged picture is also the last frame)."""
    seed: EffectiveValue[int]
    frames: int
    resolved_prompts: Mapping[Facing, ComposedPrompt]
    """One composed prompt per facing the character provides (``FACINGS`` order)."""
    figure_height_ratio: EffectiveValue[float] = EffectiveValue(
        DEFAULT_FIGURE_HEIGHT_RATIO, "project"
    )
    baseline_ratio: EffectiveValue[float] = EffectiveValue(DEFAULT_BASELINE_RATIO, "project")
    cell_width: int | None = None
    """Per-action pack cell override; ``figure_height_px`` never varies per action."""
    cell_height: int | None = None
    frame_duration_ms: EffectiveValue[int] = EffectiveValue(100, "project")
    """Playback duration per packed frame; engines set fps per animation, so it is per action
    (``action`` override, else the ``[sheet]`` default)."""
    origin: ActionOrigin = "character"
    """``template``: declared by the template (the character may override any field);
    ``character``: the character's own action."""
    overrides: frozenset[str] = frozenset()
    """Keys the character set on a templated action (``motion``, ``enabled``, ``seed``, …)."""
    prompt_override: str | None = None
    """Verbatim prompt sent instead of the composed one (every facing); ``None`` = composed."""
    id: str = field(default="", kw_only=True)
    """Stable identity, a slug fixed at creation (derived from the name once, never renamed).
    Runs, overrides and slots refer to an action by this, not by ``name``."""

    def __post_init__(self) -> None:
        if not self.id:
            from .paths import action_id_from_name

            object.__setattr__(self, "id", action_id_from_name(self.name))

    @property
    def facings(self) -> tuple[Facing, ...]:
        """Facings this action has a prompt for, in canonical ``FACINGS`` order."""

        return tuple(facing for facing in ALL_FACINGS if facing in self.resolved_prompts)

    def prompt(self, facing: Facing) -> ComposedPrompt:
        try:
            return self.resolved_prompts[facing]
        except KeyError as error:
            raise KeyError(f"action {self.name!r} has no prompt for facing {facing!r}") from error

    @property
    def motion_sha256(self) -> str:
        """SHA-256 of the stripped motion text, the same canonical form the store hashes."""

        return sha256(self.motion.strip().encode("utf-8")).hexdigest()

    @property
    def motion_modified(self) -> bool | None:
        """Whether the current motion differs from its optional store snapshot."""

        if self.store is None:
            return None
        return self.motion_sha256 != self.store.motion_sha256

    @property
    def effective_seconds(self) -> float:
        return self.frames / 24


@dataclass(frozen=True, slots=True)
class SpriteProject:
    """A fully resolved, backend-neutral sprite project."""

    name: str
    project_file: Path
    sources: SourceSet
    character: CharacterSpec
    prompt_composer: PromptComposerSpec
    canvas: CanvasSpec
    video: VideoSpec
    processing: ProcessingSpec
    frames: FrameSelectionSpec
    sheet: SheetSpec
    actions: tuple[ActionSpec, ...]
    removed_actions: tuple[str, ...] = ()
    """Ids of the template actions this character dropped (``removed = true`` entries);
    they are not in ``actions`` and stay out until restored."""
    advisories: tuple[PromptValidationRow, ...] = ()
    """Project-level rows (legacy-key migrations) that are not tied to one action's prompt."""
    template: TemplateRef = TemplateRef(DEFAULT_TEMPLATE)
    provenance: Mapping[str, EffectiveSource] = field(default_factory=dict)
    """``"canvas.width" -> "template" | "project"`` for every key one of them set; keys
    absent here took the loader default."""

    @property
    def root(self) -> Path:
        return self.project_file.parent

    @property
    def kind(self) -> TemplateKind:
        return self.template.kind

    def action(self, name: str) -> ActionSpec:
        """Return an action by name, using the loader's case-insensitive rules."""

        wanted = name.casefold()
        for action in self.actions:
            if action.name.casefold() == wanted:
                return action
        raise KeyError(name)

    def action_by_id(self, action_id: str) -> ActionSpec | None:
        """Return an action by its stable id (case-insensitive), or ``None``."""

        wanted = action_id.casefold()
        for action in self.actions:
            if action.id.casefold() == wanted:
                return action
        return None

    @property
    def cells(self) -> tuple[CellKey, ...]:
        """Every enabled action seen from every facing the character provides."""

        return tuple(
            CellKey(action.name, facing)
            for action in self.actions
            if action.enabled
            for facing in self.sources.facings
        )


@dataclass(frozen=True, slots=True)
class I2VRequest:
    """Backend-neutral first-frame image-to-video request."""

    action_name: str
    facing: Facing
    prompt: str
    first_frame: Path
    width: int
    height: int
    frames: int
    fps: int
    seed: int
    cfg_scale: float
    output_path: Path
    sampler_name: str | None = None
    scheduler: str | None = None
    steps: int | None = None
    last_frame: Path | None = None
    """FL2VA: the picture the clip must end on (the staged first frame for a closed loop)."""


@dataclass(frozen=True, slots=True)
class GenerationResult:
    """Normalized record of one completed backend generation."""

    backend: str
    action_name: str
    raw_video: Path
    seed: int
    width: int
    height: int
    frames: int
    fps: int
    elapsed_seconds: float
    backend_version: str | None
    request_artifact: Path
    log_path: Path
    raw_frames: tuple[Path, ...] | None = None
    """Lossless decoded frames saved before video encoding, when the workflow provides them."""


@dataclass(frozen=True, slots=True)
class ProcessedActionResult:
    """Paths produced by backend-independent action processing (full resolution, no sheet)."""

    action_name: str
    rgba_dir: Path
    """Keyed frames at the generated size; the only pixel source pack ever reads."""
    normalized_dir: Path
    """Snapped frames at the generated size, written for review display only."""
    metadata_path: Path
    """``processing.json`` with the snap, per-frame boxes, and the clip verdict."""
    frame_count: int
    verdict: str
