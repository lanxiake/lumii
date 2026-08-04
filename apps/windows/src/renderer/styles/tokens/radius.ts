/**
 * Border Radius Design Tokens
 * 圆角设计令牌
 *
 * 与现有变量映射:
 * --border-radius: 8px -> radius.lg
 */

export const radius = {
  none: '0px',
  sm: '2px',
  DEFAULT: '4px',
  md: '6px',
  lg: '8px', // --border-radius
  xl: '12px',
  '2xl': '16px',
  '3xl': '24px',
  full: '9999px',
} as const;

export type Radius = typeof radius;
export type RadiusKey = keyof typeof radius;

// Legacy radius mapping
export const legacyRadius = {
  DEFAULT: radius.lg, // 8px
} as const;
