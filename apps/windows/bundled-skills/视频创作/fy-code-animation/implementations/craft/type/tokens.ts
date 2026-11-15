// Adapted from renoise-ai/renoise-skills; see LICENSES/renoise-MIT.txt and implementations/craft/README.md.
/* Typographic tokens for 1920×1080 video. See references/typography.md. */
export type Role = "display" | "title" | "body" | "caps" | "caption" | "mono";

/** Letter-spacing in em: big type tightens, small caps open up; CJK never goes negative. */
export const tracking = (sizePx: number, role: Role, cjk = false) => {
  if (cjk) return role === "caps" ? 0.08 : role === "display" ? 0.01 : 0.02;
  if (role === "caps") return sizePx < 20 ? 0.16 : 0.12;
  if (role === "mono") return 0;
  if (role === "body" || role === "caption") return sizePx < 24 ? 0.005 : 0;
  // display/title: -0.01em at 40 px → -0.035em at 160 px and above
  const k = Math.min(1, Math.max(0, (sizePx - 40) / 120));
  return -0.01 - 0.025 * k;
};

/** Line-height: tight for display, open for CJK. */
export const leading = (role: Role, cjk = false) => (cjk ? (role === "display" ? 1.25 : 1.6) : role === "display" ? 1.02 : role === "title" ? 1.12 : 1.45);

/** Optical size axis value for a px size (clamped to the font's range). */
export const opsz = (sizePx: number, range: [number, number] = [8, 144]) => Math.min(range[1], Math.max(range[0], sizePx * 0.75));

/** Minimum readable sizes at 1080p (phone viewing): body 28, caption 22, caps 16. */
export const MIN_SIZE = { body: 28, caption: 22, caps: 16 } as const;
