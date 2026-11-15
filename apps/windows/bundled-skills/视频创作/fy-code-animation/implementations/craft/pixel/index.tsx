// Adapted from renoise-ai/renoise-skills; see LICENSES/renoise-MIT.txt and implementations/craft/README.md.
import React, { useLayoutEffect, useRef } from "react";

/*
 * Pixel-art kit (像素风): draw into a real low-resolution canvas (default 320×180) and scale it up with
 * nearest-neighbour, so every pixel is a crisp square. Includes a 5×7 bitmap font, string sprites, palette
 * cycling and a parallax helper. Draw callbacks are pure functions of the frame.
 */

export type PixelDraw = (g: CanvasRenderingContext2D, t: number) => void;

export const PixelStage: React.FC<{ t: number; draw: PixelDraw; w?: number; h?: number; outW?: number; outH?: number }> = ({ t, draw, w = 320, h = 180, outW = 1920, outH = 1080 }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  if (![w,h,outW,outH].every(v=>Number.isInteger(v)&&v>0) || outW/w!==outH/h || !Number.isInteger(outW/w)) throw new Error("pixel stage requires positive integer dimensions and equal integer scaling");
  useLayoutEffect(() => {
    const g = ref.current?.getContext("2d");
    if (!g) return;
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, w, h);
    draw(g, t);
  });
  return <canvas ref={ref} width={w} height={h} style={{ width: outW, height: outH, imageRendering: "pixelated", display: "block" }} />;
};

/** Fill one pixel-perfect rectangle (integer coords). */
export const px = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string) => {
  g.fillStyle = c;
  g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
};

/** Draw a sprite from rows of characters; each char maps to a colour in `pal` ("." = transparent). */
export const sprite = (g: CanvasRenderingContext2D, rows: string[], x: number, y: number, pal: Record<string, string>, flip = false, scale = 1) => {
  if (!rows.length || rows.some(r=>r.length!==rows[0].length) || !Number.isInteger(scale) || scale<1) throw new Error("invalid sprite rows/scale");
  const X = Math.round(x);
  const Y = Math.round(y);
  const w = rows[0].length;
  rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) {
      const c = row[i];
      if (c === "." || !pal[c]) continue;
      g.fillStyle = pal[c];
      g.fillRect(X + (flip ? w - 1 - i : i) * scale, Y + j * scale, scale, scale);
    }
  });
};

/* 5×7 bitmap font (uppercase, digits, a few symbols). Each glyph = 7 rows of 5 bits. */
const F: Record<string, number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14], D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17], S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  "0": [14, 17, 19, 21, 25, 17, 14], "1": [4, 12, 4, 4, 4, 4, 14], "2": [14, 17, 1, 2, 4, 8, 31], "3": [31, 2, 4, 2, 1, 17, 14],
  "4": [2, 6, 10, 18, 31, 2, 2], "5": [31, 16, 30, 1, 1, 17, 14], "6": [6, 8, 16, 30, 17, 17, 14], "7": [31, 1, 2, 4, 8, 8, 8],
  "8": [14, 17, 17, 14, 17, 17, 14], "9": [14, 17, 17, 15, 1, 2, 12],
  "/": [1, 1, 2, 4, 8, 16, 16], "-": [0, 0, 0, 31, 0, 0, 0], ":": [0, 12, 12, 0, 12, 12, 0], ".": [0, 0, 0, 0, 0, 12, 12], "!": [4, 4, 4, 4, 4, 0, 4],
  "×": [0, 17, 10, 4, 10, 17, 0], "?": [14, 17, 1, 2, 4, 0, 4], " ": [0, 0, 0, 0, 0, 0, 0],
};

/** Bitmap text; `scale` multiplies the 5×7 cell, `shadow` draws a 1-px drop shadow. */
export const pixText = (g: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, scale = 1, shadow?: string, align: "left" | "center" = "left") => {
  if (!Number.isInteger(scale)||scale<1) throw new Error("pixel scale must be positive integer");
  const chars=Array.from(text.toUpperCase());
  for (const ch of chars) if (!(ch in F)) throw new Error(`Missing bitmap glyph: ${ch}; supply a real CJK glyph atlas`);
  const adv = 6 * scale;
  const wTot = Math.max(0, chars.length * adv - scale);
  const x0 = Math.round(align === "center" ? x - wTot / 2 : x);
  const drawAt = (ox: number, oy: number, c: string) => {
    g.fillStyle = c;
    chars.forEach((ch, k) => {
      const rows = F[ch] ?? F["?"];
      rows.forEach((bits, j) => {
        for (let i = 0; i < 5; i++) if (bits & (1 << (4 - i))) g.fillRect(x0 + k * adv + i * scale + ox, Math.round(y) + j * scale + oy, scale, scale);
      });
    });
  };
  if (shadow) drawAt(scale, scale, shadow);
  drawAt(0, 0, color);
};

/** Palette cycling: returns the colour at slot `i` after rotating `cols` by time. */
export const cycle = (cols: string[], i: number, t: number, speed = 0.15) => { if (!cols.length) throw new Error("empty palette"); return cols[(((i + Math.floor(t * speed)) % cols.length) + cols.length) % cols.length]; };

/** Deterministic 1D value noise for skylines / mountains. */
export const ridge = (x: number, seed: number) => {
  const h = (n: number) => {
    const s = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return h(i) * (1 - u) + h(i + 1) * u;
};
