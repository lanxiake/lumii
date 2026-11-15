import React, { useMemo } from "react";
import { getLength, getPointAtLength } from "@remotion/paths";
import { clamp01 } from "./theme";

/** Where the pen tip is when `p` (0..1) of the total length of `paths` has been drawn in order. */
export const penAt = (paths: string[], p: number) => {
  const lens = paths.map((d) => getLength(d));
  const total = lens.reduce((a, b) => a + b, 0);
  let left = clamp01(p) * total;
  for (let i = 0; i < paths.length; i++) {
    if (left <= lens[i] || i === paths.length - 1) return getPointAtLength(paths[i], Math.min(lens[i], left));
    left -= lens[i];
  }
  return { x: 0, y: 0 };
};

/**
 * Draws SVG paths in sequence like a pen (signature, monoline script, logo strokes) with a glowing nib.
 * `erase` (0..1) removes the stroke from its start, so the line can be pulled back into the nib.
 * Coordinates are in `viewBox` units; `transform` places the drawing on the 1920×1080 frame.
 */
export const StrokeDraw: React.FC<{
  paths: string[];
  p: number;
  erase?: number;
  color: string;
  width: number; // in viewBox units
  viewBox?: string;
  transform?: string;
  nib?: number; // 0..1 nib glow strength
  nibColor?: string;
  nibR?: number; // nib radius in viewBox units
  glow?: number; // px of soft glow around the stroke
  lineCap?: "round" | "butt";
}> = ({ paths, p, erase = 0, color, width, viewBox = "0 0 1920 1080", transform, nib = 1, nibColor = "#fff", nibR = 6, glow = 0, lineCap = "round" }) => {
  const lens = useMemo(() => paths.map((d) => getLength(d)), [paths]);
  const total = lens.reduce((a, b) => a + b, 0);
  const drawn = clamp01(p) * total;
  const gone = clamp01(erase) * total;
  let acc = 0;
  const head = penAt(paths, erase > 0 && p >= 1 ? erase : p);
  return (
    <svg viewBox={viewBox} width={1920} height={1080} style={{ position: "absolute", inset: 0, overflow: "visible", filter: glow ? `drop-shadow(0 0 ${glow}px ${color})` : undefined }}>
      <g transform={transform}>
        {paths.map((d, i) => {
          const L = lens[i];
          const a = Math.min(L, Math.max(0, gone - acc));
          const b = Math.min(L, Math.max(0, drawn - acc));
          acc += L;
          if (b - a <= 0.01) return null;
          return <path key={i} d={d} fill="none" stroke={color} strokeWidth={width} strokeLinecap={lineCap} strokeLinejoin="round" strokeDasharray={`0 ${a} ${b - a} ${L + 1}`} />;
        })}
        {nib > 0 && (p < 1 || (erase > 0 && erase < 1)) && (
          <g opacity={nib}>
            <circle cx={head.x} cy={head.y} r={nibR * 4} fill={nibColor} opacity={0.12} />
            <circle cx={head.x} cy={head.y} r={nibR * 2} fill={nibColor} opacity={0.25} />
            <circle cx={head.x} cy={head.y} r={nibR} fill={nibColor} />
          </g>
        )}
      </g>
    </svg>
  );
};

