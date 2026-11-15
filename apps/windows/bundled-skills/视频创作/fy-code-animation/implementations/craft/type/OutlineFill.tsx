// Adapted from renoise-ai/renoise-skills; see LICENSES/renoise-MIT.txt and implementations/craft/README.md.
import React, { useId } from "react";
import { useCurrentFrame } from "remotion";
import { E, clamp01 } from "../motion";

export type Part = { t: string; fill?: boolean };
/**
 * Text written as an outline (a left-to-right reveal), then chosen parts fill in solid.
 * "From answers" stays a line, "to outcomes." fills: the typographic form of an idea becoming real.
 */
export const OutlineFill: React.FC<{
  parts: Part[];
  family: string;
  size: number;
  weight?: number;
  x?: number;
  y?: number; // baseline
  width?: number; // reveal width
  anchor?: "start" | "middle";
  writeAt?: number;
  writeDur?: number;
  fillAt?: number;
  fillDur?: number;
  color?: string;
  stroke?: number;
}> = ({ parts, family, size, weight = 500, x = 960, y = 560, width = 1200, anchor = "middle", writeAt = 0, writeDur = 60, fillAt = 70, fillDur = 20, color = "#151513", stroke = 1.3 }) => {
  const f = useCurrentFrame();
  const uid=useId().replace(/[^a-zA-Z0-9_-]/g, "");
  if (writeDur<=0 || fillDur<=0) throw new Error("positive duration required");
  const w = E.inOut(clamp01((f - writeAt) / writeDur));
  const fill = E.out(clamp01((f - fillAt) / fillDur));
  const x0 = anchor === "middle" ? x - width / 2 : x;
  const id = `of-${uid}`;
  return (
    <svg width={1920} height={1080} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
      <defs>
        <clipPath id={id}>
          <rect x={x0 - 20} y={y - size * 1.2} width={(width + 40) * w} height={size * 1.8} />
        </clipPath>
      </defs>
      <text x={x} y={y} textAnchor={anchor} clipPath={`url(#${id})`} style={{ fontFamily: family, fontWeight: weight, fontSize: size, fontSynthesis: "none" }}>
        {parts.map((p, i) => (
          <tspan key={i} style={{ fill: p.fill ? color : "none", fillOpacity: p.fill ? fill : 0, stroke: color, strokeWidth: stroke }}>
            {p.t}
          </tspan>
        ))}
      </text>
    </svg>
  );
};
