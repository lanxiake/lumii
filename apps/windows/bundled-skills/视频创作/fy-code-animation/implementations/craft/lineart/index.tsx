// Adapted from renoise-ai/renoise-skills; see LICENSES/renoise-MIT.txt and implementations/craft/README.md.
import React, { useMemo } from "react";
import { getLength, getPointAtLength } from "@remotion/paths";

/*
 * Line-art kit (线条艺术 / one-line drawing).
 * - `Stroke`: draws a path up to progress `u` (0→1) with a dash trick; pass `nonScaling` when the path is scaled.
 * - `penAt`: the pen tip (x, y) at progress `u`, for a nib dot and for a camera that follows the line.
 * - `Oneline`: a list of segments that share end points, each with its own frame window, so a single continuous
 *   line can slow down on drawings and hurry along the baseline between them.
 * - `SketchDefs`: a "boil" filter (turbulence displacement, reseeded every `hold` frames) that makes clean vectors
 *   wobble like ink on paper; also used by the hand-drawn kit.
 */

const lenCache = new Map<string, number>();
export const pathLen = (d: string) => {
  let v = lenCache.get(d);
  if (v === undefined) {
    if (lenCache.size > 512) lenCache.clear();
    v = getLength(d);
    lenCache.set(d, v);
  }
  return v;
};

export const Stroke: React.FC<{ d: string; u: number; width?: number; color?: string; nonScaling?: boolean; transform?: string; opacity?: number; filter?: string }> = ({ d, u, width = 5, color = "#1D1A24", nonScaling, transform, opacity = 1, filter }) => {
  const L = useMemo(() => pathLen(d), [d]);
  if (u <= 0) return null;
  return (
    <path
      d={d}
      fill="none"
      stroke={color}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray={`${L} ${L + 1}`}
      strokeDashoffset={L * (1 - Math.min(1, u))}
      vectorEffect={nonScaling ? "non-scaling-stroke" : undefined}
      transform={transform}
      opacity={opacity}
      filter={filter}
    />
  );
};

export const penAt = (d: string, u: number) => getPointAtLength(d, pathLen(d) * Math.min(1, Math.max(0, u)));

export type Seg = { d: string; a: number; b: number };
const smooth = (v: number) => {
  const k = Math.min(1, Math.max(0, v));
  return k * k * (3 - 2 * k);
};
/** Progress of one segment at frame t (smoothstep inside [a, b]). */
export const segU = (s: Seg, t: number) => { if (s.b <= s.a) throw new Error("segment must have positive duration"); return smooth((t-s.a)/(s.b-s.a)); };

/** The pen position on a chain of segments at frame t (holds at the last drawn point). */
export const chainPen = (segs: Seg[], t: number) => {
  if (!segs.length) throw new Error("empty line chain");
  let cur = segs[0];
  for (const s of segs) if (t >= s.a) cur = s;
  return penAt(cur.d, segU(cur, t));
};

export const Oneline: React.FC<{ segs: Seg[]; t: number; width?: number; color?: string; filter?: string }> = ({ segs, t, width, color, filter }) => (
  <g filter={filter}>
    {segs.map((s, i) => (
      <Stroke key={i} d={s.d} u={segU(s, t)} width={width} color={color} />
    ))}
  </g>
);

/** `region` = [x, y, w, h] in user space; pass the frame size when the filtered group spans a wide world. */
export const SketchDefs: React.FC<{ id?: string; t: number; hold?: number; scale?: number; freq?: number; region?: [number, number, number, number] }> = ({ id = "sketch", t, hold = 2, scale = 2.2, freq = 0.035, region }) => {
  if (hold <= 0) throw new Error("hold must be positive");
  const seed = ((Math.floor(t / hold) % 24) + 24) % 24;
  const r = region ? { filterUnits: "userSpaceOnUse" as const, x: region[0], y: region[1], width: region[2], height: region[3] } : { x: "-5%", y: "-5%", width: "110%", height: "110%" };
  return (
    <svg width={0} height={0} style={{ position: "absolute" }}>
      <defs>
        <filter id={id} {...r}>
          <feTurbulence type="fractalNoise" baseFrequency={freq} numOctaves={2} seed={seed} result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale={scale} xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
    </svg>
  );
};

/** Warm paper with fibre grain. */
export const Paper: React.FC<{ color?: string; grain?: number }> = ({ color = "#F6F1E7", grain = 0.08 }) => (
  <>
    <div style={{ position: "absolute", inset: 0, background: color }} />
    <svg width="100%" height="100%" style={{ position: "absolute", inset: 0, opacity: grain, mixBlendMode: "multiply" }}>
      <filter id="paper-grain">
        <feTurbulence type="fractalNoise" baseFrequency={0.7} numOctaves={3} seed={7} />
        <feColorMatrix type="matrix" values="0 0 0 0 0.35  0 0 0 0 0.3  0 0 0 0 0.25  0 0 0 1.4 -0.3" />
      </filter>
      <rect width="100%" height="100%" filter="url(#paper-grain)" />
    </svg>
  </>
);
