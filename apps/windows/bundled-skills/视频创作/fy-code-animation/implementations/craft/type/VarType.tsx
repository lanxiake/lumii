// Adapted from renoise-ai/renoise-skills; see LICENSES/renoise-MIT.txt and implementations/craft/README.md.
import React from "react";
import { useCurrentFrame } from "remotion";
import { E, clamp01, mix } from "../motion";

type Axes = Record<string, [number, number]>;
/**
 * Variable-font text animated per character: every axis goes from its start to its end value as the letter arrives
 * (e.g. Fraunces SOFT 0→100, Anybody wdth 50→125, wght 200→700). Letters rise and un-blur in a stagger.
 */
export const VarType: React.FC<{
  text: string;
  family: string;
  size: number;
  axes?: Axes; // custom axes, e.g. { SOFT: [0, 100], WONK: [0, 1], wdth: [60, 110] }
  weight?: [number, number];
  at?: number; // start frame
  stagger?: number; // frames between letters
  dur?: number; // frames per letter
  rise?: number; // em
  blur?: number; // px
  tracking?: number; // em
  color?: string;
  ease?: (x: number) => number;
  style?: React.CSSProperties;
}> = ({ text, family, size, axes = {}, weight = [400, 400], at = 0, stagger = 1.2, dur = 18, rise = 0.5, blur = 6, tracking = 0, color = "currentColor", ease = E.out, style }) => {
  const f = useCurrentFrame();
  if (dur<=0 || stagger<0) throw new Error("invalid type timing");
  return (
    <div style={{ fontFamily: family, fontSize: size, color, letterSpacing: `${tracking}em`, lineHeight: 1.05, whiteSpace: "pre", fontSynthesis: "none", ...style }}>
      {Array.from(text).map((ch, i) => {
        const p = ease(clamp01((f - at - i * stagger) / dur));
        const v = Object.entries(axes)
          .map(([k, [a, b]]) => `'${k}' ${mix(a, b, p).toFixed(2)}`)
          .join(", ");
        return (
          <span key={i} style={{ display: "inline-block", fontWeight: mix(weight[0], weight[1], p), fontVariationSettings: v || undefined, opacity: clamp01(p * 1.4), transform: `translateY(${(1 - p) * rise}em)`, filter: p < 1 && blur > 0 ? `blur(${(1 - p) * blur}px)` : undefined }}>
            {ch}
          </span>
        );
      })}
    </div>
  );
};
