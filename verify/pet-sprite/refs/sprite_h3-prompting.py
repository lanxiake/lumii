"""Backend-owned prompt composition for MiniMax H3 sprite generation (composer v4).

Structure follows the H3 guide: first-frame anchor (or first+last for FL2VA) → one staging
sentence → identity once → facing → action onset and continuous development → motion-class
lock → loop closure → short tail.  Every sentence that states a *visible fact*
about the staged picture (figure size, position, facing, motion class, loop closure) is derived
from project settings and tagged ``derived`` so the preview can shade it; the user's own prose is
never retyped into those facts.
"""

from __future__ import annotations

import re
from hashlib import sha256

from .errors import ValidationError
from .models import (
    CanvasSpec,
    CharacterSpec,
    ComposedPrompt,
    PromptSegment,
    PromptValidationRow,
    default_closed,
)

SPRITE_I2VA_COMPOSER = "sprite-i2va"
COMPOSER_VERSION = 4
LOOP_ANCHORS = ("first", "first-last")
"""``first`` = I2VA (first frame referenced); ``first-last`` = FL2VA, the staged picture is
also the last frame so a closed clip lands exactly where it started."""

_FIRST_FRAME = (
    "For the target video, at 0.00 seconds into the target video, <Picture 1> "
    "(from [Shot 1]) is fully referenced."
)
_FIRST_LAST_FRAME = (
    "How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns "
    "with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the "
    "{effective_seconds:.2f}-second mark of the target video."
)
# Guide form: style label first, then the subject. One sentence carries the staged facts
# (size, position, background); nothing below restates them.
_OPENING = (
    "[Shot 1] 2D-animated, {style}; the character shown in <Picture 1> begins in the exact "
    "starting pose, at exactly the same size and framing as in <Picture 1>: the figure fills about "
    "{ratio_words} of the frame height, {position}, centered horizontally on a flat "
    "{background} background."
)
_POSITION_STANDING = (
    "standing in the middle of the frame with clear empty space above the head and below the feet"
)
_POSITION_LOW = "standing in the lower half of the frame with plenty of empty space above the head"
_IDENTITY = "Preserve the exact visual identity without redesign: {identity}."
# The facing follows the identity block and is anchored to the reference: identity prose is
# view-neutral by convention, and the picture, not the words, decides the orientation. The
# explicit "does not turn" closes the model's easiest way out of a leftover contradiction.
# Side facings say "picture-left/right" rather than "profile": a three-quarter or top-down
# game camera is not a profile view, and the picture already shows the exact angle.
_FACING = {
    "down": (
        "The character keeps exactly the orientation shown in <Picture 1> for the whole shot: "
        "facing the camera, face fully visible; the character does not turn."
    ),
    "up": (
        "The character keeps exactly the orientation shown in <Picture 1> for the whole shot: "
        "seen from behind with the back to the camera, the face never visible; the character "
        "does not turn around."
    ),
    "left": (
        "The character keeps exactly the orientation shown in <Picture 1> for the whole shot: "
        "facing picture-left; the character does not turn toward or away from the camera."
    ),
    "right": (
        "The character keeps exactly the orientation shown in <Picture 1> for the whole shot: "
        "facing picture-right; the character does not turn toward or away from the camera."
    ),
    # A prop has no facing: the picture is the whole orientation, no sentence is derived.
    "_": "",
}
_ONSET = "The camera holds a static shot. {motion}"
_STATIC = (
    "The feet stay planted at exactly the same spot for the whole shot; the character does "
    "not step, turn, or leave the ground."
)
_LOCOMOTION = (
    "The character moves in place: the legs and arms cycle, but the figure stays at the same "
    "spot in the frame, the head stays at the same height, and the figure keeps the same size "
    "— never closer to or further from the camera, never drifting sideways."
)
_DISPLACEMENT = (
    "The whole figure may rise, drop, or crouch within the frame, but it keeps the same size and "
    "the same drawn proportions throughout and never leaves the frame."
)
_CLOSED_CYCLING = (
    "The character completes identical cycles without pausing; the shot ends in exactly the "
    "same pose it started in so the clip can loop."
)
_CLOSED = "The shot ends in exactly the same pose it started in so the clip can loop."
_CLOSED_CYCLING_LAST = (
    "The character completes identical cycles without pausing and settles into exactly the "
    "pose, size, and composition of Picture 2 at the end of the shot so the clip can loop."
)
_CLOSED_LAST = (
    "The shot ends as the character settles into exactly the pose, size, and composition of "
    "Picture 2 so the clip can loop."
)
_OPEN = "The shot ends on the final pose of the action and holds it."
_TAIL = (
    "The background stays a single flat {background} colour edge to edge, with no floor, "
    "shadow, scenery, text, or props. The full body stays visible in one continuous shot with "
    "no cuts, transitions, zooms, or camera movement. The complete video is silent throughout, "
    "with no dialogue, vocalization, ambience, sound effects, or music."
)
_SOUND = "overall_soundscape: N/A"
_MUSIC = "non_diegetic_music: N/A"

_TEMPLATE_SOURCE = "\n".join(
    (
        f"sprite-i2va composer v{COMPOSER_VERSION}",
        _FIRST_FRAME,
        _FIRST_LAST_FRAME,
        _OPENING,
        _POSITION_STANDING,
        _POSITION_LOW,
        *(_FACING[key] for key in ("down", "up", "left", "right")),
        _IDENTITY,
        _ONSET,
        _STATIC,
        _LOCOMOTION,
        _DISPLACEMENT,
        _CLOSED_CYCLING,
        _CLOSED,
        _CLOSED_CYCLING_LAST,
        _CLOSED_LAST,
        _OPEN,
        _TAIL,
        _SOUND,
        _MUSIC,
    )
)
COMPOSER_SHA256 = sha256(_TEMPLATE_SOURCE.encode("utf-8")).hexdigest()

# Saturated key-colour candidates and the neutrals. The prompt names the nearest one next to
# the hex, because a hex code alone is weak signal for the model; a pick far from every
# candidate stays "solid #RRGGBB".
_COLOR_NAMES: tuple[tuple[str, tuple[int, int, int]], ...] = (
    ("magenta", (255, 0, 255)),
    ("hot pink", (255, 0, 128)),
    ("red", (255, 0, 0)),
    ("orange", (255, 128, 0)),
    ("yellow", (255, 255, 0)),
    ("lime green", (128, 255, 0)),
    ("green", (0, 255, 0)),
    ("spring green", (0, 255, 128)),
    ("cyan", (0, 255, 255)),
    ("azure blue", (0, 128, 255)),
    ("blue", (0, 0, 255)),
    ("violet", (128, 0, 255)),
    ("white", (255, 255, 255)),
    ("black", (0, 0, 0)),
    ("grey", (128, 128, 128)),
)
_COLOR_NAME_MAX_DISTANCE = 96.0
_NEUTRAL_MAX_CHROMA = 48
_HEX_COLOR = re.compile(r"^#([0-9a-fA-F]{6})$")


def background_words(color: str) -> str:
    """``"magenta (#FF00FF)"`` for a hex near a named candidate, else ``"solid #RRGGBB"``."""

    match = _HEX_COLOR.match(color.strip())
    if match is None:
        return f"solid {color.strip()}"
    digits = match.group(1).upper()
    rgb = tuple(int(digits[index : index + 2], 16) for index in (0, 2, 4))
    neutral = max(rgb) - min(rgb) < _NEUTRAL_MAX_CHROMA
    name, distance = min(
        (
            (candidate, sum((a - b) ** 2 for a, b in zip(rgb, reference, strict=True)) ** 0.5)
            for candidate, reference in _COLOR_NAMES
            if (max(reference) - min(reference) < _NEUTRAL_MAX_CHROMA) == neutral
        ),
        key=lambda item: item[1],
    )
    if distance > _COLOR_NAME_MAX_DISTANCE:
        return f"solid #{digits}"
    return f"{name} (#{digits})"


_TIMING = re.compile(r"(?<![\w.])(\d+(?:\.\d+)?)\s*seconds?\b", re.IGNORECASE)
_TOWARD_CAMERA = re.compile(r"\btowards?\s+(?:the\s+)?(?:camera|viewer|screen)\b", re.IGNORECASE)
_VIEWPOINT_WORDING = re.compile(
    r"\b(?:fac(?:ing|es)\s+(?:the\s+)?(?:camera|viewer|screen|forward|front)"
    r"|(?:looking|looks|gazing|gazes)\s+(?:at|toward|towards|into)\s+(?:the\s+)?"
    r"(?:camera|viewer|screen)"
    r"|front[\s-]+(?:view|facing)|from\s+(?:the\s+)?front|from\s+behind"
    r"|seen\s+from\s+(?:a\s+|an\s+|the\s+)?(?:[\w-]+\s+){0,4}?(?:angle|above|behind|below)"
    r"|three-quarter\s+(?:view|angle)|(?:side|back|rear)\s+view)\b",
    re.IGNORECASE,
)
"""Identity prose that pins a viewpoint; it contradicts every facing but ``down``."""
_MOTION_VIEW_WORDING = re.compile(
    r"\b(?:face|faces|facial|eyes?|eyebrows?|blinks?|blinking|winks?|mouth|smiles?|grins?"
    r"|picture-(?:left|right)|(?:left|right)\s+(?:hand|arm|leg|foot|shoulder))\b",
    re.IGNORECASE,
)
"""Motion prose that only reads for the ``down`` facing (a face nobody sees from behind, a
picture-side hand that swaps on the mirrored side)."""
_CYCLE_WORDING = re.compile(
    r"\b(cycle|cycles|loop|loops|repeat|repeats|repeating|return|returns|returning|again|"
    r"starting pose|initial pose|initial posture|same pose|start pose)\b",
    re.IGNORECASE,
)
_STRUCTURAL_MARKERS = (
    "<picture",
    "[shot",
    "how the reference pictures align",
    "integrated_multimodal_description:",
    "overall_soundscape:",
    "non_diegetic_music:",
)
_RATIO_WORDS = {
    50: "half",
    60: "sixty percent",
    66: "two thirds",
    67: "two thirds",
    70: "seventy percent",
    75: "three quarters",
    80: "eighty percent",
    90: "ninety percent",
}


def ratio_words(ratio: float) -> str:
    """Spell a staging ratio the way the guide phrases it ("three quarters", "sixty percent")."""

    percent = round(ratio * 100)
    return _RATIO_WORDS.get(percent, f"{percent} percent")


def compose_prompt(
    *,
    composer: str,
    character: CharacterSpec,
    motion: str,
    requested_seconds: float,
    effective_seconds: float,
    canvas: CanvasSpec,
    motion_class: str = "static",
    facing: str = "down",
    closed: bool | None = None,
    loop_anchor: str = "first",
    figure_height_ratio: float | None = None,
    baseline_ratio: float | None = None,
    override: str | None = None,
) -> ComposedPrompt:
    """Compose and validate the exact I2VA (or FL2VA) prompt submitted to the backend.

    ``override`` replaces the composed text verbatim: the settings are still validated, but
    no sentence is derived from them and the motion prose is not checked.
    """

    if composer != SPRITE_I2VA_COMPOSER:
        raise ValidationError(f"unsupported prompt composer: {composer!r}")
    if motion_class not in ("static", "locomotion", "displacement"):
        raise ValidationError(f"unsupported motion class: {motion_class!r}")
    if facing not in _FACING:
        raise ValidationError(f"unsupported facing: {facing!r}")
    if loop_anchor not in LOOP_ANCHORS:
        raise ValidationError(f"unsupported loop anchor: {loop_anchor!r}")
    if closed is None:
        closed = default_closed(motion_class)
    if loop_anchor == "first-last" and not closed:
        raise ValidationError(
            "loop_anchor 'first-last' anchors the last frame to the starting picture and "
            "therefore requires a closed clip"
        )
    ratio = canvas.figure_height_ratio if figure_height_ratio is None else figure_height_ratio
    baseline = canvas.baseline_ratio if baseline_ratio is None else baseline_ratio
    if not 0 < ratio < 1 or not 0 < baseline <= 1:
        raise ValidationError("staging ratios must lie inside the canvas")
    if override is not None:
        if not override.strip():
            raise ValidationError("prompt_override must not be blank")
        return ComposedPrompt(
            text=override,
            composer=composer,
            composer_sha256=COMPOSER_SHA256,
            sha256=sha256(override.encode("utf-8")).hexdigest(),
            validation_rows=(
                PromptValidationRow(
                    level="info",
                    code="prompt_overridden",
                    message=(
                        "The action sends its own prompt text; nothing is derived from the "
                        "motion prose, character description or settings."
                    ),
                    target="prompt_override",
                ),
            ),
            segments=(PromptSegment("override", override),),
        )

    normalized_motion = _normalized_prose(motion, "action motion")
    lowered_motion = normalized_motion.casefold()
    marker = next((value for value in _STRUCTURAL_MARKERS if value in lowered_motion), None)
    if marker is not None:
        raise ValidationError(
            f"action motion must contain motion-only prose, not I2VA structure ({marker!r})"
        )
    style = _normalized_prose(character.style, "character.style")
    identity = _normalized_prose(character.identity, "character.identity")
    background = background_words(canvas.background)
    last_frame = loop_anchor == "first-last"

    # Headroom above the figure: with the standing preset the figure sits mid-frame; with the
    # displacement preset (≤ 65 %) it sits low so an apex has room.
    position = _POSITION_LOW if ratio <= 0.65 else _POSITION_STANDING
    opening_head, opening_tail = _OPENING.split("{style}", 1)
    body: list[PromptSegment] = [
        PromptSegment("structure", opening_head),
        PromptSegment("character", style),
        PromptSegment(
            "derived",
            opening_tail.format(
                ratio_words=ratio_words(ratio), position=position, background=background
            ),
        ),
        PromptSegment("character", " " + _IDENTITY.format(identity=identity)),
        *([PromptSegment("derived", " " + _FACING[facing])] if _FACING[facing] else []),
        PromptSegment("motion", " " + _ONSET.format(motion=_sentence(normalized_motion))),
    ]
    if motion_class == "static":
        body.append(PromptSegment("derived", " " + _STATIC))
    elif motion_class == "locomotion":
        body.append(PromptSegment("derived", " " + _LOCOMOTION))
    else:
        body.append(PromptSegment("derived", " " + _DISPLACEMENT))
    if closed and last_frame:
        closing = _CLOSED_CYCLING_LAST if motion_class == "locomotion" else _CLOSED_LAST
    elif closed:
        closing = _CLOSED_CYCLING if motion_class == "locomotion" else _CLOSED
    else:
        closing = _OPEN
    body.append(PromptSegment("derived", " " + closing))
    body.append(PromptSegment("structure", " " + _TAIL.format(background=background)))

    header = (
        _FIRST_LAST_FRAME.format(effective_seconds=effective_seconds)
        if last_frame
        else _FIRST_FRAME
    )
    segments: tuple[PromptSegment, ...] = (
        PromptSegment("structure", header + "\n\nintegrated_multimodal_description: "),
        *body,
        PromptSegment("structure", f"\n\n{_SOUND}\n\n{_MUSIC}\n"),
    )
    text = "".join(segment.text for segment in segments)

    rows: list[PromptValidationRow] = [
        PromptValidationRow(
            level="info",
            code="h3_duration_normalized",
            message=(
                f"{requested_seconds:g} seconds normalizes to "
                f"{effective_seconds:.3f} seconds on the H3 frame grid."
            ),
            target="requested_seconds",
        )
    ]
    timings = tuple(float(match.group(1)) for match in _TIMING.finditer(normalized_motion))
    if timings and max(timings) > effective_seconds:
        rows.append(
            PromptValidationRow(
                level="advisory",
                code="motion_timing_exceeds_duration",
                message=(
                    f"Motion timing reaches {max(timings):g} seconds, beyond the normalized "
                    f"{effective_seconds:.3f}-second shot."
                ),
                target="motion",
            )
        )
    if motion_class == "locomotion" and _TOWARD_CAMERA.search(normalized_motion):
        rows.append(
            PromptValidationRow(
                level="advisory",
                code="locomotion_moves_toward_camera",
                message=(
                    "Locomotion prose moves the character toward the camera; describe the "
                    "motion as happening in place so the figure keeps one size."
                ),
                target="motion",
            )
        )
    if facing not in ("down", "_") and (viewpoint := _VIEWPOINT_WORDING.search(identity)):
        rows.append(
            PromptValidationRow(
                level="advisory",
                code="identity_describes_viewpoint",
                message=(
                    f"character.identity describes a viewpoint ({viewpoint.group(0)!r}); it "
                    f"contradicts the {facing} facing and can make the model turn the "
                    "character. Describe only what is true from every side and let the "
                    "source image carry the view."
                ),
                target="character.identity",
            )
        )
    view_word = None if facing in ("down", "_") else _MOTION_VIEW_WORDING.search(normalized_motion)
    if view_word:
        rows.append(
            PromptValidationRow(
                level="advisory",
                code="motion_describes_viewpoint",
                message=(
                    f"The motion mentions {view_word.group(0)!r}, which only reads for the "
                    f"down facing; from the {facing} facing it is hidden or mirrored. Write "
                    "the motion so it is true from every side ('one hand', 'the head')."
                ),
                target="motion",
            )
        )
    if closed and not _CYCLE_WORDING.search(normalized_motion):
        rows.append(
            PromptValidationRow(
                level="info",
                code="closed_without_cycle_wording",
                message=(
                    "The clip is marked closed but the motion prose never mentions a cycle "
                    "or a return to the starting pose; the composer adds the closing sentence."
                ),
                target="motion",
            )
        )
    return ComposedPrompt(
        text=text,
        composer=composer,
        composer_sha256=COMPOSER_SHA256,
        sha256=sha256(text.encode("utf-8")).hexdigest(),
        validation_rows=tuple(rows),
        segments=segments,
    )


def _normalized_prose(value: str, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValidationError(f"{label} must be non-empty UTF-8 prose")
    if "\x00" in value:
        raise ValidationError(f"{label} contains a null byte")
    return " ".join(value.split())


def _sentence(value: str) -> str:
    return value if value.endswith((".", "!", "?")) else f"{value}."


__all__ = [
    "COMPOSER_SHA256",
    "COMPOSER_VERSION",
    "LOOP_ANCHORS",
    "SPRITE_I2VA_COMPOSER",
    "background_words",
    "compose_prompt",
]
