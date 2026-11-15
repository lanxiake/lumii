/**
 * Specimen kit (style-pack-03): shared theme and deterministic helpers.
 * Every drawer works in a 1920×1080 "base" space and is a pure function of the frame `t`.
 */

export type Swatch = { name: string; hex: string };

export type SpecimenTheme = {
  ink: string; // dark chapters
  paper: string; // light chapters
  paper2: string; // warm paper for 3D floors
  cream: string; // text / dots on ink
  accent: string; // one hero colour
  accent2: string; // warm counterpoint
  palette: Swatch[]; // brand palette shown as a specimen
  sprinkle: string[]; // supporting colours for particles / strings
  serif: string;
  sans: string;
  mono: string;
};

export const BASE_W = 1920;
export const BASE_H = 1080;

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (t: number) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
export const easeOut = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);
export const easeInOut = (t: number) => {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
export const easeBack = (t: number, s = 1.6) => {
  const x = clamp01(t) - 1;
  return 1 + (s + 1) * x * x * x + s * x * x;
};
/** Progress of a window [a, a + d] in frames, eased. */
export const win = (t: number, a: number, d: number, e: (x: number) => number = easeInOut) => e(clamp01((t - a) / d));

export const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
};
export const rand = (i: number, salt = 0) => hash(i * 12.9898 + salt * 78.233 + salt * salt * 0.137);

/** Smooth 1D value noise in [-1, 1]. */
export const noise1 = (x: number, seed = 0) => {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return mix(rand(i, seed), rand(i + 1, seed), u) * 2 - 1;
};

/** Smooth 2D value noise in [-1, 1]. */
export const noise2 = (x: number, y: number, seed = 0) => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const h = (a: number, b: number) => rand(a * 57 + b * 131, seed);
  return mix(mix(h(xi, yi), h(xi + 1, yi), u), mix(h(xi, yi + 1), h(xi + 1, yi + 1), u), v) * 2 - 1;
};

const hexRgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
export const rgba = (hex: string, a = 1) => {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
};
export const mixHex = (a: string, b: string, t: number, alpha = 1) => {
  const x = hexRgb(a);
  const y = hexRgb(b);
  const k = clamp01(t);
  return `rgba(${Math.round(mix(x[0], y[0], k))},${Math.round(mix(x[1], y[1], k))},${Math.round(mix(x[2], y[2], k))},${alpha})`;
};
/** Relative luminance 0..1, used to pick ink or cream labels on a swatch. */
export const luma = (hex: string) => {
  const [r, g, b] = hexRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

/** SMPTE-ish timecode shown in the HUD: MM:SS:FF. */
export const timecode = (f: number, fps: number) => {
  const s = Math.floor(f / fps);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}:${String(Math.floor(f % fps)).padStart(2, "0")}`;
};
