// Adapted from renoise-ai/renoise-skills; see LICENSES/renoise-MIT.txt and implementations/craft/README.md.
import React, { useMemo } from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { clamp01 } from "../motion";

/**
 * A handwriting font (Caveat, Klee One, 霞鹜文楷 …) written out left to right like a pen: a soft-edged mask
 * advances glyph by glyph, pausing a little at spaces and punctuation. Measure after fonts load (useFontManifest).
 */
export const HandReveal: React.FC<{ text: string; family: string; size: number; weight?: number; at?: number; cps?: number; color?: string; style?: React.CSSProperties }> = ({ text, family, size, weight = 500, at = 0, cps = 14, color = "#151513", style }) => {
  const f = useCurrentFrame();
  const {fps}=useVideoConfig();
  if (cps<=0) throw new Error("cps must be positive");
  const { edges, times } = useMemo(() => {
    const g = document.createElement("canvas").getContext("2d")!;
    g.font = `${weight} ${size}px ${family}`;
    const chars = Array.from(text);
    const e: number[] = [];
    const tt: number[] = [];
    let t = 0;
    chars.forEach((ch, i) => {
      e.push(g.measureText(chars.slice(0, i + 1).join("")).width);
      t += fps / cps + (ch === " " ? fps*.1 : /[,.;:!?，。、！？]/.test(ch) ? fps*.2 : 0);
      tt.push(t);
    });
    return { edges: e, times: tt };
  }, [text, family, size, weight, cps, fps]);
  const total = edges[edges.length - 1] || 1;
  const lt = f - at;
  let x = 0;
  for (let i = 0; i < times.length; i++) {
    const t0 = i ? times[i - 1] : 0;
    if (lt >= times[i]) x = edges[i];
    else {
      x = (i ? edges[i - 1] : 0) + (edges[i] - (i ? edges[i - 1] : 0)) * clamp01((lt - t0) / (times[i] - t0));
      break;
    }
  }
  const p = (x / total) * 100;
  const mask = `linear-gradient(90deg, #000 ${Math.max(0, p - 2)}%, transparent ${p + 0.5}%)`;
  return <div style={{ fontFamily: family, fontSize: size, fontWeight: weight, color, whiteSpace: "pre", WebkitMaskImage: mask, maskImage: mask, fontSynthesis: "none", ...style }}>{text}</div>;
};
